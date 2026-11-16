/** A terminally closeable `fetch` wrapper with a request deadline and caller cancellation. */
import { ConfigurationError } from '@openaudr/audr';

import { MAX_DELAY_MS } from './retry.js';

/** A request reached, or was cut short by, a closed transport. */
export class ClosedError extends Error {
  override readonly name: string = 'ClosedError';
}

/** A request reached, or was cut short by, an aborted caller signal. */
export class AbortedError extends Error {
  override readonly name: string = 'AbortedError';
}

export interface TransportOptions {
  /** Deadline for each request, in milliseconds. Default 10000. */
  readonly timeoutMs?: number | undefined;
  /** Replaces the global `fetch`, for example with one backed by an undici `Agent`. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export class Transport {
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #shutdown = new AbortController();
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(options: TransportOptions = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ConfigurationError('timeoutMs must be a finite number greater than 0');
    }
    if (timeoutMs > MAX_DELAY_MS) {
      throw new ConfigurationError(`timeoutMs must be at most ${MAX_DELAY_MS}`);
    }
    this.#timeoutMs = timeoutMs;
    // Looked up per request, not captured, so the global can be replaced after construction.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  get closed(): boolean {
    return this.#shutdown.signal.aborted;
  }

  /**
   * POST `body` to `url`. Rejects with `ClosedError` once the transport is closed and with
   * `AbortedError` once `signal` aborts; any other rejection is a network error or timeout.
   */
  async post(
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<Response> {
    this.#assertOpen(signal);
    const pending = this.#fetch(url, {
      method: 'POST',
      body,
      headers,
      // The configured endpoint is the only destination for a request carrying the API key.
      // Following a redirect would hand the key to a host no check ever saw.
      redirect: 'manual',
      signal: AbortSignal.any([
        this.#shutdown.signal,
        AbortSignal.timeout(this.#timeoutMs),
        ...(signal ? [signal] : []),
      ]),
    });
    this.#inFlight.add(pending);
    try {
      return await pending;
    } catch (error) {
      if (this.#shutdown.signal.aborted) throw new ClosedError(undefined, { cause: error });
      if (signal?.aborted) throw new AbortedError(undefined, { cause: error });
      throw error;
    } finally {
      this.#inFlight.delete(pending);
    }
  }

  /** Wait `ms` milliseconds, or less if the transport closes or `signal` aborts first. */
  pause(ms: number, signal?: AbortSignal): Promise<void> {
    const interrupt = AbortSignal.any([this.#shutdown.signal, ...(signal ? [signal] : [])]);
    if (interrupt.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        interrupt.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      interrupt.addEventListener('abort', done, { once: true });
    });
  }

  /** Idempotent and terminal: aborts outstanding requests and waits for them to settle. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.#shutdown.abort();
    await Promise.allSettled([...this.#inFlight]);
  }

  #assertOpen(signal: AbortSignal | undefined): void {
    if (this.closed) throw new ClosedError();
    if (signal?.aborted) throw new AbortedError();
  }
}
