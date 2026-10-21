/** The `Sink` for Lago's batch event endpoint. */
import {
  type AudrRecord,
  BatchResult,
  type DeliverOptions,
  type Logger,
  type Sink,
} from '@openaudr/audr';

import { type CredentialOptions, type MetricCode, resolveCredentials } from './credentials.js';
import { type LagoEvent } from './event.js';
import { preflight } from './preflight.js';
import { classifyStatus, exceedsBatchLimit, parseValidationErrors } from './response.js';
import { type RetryOptions, RetryPolicy, retryHintMs } from './retry.js';
import { Tally, type Stop } from './tally.js';
import { AbortedError, ClosedError, Transport, type TransportOptions } from './transport.js';
import { VERSION } from './version.js';

/** Lago's documented maximum number of events in one batch request. */
const MAX_EVENTS_PER_REQUEST = 100;
/** `422` responses acted on per request before the events still unsettled are given up. */
const MAX_SALVAGE_PASSES = 3;
const USER_AGENT = `audr-sink-lago/${VERSION}`;
const SILENT: Logger = { warn: () => undefined, error: () => undefined };
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const CLOSED: Stop = { kind: 'closed' };
const ABORTED: Stop = { kind: 'aborted' };
const UNCONFIRMED: Stop = { kind: 'unconfirmed' };

export interface LagoSinkOptions extends CredentialOptions, TransportOptions {
  readonly retry?: RetryOptions | undefined;
  /** Receives value-free diagnostics. Default: none, the sink logs nothing. */
  readonly logger?: Logger | undefined;
}

/** What one request, retries included, came to. */
type Exchange =
  { readonly kind: 'accepted' } | { readonly kind: 'invalid'; readonly body: unknown } | Stop;

/**
 * Deliver AUDR records to Lago's batch event endpoint.
 *
 * Each record becomes one event under its `attribution.feature_id`, or the metric code
 * `metricCode` names or chooses for it, routed on `attribution.subscription_id` and
 * de-duplicated on `record_id`. A record that
 * cannot become a valid event is rejected by name and never sent. Events are sent in order,
 * at most 100 to a request.
 *
 * Lago validates a request as a whole and answers `422` for the events it refused. The sink
 * settles those events, resends the others, and retries transient failures with the same
 * body, inside `deliver()` and bounded by `retry`. The outcome of every batch is reported,
 * never thrown. A Lago `200` confirms ingestion, not billing.
 */
export class LagoSink implements Sink {
  readonly #endpoint: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #metricCode: MetricCode;
  readonly #retry: RetryPolicy;
  readonly #transport: Transport;
  readonly #logger: Logger;

  constructor(options: LagoSinkOptions = {}) {
    const { endpoint, authorization, metricCode } = resolveCredentials(options);
    this.#endpoint = endpoint;
    this.#headers = Object.freeze({
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': USER_AGENT,
    });
    this.#metricCode = metricCode;
    this.#retry = new RetryPolicy(options.retry);
    this.#transport = new Transport(options);
    this.#logger = options.logger ? safe(options.logger) : SILENT;
  }

  async deliver(batch: readonly AudrRecord[], options: DeliverOptions = {}): Promise<BatchResult> {
    try {
      return await this.#deliver(batch, options.signal);
    } catch (error) {
      // Nothing was sent: only the closed check and the local encoding run outside the tally.
      this.#reportUnexpected(error);
      return BatchResult.failed({ retryable: false, detail: 'internal_error' });
    }
  }

  /** Abort any request in flight and refuse later deliveries. Idempotent; never throws. */
  close(): Promise<void> {
    return this.#transport.close();
  }

  toString(): string {
    return `LagoSink(endpoint=${this.#endpoint})`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }

  async #deliver(batch: readonly AudrRecord[], signal?: AbortSignal): Promise<BatchResult> {
    if (this.#transport.closed) return BatchResult.closed();

    const { events, rejected } = preflight(batch, this.#metricCode);
    const tally = new Tally(events, rejected);
    try {
      for (
        let start = 0;
        start < events.length && !tally.stopped;
        start += MAX_EVENTS_PER_REQUEST
      ) {
        const stop = await this.#deliverChunk(
          events.slice(start, start + MAX_EVENTS_PER_REQUEST),
          tally,
          signal,
        );
        if (stop !== undefined) {
          tally.halt(stop);
          this.#reportInterruption(stop);
        }
      }
    } catch (error) {
      // Requests may have settled already. The tally keeps their outcomes and reports the
      // records without one as unknown, which is safe to deliver again.
      this.#reportUnexpected(error);
      tally.halt(failed(false, 'internal_error'));
    }
    return tally.result();
  }

  /** Settle the events of one request, resending the survivors of each `422`. */
  async #deliverChunk(
    chunk: readonly LagoEvent[],
    tally: Tally,
    signal: AbortSignal | undefined,
  ): Promise<Stop | undefined> {
    let pending = chunk;
    for (let salvaged = 0; pending.length > 0; salvaged += 1) {
      const exchange = await this.#exchange(pending, signal);
      switch (exchange.kind) {
        case 'accepted':
          tally.confirm(pending);
          return undefined;
        case 'invalid': {
          if (exceedsBatchLimit(exchange.body)) {
            this.#logger.warn(
              `audr-sink-lago: Lago refused the request as too many events (events=${pending.length}); ` +
                'lower Client batchMaxSize to the LAGO_EVENTS_BATCH_MAX_LENGTH of the Lago instance',
            );
            tally.refuse(pending, 'too_many_events');
            return failed(false, 'too_many_events');
          }
          if (salvaged === MAX_SALVAGE_PASSES) {
            this.#logger.warn(
              `audr-sink-lago: Lago refused the request again after ${salvaged} resend(s); ` +
                `its remaining events are unknown (events=${pending.length})`,
            );
            return failed(false, 'http_422');
          }
          const verdict = parseValidationErrors(exchange.body, pending.length);
          if (verdict === undefined) {
            this.#logger.warn(
              `audr-sink-lago: the validation response could not be matched to the request ` +
                `(events=${pending.length}, passes=${salvaged})`,
            );
            tally.refuse(pending, 'http_422');
            return failed(false, 'http_422');
          }
          const duplicates = new Set(verdict.duplicates);
          const refusals = new Map(verdict.invalid.map(({ index, detail }) => [index, detail]));
          const survivors: LagoEvent[] = [];
          for (const [index, event] of pending.entries()) {
            const refusal = refusals.get(index);
            if (refusal !== undefined) tally.reject(event.transaction_id, refusal);
            else if (duplicates.has(index)) tally.confirm([event]);
            else survivors.push(event);
          }
          this.#logger.warn(
            `audr-sink-lago: Lago refused ${refusals.size} event(s) and already held ` +
              `${duplicates.size} (events=${pending.length}, pass=${salvaged + 1})`,
          );
          pending = survivors;
          break;
        }
        case 'failed':
          // A permanent failure is Lago's verdict on the request; a retryable one is no verdict.
          if (!exchange.retryable) tally.refuse(pending, exchange.detail);
          return exchange;
        case 'closed':
        case 'aborted':
        case 'unconfirmed':
          return exchange;
        default: {
          const unhandled: never = exchange;
          throw new Error(`unhandled exchange ${String(unhandled)}`);
        }
      }
    }
    return undefined;
  }

  /**
   * Send `events` as one request. The body is serialized once and resent unchanged after a
   * transient failure, so a retry carries the same event timestamps and cannot become a
   * second billable event.
   */
  async #exchange(
    events: readonly LagoEvent[],
    signal: AbortSignal | undefined,
  ): Promise<Exchange> {
    const body = JSON.stringify({ events });
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= this.#retry.maxAttempts;
      let response: Response;
      try {
        response = await this.#transport.post(this.#endpoint, body, this.#headers, signal);
      } catch (error) {
        if (error instanceof ClosedError) return CLOSED;
        if (error instanceof AbortedError) return ABORTED;
        // A transport error carries no verdict from the destination, so it is retried.
        if (last) return failed(true, nameOf(error));
        const interruption = await this.#backOff(attempt, undefined, signal);
        if (interruption !== undefined) return interruption;
        continue;
      }

      const { status } = response;
      const statusClass = classifyStatus(status);
      if (statusClass === 'invalid') {
        const parsed = await readJson(response);
        const interruption = parsed === undefined ? this.#interruption(signal) : undefined;
        return interruption ?? { kind: 'invalid', body: parsed };
      }
      await discard(response);
      switch (statusClass) {
        case 'accepted':
          return { kind: 'accepted' };
        case 'unconfirmed':
          this.#logger.warn(
            `audr-sink-lago: Lago answered without confirming the events; they are unknown (status=${status})`,
          );
          return UNCONFIRMED;
        case 'transient': {
          if (last) {
            this.#logger.warn(
              `audr-sink-lago: the request failed after ${attempt} attempt(s) (status=${status})`,
            );
            return failed(true, `http_${status}`);
          }
          const hint = retryHintMs(status, response.headers);
          const interruption = await this.#backOff(attempt, hint, signal);
          if (interruption !== undefined) return interruption;
          continue;
        }
        case 'credential':
          this.#logger.error(`audr-sink-lago: the API key was rejected (status=${status})`);
          return failed(false, 'auth');
        case 'forbidden':
          this.#logger.error(
            `audr-sink-lago: the API key is not permitted to ingest events (status=${status})`,
          );
          return failed(false, 'forbidden');
        case 'too_large':
          this.#logger.warn(
            `audr-sink-lago: Lago rejected the request as too large (events=${events.length}); ` +
              'lower Client batchMaxSize',
          );
          return failed(false, 'payload_too_large');
        case 'permanent':
          this.#logger.warn(
            `audr-sink-lago: the request was rejected permanently (status=${status})`,
          );
          return failed(false, `http_${status}`);
        default: {
          const unhandled: never = statusClass;
          throw new Error(`unhandled status class ${String(unhandled)}`);
        }
      }
    }
  }

  /** Wait before a retry. Returns why waiting ended early, when the sink or caller stopped it. */
  async #backOff(
    attempt: number,
    hintMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Stop | undefined> {
    await this.#transport.pause(this.#retry.delayMs(attempt, hintMs), signal);
    return this.#interruption(signal);
  }

  #interruption(signal: AbortSignal | undefined): Stop | undefined {
    if (this.#transport.closed) return CLOSED;
    return signal?.aborted ? ABORTED : undefined;
  }

  /** Log an error that no code path anticipated; only its class name is recorded. */
  #reportUnexpected(error: unknown): void {
    this.#logger.error(`audr-sink-lago: delivery failed unexpectedly (${nameOf(error)})`);
  }

  /** A failure logs where it is decided; a stop requested from outside logs here. */
  #reportInterruption(stop: Stop): void {
    if (stop.kind === 'closed') {
      this.#logger.warn('audr-sink-lago: the sink is closed; batch not delivered');
    } else if (stop.kind === 'aborted') {
      this.#logger.warn('audr-sink-lago: delivery was aborted by the caller');
    }
  }
}

function failed(retryable: boolean, detail: string): Stop {
  return { kind: 'failed', retryable, detail };
}

/** A network error's system code, such as `ECONNREFUSED`, else its class name. */
function nameOf(error: unknown): string {
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const candidates = [cause?.code, error instanceof Error ? error.name : undefined];
  // Only identifier-shaped names are reported, so a message can never ride along.
  const found = candidates.find((name) => typeof name === 'string' && SAFE_NAME.test(name));
  return typeof found === 'string' ? found : 'Error';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Release the connection behind a response whose body is not needed. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The verdict is already known; a body that cannot be cancelled changes nothing.
  }
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
