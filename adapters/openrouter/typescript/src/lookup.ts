import type { RequestOptions } from '@openrouter/sdk/lib/sdks.js';
import type { GetGenerationRequest } from '@openrouter/sdk/models/operations';

import type { LookupFailureReason } from './diagnostics.js';
import { type Facts, isRecord, readFacts } from './mapping.js';

/** Bounds on the `generations.getGeneration` call that names the serving vendor. */
export interface LookupOptions {
  /**
   * The most time one lookup may take, retries and waits included. A lookup can delay the
   * native call's promise, or a stream's terminal frame, by this long. `0` disables the
   * lookup. Default `5000`.
   */
  readonly maxWaitMs?: number | undefined;
  /** The wait before the first retry; it doubles after each. Default `250`. */
  readonly initialDelayMs?: number | undefined;
  /** The longest single wait between attempts. Default `1000`. */
  readonly maxDelayMs?: number | undefined;
}

/** The part of a native client the lookup uses. An `OpenRouter` satisfies it. */
export interface GenerationsClient {
  readonly generations: {
    getGeneration(request: GetGenerationRequest, options?: RequestOptions): Promise<unknown>;
  };
}

export type LookupOutcome =
  | { readonly ok: true; readonly facts: Facts }
  | { readonly ok: false; readonly reason: LookupFailureReason };

const DEFAULT_MAX_WAIT_MS = 5_000;
const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 1_000;

/**
 * Turns off the SDK's own retries for every attempt. Its default for `getGeneration` backs off
 * for up to an hour and retries the timeout that ends the budget, which would hold the native
 * call long past `maxWaitMs`; a host `retryConfig` could do the same.
 */
const SDK_RETRIES = { strategy: 'none' } as const;

/** The `id` parameter of `getGeneration`: OpenRouter accepts only `gen-` identifiers of up to 128 characters. */
const GENERATION_ID = /^gen-[0-9A-Za-z-]{1,124}$/;

/** HTTP statuses worth retrying: OpenRouter's statistics lag (404), timeouts, limits, outages. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([404, 408, 429]);

/** Failures with no HTTP status that retrying cannot fix: a malformed request or response. */
const PERMANENT_ERRORS: ReadonlySet<string> = new Set([
  'InvalidRequestError',
  'SDKValidationError',
]);

/** Whether `id` can be looked up. A Responses or Embeddings result may carry another kind of id. */
export function isGenerationId(id: string): boolean {
  return GENERATION_ID.test(id);
}

const DISABLED: LookupOutcome = { ok: false, reason: 'disabled' };
const EXHAUSTED: LookupOutcome = { ok: false, reason: 'exhausted' };
const REJECTED: LookupOutcome = { ok: false, reason: 'rejected' };

/**
 * Asks OpenRouter which vendor served a generation, through the host's own client. It
 * retries a response that is not there yet or a service that is busy, within a fixed
 * budget, and stops at once on a failure that waiting cannot fix.
 */
export class GenerationLookup {
  readonly #native: GenerationsClient;
  readonly #maxWaitMs: number;
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;

  constructor(native: GenerationsClient, options: LookupOptions | undefined) {
    this.#native = native;
    this.#maxWaitMs = bound(options?.maxWaitMs, DEFAULT_MAX_WAIT_MS);
    this.#initialDelayMs = bound(options?.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
    this.#maxDelayMs = bound(options?.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  }

  /**
   * Resolves for every failed request. Rejects at once, before any request, when the client
   * has no `generations.getGeneration()`, which no retry can supply.
   */
  async find(id: string): Promise<LookupOutcome> {
    if (this.#maxWaitMs === 0) return DISABLED;
    const { generations } = this.#native;
    const getGeneration = generations.getGeneration.bind(generations);
    const deadline = performance.now() + this.#maxWaitMs;
    let delay = this.#initialDelayMs;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return EXHAUSTED;
      try {
        const response = await getGeneration(
          { id },
          { signal: AbortSignal.timeout(Math.ceil(remaining)), retries: SDK_RETRIES },
        );
        return { ok: true, facts: readFacts(response) };
      } catch (error) {
        if (!retryable(error)) return REJECTED;
      }
      const wait = Math.min(delay, this.#maxDelayMs);
      if (deadline - performance.now() <= wait) return EXHAUSTED;
      await sleep(wait);
      delay *= 2;
    }
  }
}

/**
 * Network failures and `404`, `408`, `429` and `5xx` are retried; authentication, payment,
 * validation and every other `4xx` are not. A `2xx` that still threw is a response the SDK
 * could not validate, which a retry cannot fix.
 */
function retryable(error: unknown): boolean {
  try {
    const status = isRecord(error) ? error.statusCode : undefined;
    if (typeof status === 'number') return RETRYABLE_STATUSES.has(status) || status >= 500;
    return !(error instanceof Error && PERMANENT_ERRORS.has(error.name));
  } catch {
    return false;
  }
}

function bound(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
