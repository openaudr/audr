import { ConfigurationError, errorName, issue } from './errors.js';
import { MAX_TIMER_MS, Pipeline } from './pipeline.js';
import { type AudrRecord, type Emitter } from './record.js';
import {
  type DeliveredCallback,
  type DeliveryStats,
  type FailureCallback,
  type Logger,
  type SubmitResult,
} from './results.js';
import { type Sink } from './sink.js';
import { inspect } from './validate.js';

const MAX_BATCH_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ClientOptions {
  /** Stamped on every record that does not carry its own `emitter`. */
  readonly emitter?: Emitter | undefined;
  /** Close the sink on shutdown, including one you supplied. Default `true`. */
  readonly ownsSink?: boolean | undefined;
  /** Records queued or in flight before new ones are dropped. Default 1000. */
  readonly maxQueueSize?: number | undefined;
  /** Records per batch handed to the sink, at most 500. Default 50. */
  readonly batchMaxSize?: number | undefined;
  /** How long a partial batch waits for more records, at most 2147483647. Default 5000. */
  readonly lingerMs?: number | undefined;
  /** Called synchronously for every record that ends `dropped` or `unknown`. */
  readonly onFailure?: FailureCallback | undefined;
  /** Called synchronously once per accepted batch with the records the sink accepted. */
  readonly onDelivered?: DeliveredCallback | undefined;
  /**
   * The clock `timing.event_time` is checked against. Default `() => new Date()`, which is
   * also used when this one throws or returns an invalid `Date`.
   */
  readonly clock?: (() => Date) | undefined;
  /**
   * Where diagnostics go. Default `console`. Messages never carry record values, and an
   * error the logger throws is ignored.
   */
  readonly logger?: Logger | undefined;
}

/**
 * Record AUDR usage onto a bounded, batching background delivery pipeline.
 *
 * ```ts
 * await using client = new Client(sink, { emitter });
 * client.record(record);
 * ```
 *
 * The sink owns credentials, transport and retries; the client owns validation, batching
 * and accounting. `shutdown()` closes the sink unless `ownsSink` is `false`.
 */
export class Client implements AsyncDisposable {
  readonly #pipeline: Pipeline;
  readonly #emitter: Emitter | undefined;
  readonly #clock: (() => Date) | undefined;
  readonly #onFailure: FailureCallback | undefined;
  readonly #logger: Logger;
  #shutdown: Promise<void> | undefined;

  constructor(sink: Sink, options: ClientOptions = {}) {
    const {
      maxQueueSize = 1000,
      batchMaxSize = 50,
      lingerMs = 5000,
      ownsSink = true,
      logger = console,
    } = options;
    const candidate = sink as Partial<Sink> | null | undefined;
    if (typeof candidate?.deliver !== 'function' || typeof candidate.close !== 'function') {
      throw new ConfigurationError('sink must implement deliver() and close()');
    }
    if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1) {
      throw new ConfigurationError('maxQueueSize must be an integer >= 1');
    }
    if (!Number.isInteger(batchMaxSize) || batchMaxSize < 1 || batchMaxSize > MAX_BATCH_SIZE) {
      throw new ConfigurationError(`batchMaxSize must be an integer from 1 to ${MAX_BATCH_SIZE}`);
    }
    if (!Number.isFinite(lingerMs) || lingerMs < 0 || lingerMs > MAX_TIMER_MS) {
      throw new ConfigurationError(`lingerMs must be a number from 0 to ${MAX_TIMER_MS}`);
    }
    this.#emitter = options.emitter;
    this.#clock = options.clock;
    this.#onFailure = options.onFailure;
    this.#logger = safeLogger(logger);
    this.#pipeline = new Pipeline(sink, {
      maxQueueSize,
      batchMaxSize,
      lingerMs,
      ownsSink,
      logger: this.#logger,
      onFailure: options.onFailure,
      onDelivered: options.onDelivered,
    });
  }

  /** A snapshot of the delivery counters. */
  get stats(): DeliveryStats {
    return this.#pipeline.stats;
  }

  /**
   * Validate a copy of one record and queue it; returns at once and never throws.
   *
   * The client keeps its own copy, so changing `record` afterwards does not change what is
   * delivered. Problems are reported through the returned `SubmitResult`, `onFailure` and
   * `stats`. A value that is not structurally a record is rejected without calling
   * `onFailure`, because there is no record to hand it.
   */
  record(record: AudrRecord): SubmitResult {
    if (this.#shutdown !== undefined) {
      return { outcome: 'dropped_not_running', queued: false, issues: [] };
    }
    let copy: AudrRecord;
    try {
      copy = structuredClone(this.#stamp(record));
    } catch (error) {
      this.#logger.warn(`audr: record rejected, it is not plain data (${errorName(error)})`);
      return { outcome: 'rejected_invalid', queued: false, issues: [issue('INVALID_TYPE', '/')] };
    }
    const { issues, wellFormed } = inspect(copy, { now: this.#now() });
    if (issues.length === 0) {
      return this.#pipeline.submit(copy);
    }
    this.#logger.warn(`audr: record rejected, ${issues.length} validation issue(s)`);
    if (wellFormed) {
      this.#notifyInvalid(copy);
    }
    return { outcome: 'rejected_invalid', queued: false, issues };
  }

  /**
   * Deliver queued records now, waiting up to `timeoutMs` (default 30000).
   *
   * Resolves `true` once every queued record has reached a terminal state, `false` if the
   * bound expired first. Records still queued stay queued, and the client stays usable. A
   * bound above 2147483647, such as `Infinity`, waits without limit.
   */
  async flush(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
    checkTimeout(timeoutMs);
    return this.#pipeline.flush(timeoutMs);
  }

  /**
   * Stop accepting records, deliver what fits in `timeoutMs` (default 30000), then close
   * the sink. Records still queued at the bound are reported to `onFailure`. Idempotent.
   */
  async shutdown(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
    checkTimeout(timeoutMs);
    this.#shutdown ??= this.#pipeline.stop(timeoutMs);
    return this.#shutdown;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  #stamp(record: AudrRecord): AudrRecord {
    const bare = (record as Partial<AudrRecord> | null)?.emitter === undefined;
    return this.#emitter !== undefined && bare ? { ...record, emitter: this.#emitter } : record;
  }

  /** The configured clock's reading, or `undefined` to fall back to the system clock. */
  #now(): Date | undefined {
    if (this.#clock === undefined) return undefined;
    try {
      const now = this.#clock();
      if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
      this.#logger.warn('audr: clock returned an invalid Date, using the system clock');
    } catch (error) {
      this.#logger.warn(`audr: clock threw (${errorName(error)}), using the system clock`);
    }
    return undefined;
  }

  #notifyInvalid(record: AudrRecord): void {
    try {
      this.#onFailure?.({
        record,
        disposition: 'dropped',
        reason: 'invalid',
        retryable: false,
      });
    } catch (error) {
      this.#logger.warn(`audr: onFailure callback threw (${errorName(error)})`);
    }
  }
}

function checkTimeout(timeoutMs: unknown): void {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) || timeoutMs < 0) {
    throw new ConfigurationError('timeoutMs must be a number >= 0');
  }
}

/** `logger`, with every error it throws swallowed so that logging never breaks delivery. */
function safeLogger(logger: Logger): Logger {
  return {
    warn(message) {
      try {
        logger.warn(message);
      } catch {
        // Nowhere is left to report a logger that fails.
      }
    },
    error(message) {
      try {
        logger.error(message);
      } catch {
        // Nowhere is left to report a logger that fails.
      }
    },
  };
}
