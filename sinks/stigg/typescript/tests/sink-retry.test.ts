import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeFetch, hangingFetch, makeSink, record, records, respond } from './helpers.js';

function networkError(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code }) });
}

describe('StiggSink retries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a transient status and then succeeds', async () => {
    const { fetch, calls } = fakeFetch((_call, index) => respond(index === 0 ? 503 : 202));

    const result = await makeSink({ fetch }).deliver([record()]);

    expect(result.outcome).toBe('accepted');
    expect(calls).toHaveLength(2);
  });

  it('retries a network error and then succeeds', async () => {
    const { fetch, calls } = fakeFetch((_call, index) => {
      if (index === 0) throw networkError('ECONNRESET');
      return respond(202);
    });

    expect((await makeSink({ fetch }).deliver([record()])).outcome).toBe('accepted');
    expect(calls).toHaveLength(2);
  });

  it('stops after the attempt budget on a transient status', async () => {
    const { fetch, calls } = fakeFetch(() => respond(503));

    const result = await makeSink({ fetch }).deliver([record()]);

    expect(result).toEqual({ outcome: 'retryable_failure', detail: 'http_503' });
    expect(calls).toHaveLength(3);
  });

  it('honours a budget of one attempt', async () => {
    const { fetch, calls } = fakeFetch(() => respond(503));

    await makeSink({ fetch, retry: { maxAttempts: 1 } }).deliver([record()]);

    expect(calls).toHaveLength(1);
  });

  it('honours a larger budget', async () => {
    const { fetch, calls } = fakeFetch(() => respond(502));

    await makeSink({ fetch, retry: { maxAttempts: 5 } }).deliver([record()]);

    expect(calls).toHaveLength(5);
  });

  it('reports the network error code once retries are spent', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw networkError('ECONNREFUSED');
    });

    const result = await makeSink({ fetch, retry: { maxAttempts: 2 } }).deliver([record()]);

    expect(result).toEqual({ outcome: 'retryable_failure', detail: 'ECONNREFUSED' });
    expect(calls).toHaveLength(2);
  });

  it.each<[string, Error, string]>([
    ['an error without a system code, by its class name', new RangeError('boom'), 'RangeError'],
    [
      'a system code that is not identifier-shaped, by its class name',
      new TypeError('x', { cause: { code: 'has spaces and a secret' } }),
      'TypeError',
    ],
    [
      'a class name that is not identifier-shaped, as Error',
      Object.assign(new Error('x'), { name: 'sk-live secret' }),
      'Error',
    ],
    // An injected fetch may reject with anything, whatever its type promises.
    ['a value that is not an error, as Error', 'plain string' as unknown as Error, 'Error'],
  ])('reports %s', async (_name, thrown, detail) => {
    const fetch = (): Promise<Response> => Promise.reject(thrown);

    const result = await makeSink({ fetch, retry: { maxAttempts: 1 } }).deliver([record()]);

    expect(result).toEqual({ outcome: 'retryable_failure', detail });
  });

  it('retries a request that outlives timeoutMs', async () => {
    const result = await makeSink({
      fetch: hangingFetch(),
      timeoutMs: 10,
      retry: { maxAttempts: 2 },
    }).deliver([record()]);

    expect(result).toEqual({ outcome: 'retryable_failure', detail: 'TimeoutError' });
  });

  it('sends the same bytes on every attempt, whatever the clock does between them', async () => {
    vi.useFakeTimers();
    const batch = [
      record({}, { timing: { event_time: '2022-04-29T14:19:51.123Z' } }),
      ...records(2),
    ];
    const { fetch, calls } = fakeFetch((_call, index) => respond(index < 2 ? 503 : 200));
    const sink = makeSink({ fetch, retry: { initialBackoffMs: 60_000, maxBackoffMs: 60_000 } });
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const pending = sink.deliver(batch);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await pending;

    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.text)).size).toBe(1);
    expect(calls[0]?.events[0]?.timestamp).toBe('2022-04-29T14:19:51.123Z');
  });

  describe('delays', () => {
    it('grows the delay between attempts', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const { fetch, calls } = fakeFetch(() => respond(503));
      const sink = makeSink({ fetch, retry: { initialBackoffMs: 100, maxBackoffMs: 10_000 } });

      const pending = sink.deliver([record()]);
      await vi.advanceTimersByTimeAsync(99);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(199);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(3);
      await pending;
    });

    it('waits out Retry-After before the next attempt', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { fetch, calls } = fakeFetch((_call, index) =>
        index === 0 ? respond(503, undefined, { 'Retry-After': '2' }) : respond(202),
      );
      const sink = makeSink({ fetch, retry: { initialBackoffMs: 100, maxBackoffMs: 30_000 } });

      const pending = sink.deliver([record()]);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);

      expect((await pending).outcome).toBe('accepted');
      expect(calls).toHaveLength(2);
    });

    it('ignores X-RateLimit-Reset, which Stigg does not define', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { fetch, calls } = fakeFetch((_call, index) =>
        index === 0 ? respond(429, undefined, { 'X-RateLimit-Reset': '60' }) : respond(202),
      );
      const sink = makeSink({ fetch, retry: { initialBackoffMs: 100, maxBackoffMs: 30_000 } });

      const pending = sink.deliver([record()]);
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      expect(calls).toHaveLength(2);
    });

    it('caps a server hint at maxBackoffMs', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { fetch, calls } = fakeFetch((_call, index) =>
        index === 0 ? respond(429, undefined, { 'Retry-After': '3600' }) : respond(202),
      );
      const sink = makeSink({ fetch, retry: { maxBackoffMs: 5000 } });

      const pending = sink.deliver([record()]);
      await vi.advanceTimersByTimeAsync(4999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(calls).toHaveLength(2);
    });

    it('ignores a hint it cannot read', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { fetch, calls } = fakeFetch((_call, index) =>
        index === 0 ? respond(429, undefined, { 'Retry-After': 'soon' }) : respond(202),
      );
      const sink = makeSink({ fetch, retry: { maxBackoffMs: 30_000 } });

      const pending = sink.deliver([record()]);
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      expect(calls).toHaveLength(2);
    });
  });
});
