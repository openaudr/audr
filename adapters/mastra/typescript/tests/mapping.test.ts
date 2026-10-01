import { describe, expect, it } from 'vitest';

import { counter, nonEmpty, providerSlug, spanTiming, toLlmUsage } from '../src/mapping.js';

describe('toLlmUsage', () => {
  it('removes cache tokens from input and reasoning from output', () => {
    expect(
      toLlmUsage({
        inputTokens: 120,
        outputTokens: 50,
        inputDetails: { cacheRead: 20, cacheWrite: 5 },
        outputDetails: { reasoning: 10 },
      }),
    ).toEqual({
      input_tokens: 95,
      output_tokens: 40,
      cache_read_tokens: 20,
      cache_write_tokens: 5,
      reasoning_tokens: 10,
    });
  });

  it('keeps audio and image tokens in the input and output totals', () => {
    expect(
      toLlmUsage({
        inputTokens: 100,
        outputTokens: 30,
        inputDetails: { text: 60, audio: 30, cacheRead: 10 },
        outputDetails: { text: 20, image: 10 },
      }),
    ).toEqual({ input_tokens: 90, output_tokens: 30, cache_read_tokens: 10 });
  });

  it('never writes requests', () => {
    const usage = toLlmUsage({ inputTokens: 12, outputTokens: 3 });
    expect(usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  it('returns undefined when nothing was reported', () => {
    expect(toLlmUsage({})).toBeUndefined();
  });

  it('never subtracts below zero', () => {
    expect(
      toLlmUsage({
        inputTokens: 5,
        outputTokens: 2,
        inputDetails: { cacheRead: 9 },
        outputDetails: { reasoning: 4 },
      }),
    ).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 9, reasoning_tokens: 4 });
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])(
    'treats a counter of %s as unreported',
    (bad) => {
      expect(
        toLlmUsage({
          inputTokens: bad,
          outputTokens: bad,
          inputDetails: { cacheRead: bad, cacheWrite: bad },
          outputDetails: { reasoning: bad },
        }),
      ).toBeUndefined();
    },
  );
});

describe('providerSlug', () => {
  it.each([
    ['openai.chat', 'openai'],
    ['anthropic.messages', 'anthropic'],
    ['gateway', 'vercel-ai-gateway'],
    ['azure.openai', 'azure-openai'],
    ['google.vertex.chat', 'google-vertex'],
    ['Mistral AI', 'mistral-ai'],
  ])('maps %s to %s', (provider, slug) => {
    expect(providerSlug(provider)).toBe(slug);
  });

  it.each(['', '.chat', '***', undefined, 42])('returns undefined for %s', (provider) => {
    expect(providerSlug(provider)).toBeUndefined();
  });
});

describe('counter and nonEmpty', () => {
  it.each([0, 42])('accepts %s', (n) => {
    expect(counter(n)).toBe(n);
  });

  it('accepts only non-empty strings', () => {
    expect(nonEmpty('x')).toBe('x');
    expect(nonEmpty('')).toBeUndefined();
    expect(nonEmpty(7)).toBeUndefined();
  });
});

describe('spanTiming', () => {
  const start = new Date('2026-01-01T00:00:00.000Z');
  const end = new Date('2026-01-01T00:00:01.500Z');

  it('uses endTime and computes duration', () => {
    expect(spanTiming(start, end)).toEqual({ eventTime: end, durationMs: 1500 });
  });

  it('accepts ISO strings', () => {
    expect(spanTiming(start.toISOString(), end.toISOString()).durationMs).toBe(1500);
  });

  it('falls back to startTime with no duration when endTime is missing', () => {
    expect(spanTiming(start, undefined)).toEqual({ eventTime: start, durationMs: undefined });
  });

  it('omits a negative duration', () => {
    expect(spanTiming(end, start)).toEqual({ eventTime: start, durationMs: undefined });
  });

  it('falls back to now when neither end is valid', () => {
    const before = Date.now();
    expect(spanTiming('not a date', undefined).eventTime.getTime()).toBeGreaterThanOrEqual(before);
  });
});
