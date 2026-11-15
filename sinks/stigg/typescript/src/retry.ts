/** The bounded, full-jitter retry policy applied inside `deliver()`, and the delay hint a response may send. */
import { ConfigurationError } from '@openaudr/audr';

/** The largest delay `setTimeout` honours; anything longer fires immediately. */
export const MAX_DELAY_MS = 2_147_483_647;

export interface RetryOptions {
  /** Attempts per request, the first included. Default 3. */
  readonly maxAttempts?: number | undefined;
  /** Ceiling of the first backoff, in milliseconds. Default 500. */
  readonly initialBackoffMs?: number | undefined;
  /** Cap on any single backoff, a server hint included, in milliseconds. Default 30000. */
  readonly maxBackoffMs?: number | undefined;
  /** Growth of the backoff ceiling per attempt. Default 2. */
  readonly multiplier?: number | undefined;
}

const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const DELAY_SECONDS = /^\d+$/;

export class RetryPolicy {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly multiplier: number;

  constructor(options: RetryOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.multiplier = options.multiplier ?? 2;
    if (!Number.isInteger(this.maxAttempts)) {
      throw new ConfigurationError('maxAttempts must be an integer');
    }
    if (this.maxAttempts < 1) throw new ConfigurationError('maxAttempts must be at least 1');
    finite(this.initialBackoffMs, 'initialBackoffMs', 0);
    finite(this.maxBackoffMs, 'maxBackoffMs', 0);
    finite(this.multiplier, 'multiplier', 1);
    if (this.maxBackoffMs > MAX_DELAY_MS) {
      throw new ConfigurationError(`maxBackoffMs must be at most ${MAX_DELAY_MS}`);
    }
  }

  /** A capped full-jitter delay, never shorter than `hintMs` and never longer than `maxBackoffMs`. */
  delayMs(attempt: number, hintMs?: number): number {
    const ceiling = Math.min(
      this.maxBackoffMs,
      this.initialBackoffMs * this.multiplier ** (attempt - 1),
    );
    const jittered = Math.random() * ceiling;
    return hintMs === undefined
      ? jittered
      : Math.min(this.maxBackoffMs, Math.max(jittered, hintMs));
  }
}

/**
 * Whether a status reports a condition that may pass on its own. `409` is retried as Stigg's
 * own SDKs retry it.
 */
export function isTransient(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * The wait the response asks for, in milliseconds, or `undefined` without a valid hint.
 * Stigg sends no `Retry-After` today, rate limiting included; it is honoured if one appears.
 */
export function retryHintMs(headers: Headers, now: number = Date.now()): number | undefined {
  return parseRetryAfterMs(headers.get('Retry-After'), now);
}

/** A `Retry-After` header (delay-seconds or an HTTP date) in milliseconds from `now`. */
export function parseRetryAfterMs(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (DELAY_SECONDS.test(trimmed)) return parseDelaySecondsMs(trimmed);
  if (!IMF_FIXDATE.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  // A date already past parses to zero, which the jittered floor then outweighs.
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function parseDelaySecondsMs(value: string | null): number | undefined {
  if (value === null || !DELAY_SECONDS.test(value.trim())) return undefined;
  return Number.parseInt(value, 10) * 1000;
}

function finite(value: unknown, name: string, minimum: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigurationError(`${name} must be a finite number`);
  }
  if (value < minimum) throw new ConfigurationError(`${name} must be at least ${minimum}`);
}
