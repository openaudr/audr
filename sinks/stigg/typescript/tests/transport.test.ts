import { ConfigurationError } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { AbortedError, ClosedError, Transport } from '../src/transport.js';
import { fakeFetch, hangingFetch, respond, settle } from './helpers.js';

const URL = 'https://stigg.example.test/api/v1/events';

describe('Transport', () => {
  it('posts the body with the headers, never following a redirect', async () => {
    const { fetch, calls } = fakeFetch(() =>
      respond(302, undefined, { Location: 'https://elsewhere.test' }),
    );
    const transport = new Transport({ fetch });

    const response = await transport.post(URL, '{"events":[]}', { Authorization: 'Bearer x' });

    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(calls[0]?.headers).toEqual({ Authorization: 'Bearer x' });
    expect(calls[0]?.text).toBe('{"events":[]}');
  });

  it('lets an error from fetch through unchanged', async () => {
    const failure = new TypeError('fetch failed');
    const transport = new Transport({
      fetch: () => Promise.reject(failure),
    });

    await expect(transport.post(URL, '{}', {})).rejects.toBe(failure);
    expect(transport.closed).toBe(false);
  });

  it('aborts a request that outlives timeoutMs', async () => {
    const transport = new Transport({ fetch: hangingFetch(), timeoutMs: 10 });

    await expect(transport.post(URL, '{}', {})).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(transport.closed).toBe(false);
  });

  it('is terminal and idempotent once closed', async () => {
    const { fetch, calls } = fakeFetch(() => respond(200));
    const transport = new Transport({ fetch });

    await transport.close();
    await transport.close();

    expect(transport.closed).toBe(true);
    await expect(transport.post(URL, '{}', {})).rejects.toBeInstanceOf(ClosedError);
    expect(calls).toHaveLength(0);
  });

  it('reports a request cut short by close as closed, after waiting for it to settle', async () => {
    const transport = new Transport({ fetch: hangingFetch() });
    const pending = transport.post(URL, '{}', {});
    const outcome = expect(pending).rejects.toBeInstanceOf(ClosedError);
    await settle();

    await transport.close();

    await outcome;
  });

  it('reports a request cut short by the caller as aborted, without closing', async () => {
    const transport = new Transport({ fetch: hangingFetch() });
    const caller = new AbortController();
    const pending = transport.post(URL, '{}', {}, caller.signal);
    const outcome = expect(pending).rejects.toBeInstanceOf(AbortedError);
    await settle();

    caller.abort();

    await outcome;
    expect(transport.closed).toBe(false);
  });

  it('sends nothing for a signal that has already aborted', async () => {
    const { fetch, calls } = fakeFetch(() => respond(200));
    const transport = new Transport({ fetch });

    await expect(transport.post(URL, '{}', {}, AbortSignal.abort())).rejects.toBeInstanceOf(
      AbortedError,
    );
    expect(calls).toHaveLength(0);
  });

  it('prefers closed to aborted when both apply', async () => {
    const transport = new Transport({ fetch: hangingFetch() });
    const caller = new AbortController();
    const pending = transport.post(URL, '{}', {}, caller.signal);
    const outcome = expect(pending).rejects.toBeInstanceOf(ClosedError);
    await settle();

    caller.abort();
    await transport.close();

    await outcome;
  });

  it('ends a pause early when closed, and skips it once closed', async () => {
    const transport = new Transport({ fetch: hangingFetch() });
    const started = Date.now();
    const pause = transport.pause(60_000);

    await transport.close();
    await pause;
    await transport.pause(60_000);

    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('ends a pause early when the caller aborts, and skips it once aborted', async () => {
    const transport = new Transport({ fetch: hangingFetch() });
    const caller = new AbortController();
    const started = Date.now();
    const pause = transport.pause(60_000, caller.signal);

    caller.abort();
    await pause;
    await transport.pause(60_000, caller.signal);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(transport.closed).toBe(false);
  });

  it('waits for the full pause when nothing interrupts it', async () => {
    const transport = new Transport({ fetch: hangingFetch() });
    const started = Date.now();

    await transport.pause(30);

    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it.each([0, -1, Number.NaN, Infinity, 2 ** 31, '10'])('rejects timeoutMs %j', (timeoutMs) => {
    expect(() => new Transport({ timeoutMs: timeoutMs as number })).toThrow(ConfigurationError);
  });
});
