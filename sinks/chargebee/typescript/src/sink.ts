/** The `Sink` for Chargebee's usage-ingest batch endpoint. */
import {
  type AudrRecord,
  BatchResult,
  ConfigurationError,
  type Logger,
  type RejectedRecord,
  type Sink,
} from '@openaudr/audr';

import { BATCH_PATH, type CredentialOptions, resolveCredentials } from './credentials.js';
import { InvalidUsageEventError, type UsageEvent, validateEvent } from './event.js';
import { DEFAULT_SEPARATOR, flattenRecord } from './flatten.js';
import { RetryPolicy, type RetryOptions } from './retry.js';
import { ClosedError, Transport, type TransportOptions } from './transport.js';
import { VERSION } from './version.js';

// Chargebee property names match [a-zA-Z][a-zA-Z0-9_]*, so path segments may only be
// joined by underscores.
const SEPARATOR = /^_+$/;
const USER_AGENT = `audr-ingestion-typescript/${VERSION}`;
const ERROR_CODE_FIELDS = ['api_error_code', 'error_code', 'code'] as const;
const SILENT: Logger = { warn: () => undefined, error: () => undefined };

export interface ChargebeeSinkOptions extends CredentialOptions, TransportOptions {
  readonly retry?: RetryOptions | undefined;
  /** Joins flattened property names: one or more underscores. Default `__`. */
  readonly separator?: string | undefined;
  /** Receives value-free diagnostics. Default: none, the sink logs nothing. */
  readonly logger?: Logger | undefined;
}

/**
 * Deliver AUDR records to one validated Chargebee ingest origin, one request per batch.
 *
 * Chargebee routes on `attribution.subscription_id`: a record without one is rejected by
 * name and never sent. `record_id` becomes the `deduplication_id`, so replaying a record
 * reported `unknown` is idempotent. Transient failures are retried inside `deliver()`,
 * bounded by `retry`; the outcome of every batch is reported, never thrown.
 */
export class ChargebeeSink implements Sink {
  readonly #origin: string;
  readonly #url: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #separator: string;
  readonly #retry: RetryPolicy;
  readonly #transport: Transport;
  readonly #logger: Logger;

  constructor(options: ChargebeeSinkOptions = {}) {
    const separator = options.separator ?? DEFAULT_SEPARATOR;
    if (!SEPARATOR.test(separator)) {
      throw new ConfigurationError(
        'separator must consist of one or more underscores; Chargebee property names must ' +
          'start with a letter and contain only letters, digits, and underscores',
      );
    }
    const { origin, authorization } = resolveCredentials(options);
    this.#origin = origin;
    this.#url = `${origin}${BATCH_PATH}`;
    this.#headers = {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': USER_AGENT,
    };
    this.#separator = separator;
    this.#retry = new RetryPolicy(options.retry);
    this.#transport = new Transport(options);
    this.#logger = options.logger ? safe(options.logger) : SILENT;
  }

  async deliver(batch: readonly AudrRecord[]): Promise<BatchResult> {
    if (this.#transport.closed) return BatchResult.closed();

    const rejected: RejectedRecord[] = [];
    const events: UsageEvent[] = [];
    for (const record of batch) {
      const subscriptionId = record.attribution.subscription_id;
      if (!subscriptionId) {
        rejected.push({ recordId: record.record_id, detail: 'missing_subscription_id' });
        continue;
      }
      try {
        events.push(
          validateEvent({
            subscription_id: subscriptionId,
            usage_timestamp: Date.parse(record.timing.event_time),
            deduplication_id: record.record_id,
            properties: flattenRecord(record, { separator: this.#separator }),
          }),
        );
      } catch (error) {
        if (!(error instanceof InvalidUsageEventError)) throw error;
        rejected.push({ recordId: record.record_id, detail: error.message });
      }
    }
    if (events.length === 0) return BatchResult.accepted({ rejected });

    const result = await this.#send(events);
    if (result.outcome !== 'accepted') return result;
    return BatchResult.accepted({
      rejected: [...rejected, ...(result.rejected ?? [])],
      unknown: result.unknown,
    });
  }

  /** Abort any request in flight and refuse later deliveries. Idempotent; never throws. */
  close(): Promise<void> {
    return this.#transport.close();
  }

  toString(): string {
    return `ChargebeeSink(origin=${this.#origin})`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }

  async #send(events: readonly UsageEvent[]): Promise<BatchResult> {
    const body = JSON.stringify({ events });
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= this.#retry.maxAttempts;
      let response: Response;
      try {
        response = await this.#transport.post(this.#url, body, this.#headers);
      } catch (error) {
        if (error instanceof ClosedError) {
          this.#logger.warn('audr-sink-chargebee: the sink is closed; batch not delivered');
          return BatchResult.closed();
        }
        // A transport error carries no verdict from the destination, so it is retried.
        if (last) return BatchResult.failed({ retryable: true, detail: transportError(error) });
        await this.#transport.pause(this.#retry.delayMs(attempt));
        continue;
      }

      const { status } = response;
      if (status === 207) return this.#partial(events, response);
      await discard(response);
      if (status === 202) return BatchResult.accepted();
      if (status === 413) {
        this.#logger.warn(
          `audr-sink-chargebee: Chargebee rejected the batch as too large (batch_size=${events.length}); ` +
            'lower Client batchMaxSize',
        );
        return BatchResult.failed({ retryable: false, detail: 'payload_too_large' });
      }
      const failure = this.#retry.classify(status);
      switch (failure) {
        case 'transient':
          if (last) return BatchResult.failed({ retryable: true, detail: `http_${status}` });
          await this.#transport.pause(
            this.#retry.delayMs(attempt, response.headers.get('Retry-After')),
          );
          continue;
        case 'credential':
          this.#logger.error(
            `audr-sink-chargebee: the API key was rejected for ${this.#origin} (status ${status})`,
          );
          return BatchResult.failed({ retryable: false, detail: 'auth' });
        case 'permanent':
          this.#logger.warn(`audr-sink-chargebee: batch rejected permanently (status=${status})`);
          return BatchResult.failed({ retryable: false, detail: `http_${status}` });
        default: {
          const unhandled: never = failure;
          throw new Error(`unhandled failure class ${String(unhandled)}`);
        }
      }
    }
  }

  /**
   * Map a `207` to per-record outcomes. A failure that cannot be matched to exactly one
   * record in the batch leaves every record not rejected by name `unknown`.
   */
  async #partial(events: readonly UsageEvent[], response: Response): Promise<BatchResult> {
    const ids = events.map((event) => event.deduplication_id);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const failedEvents = isObject(payload) ? payload.failed_events : undefined;
    if (!Array.isArray(failedEvents)) {
      this.#logger.warn(
        'audr-sink-chargebee: partial response was unparseable; event outcomes are unknown ' +
          `(batch_size=${events.length})`,
      );
      return BatchResult.accepted({ unknown: ids });
    }

    const occurrences = new Map<string, number>();
    for (const id of ids) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    const rejected: RejectedRecord[] = [];
    const rejectedIds = new Set<string>();
    let unattributed = 0;
    for (const entry of failedEvents as unknown[]) {
      const id = isObject(entry) ? entry.deduplication_id : undefined;
      const count = typeof id === 'string' ? occurrences.get(id) : undefined;
      if (typeof id !== 'string' || count === undefined || rejectedIds.has(id)) {
        unattributed += 1;
        continue;
      }
      rejectedIds.add(id);
      const detail = errorCode(entry as Record<string, unknown>);
      for (let i = 0; i < count; i += 1) rejected.push({ recordId: id, detail });
    }
    if (unattributed === 0) return BatchResult.accepted({ rejected });

    this.#logger.warn(
      `audr-sink-chargebee: Chargebee batch had ${unattributed} unattributable failed_events ` +
        `rejection(s) (batch_size=${events.length})`,
    );
    return BatchResult.accepted({ rejected, unknown: ids.filter((id) => !rejectedIds.has(id)) });
  }
}

function errorCode(entry: Readonly<Record<string, unknown>>): string | undefined {
  for (const field of ERROR_CODE_FIELDS) {
    const value = entry[field];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }
  return undefined;
}

/** A network error's system code, such as `ECONNREFUSED`, else its class name. */
function transportError(error: unknown): string {
  const code = (
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined
  )?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : typeof error;
}

/** Release the connection behind a response whose body is not needed. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The verdict is already known; a body that cannot be cancelled changes nothing.
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A logger whose failures cannot escape `deliver()` or `close()`. */
function safe(logger: Logger): Logger {
  return {
    warn: (message) => {
      try {
        logger.warn(message);
      } catch {
        // Diagnostics are best-effort.
      }
    },
    error: (message) => {
      try {
        logger.error(message);
      } catch {
        // Diagnostics are best-effort.
      }
    },
  };
}
