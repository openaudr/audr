import { ConfigurationError } from '@openaudr/audr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isTransient,
  parseRetryAfterMs,
  RetryPolicy,
  type RetryOptions,
  retryHintMs,
} from '../src/retry.js';

const NOW = Date.parse('2026-10-05T08:00:00Z');

describe('RetryPolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to three attempts, a 500 ms first ceiling, doubling, capped at 30 s', () => {
    expect(new RetryPolicy()).toMatchObject({
      maxAttempts: 3,
      initialBackoffMs: 500,
      maxBackoffMs: 30_000,
      multiplier: 2,
    });
  });

  it.each([
    [{ maxAttempts: 1.5 }, 'maxAttempts must be an integer'],
    [{ maxAttempts: 0 }, 'maxAttempts must be at least 1'],
    [{ initialBackoffMs: -1 }, 'initialBackoffMs must be at least 0'],
    [{ initialBackoffMs: Number.NaN }, 'initialBackoffMs must be a finite number'],
    [{ maxBackoffMs: Number.POSITIVE_INFINITY }, 'maxBackoffMs must be a finite number'],
    [{ maxBackoffMs: -5 }, 'maxBackoffMs must be at least 0'],
    [{ maxBackoffMs: 2 ** 31 }, 'maxBackoffMs must be at most'],
    [{ multiplier: 0.5 }, 'multiplier must be at least 1'],
    [{ multiplier: '2' as unknown as number }, 'multiplier must be a finite number'],
  ] as [RetryOptions, string][])('rejects %j', (options, message) => {
    expect(() => new RetryPolicy(options)).toThrow(ConfigurationError);
    expect(() => new RetryPolicy(options)).toThrow(message);
  });

  it('draws a delay between zero and a ceiling that grows with each attempt', () => {
    const policy = new RetryPolicy({ initialBackoffMs: 100, multiplier: 2, maxBackoffMs: 10_000 });
    const random = vi.spyOn(Math, 'random');

    random.mockReturnValue(0);
    expect(policy.delayMs(3)).toBe(0);
    random.mockReturnValue(0.5);
    expect(policy.delayMs(1)).toBe(50);
    expect(policy.delayMs(3)).toBe(200);
    random.mockReturnValue(1);
    expect(policy.delayMs(4)).toBe(800);
  });

  it('never exceeds maxBackoffMs', () => {
    const policy = new RetryPolicy({ initialBackoffMs: 100, maxBackoffMs: 250 });
    vi.spyOn(Math, 'random').mockReturnValue(1);

    expect(policy.delayMs(10)).toBe(250);
  });

  it('waits at least as long as a hint, within the cap', () => {
    const policy = new RetryPolicy({ initialBackoffMs: 100, maxBackoffMs: 5000 });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(policy.delayMs(1, 2000)).toBe(2000);
    expect(policy.delayMs(1, 60_000)).toBe(5000);
    expect(policy.delayMs(1, 0)).toBe(0);
  });

  it('prefers a longer jittered delay to a shorter hint', () => {
    const policy = new RetryPolicy({ initialBackoffMs: 1000, maxBackoffMs: 5000 });
    vi.spyOn(Math, 'random').mockReturnValue(1);

    expect(policy.delayMs(1, 10)).toBe(1000);
  });
});

describe('isTransient', () => {
  it.each([408, 409, 429, 500, 501, 502, 503, 504, 520, 599])('retries %i', (status) => {
    expect(isTransient(status)).toBe(true);
  });

  it.each([200, 202, 301, 400, 401, 403, 404, 413, 422, 499, 600])(
    'does not retry %i',
    (status) => {
      expect(isTransient(status)).toBe(false);
    },
  );
});

describe('parseRetryAfterMs', () => {
  it.each([
    ['2', 2000],
    ['0', 0],
    [' 7 ', 7000],
    ['Mon, 05 Oct 2026 08:00:30 GMT', 30_000],
    ['Mon, 05 Oct 2026 07:00:00 GMT', 0],
  ])('reads %j as %i ms', (value, expected) => {
    expect(parseRetryAfterMs(value, NOW)).toBe(expected);
  });

  it.each([
    null,
    '',
    '-1',
    '+3',
    '1.5',
    '1e3',
    'soon',
    '5 seconds',
    '2026-10-05T08:00:30Z',
    'Mon, 99 Oct 2026 08:00:30 GMT',
  ])('ignores %j', (value) => {
    expect(parseRetryAfterMs(value, NOW)).toBeUndefined();
  });
});

describe('retryHintMs', () => {
  const headers = (init: Record<string, string>): Headers => new Headers(init);

  it('has no hint without a header, as Stigg sends today', () => {
    expect(retryHintMs(headers({}), NOW)).toBeUndefined();
  });

  it('honours Retry-After if Stigg sends one', () => {
    expect(retryHintMs(headers({ 'Retry-After': '4' }), NOW)).toBe(4000);
  });

  it('ignores headers Stigg does not define', () => {
    expect(retryHintMs(headers({ 'X-RateLimit-Reset': '9' }), NOW)).toBeUndefined();
  });

  it('ignores an invalid hint', () => {
    expect(retryHintMs(headers({ 'Retry-After': 'soon' }), NOW)).toBeUndefined();
  });
});
