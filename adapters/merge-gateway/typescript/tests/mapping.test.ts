import { describe, expect, it } from 'vitest';

import { errorKind, formatDiagnostic } from '../src/diagnostics.js';
import { embeddingUsage, fitsRunId, responseUsage, toCost } from '../src/mapping.js';

describe('token arithmetic', () => {
  it('makes input exclusive of cache reads and writes and output of reasoning', () => {
    expect(
      responseUsage({
        input_tokens: 100,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 10,
        output_tokens: 50,
        reasoning_output_tokens: 20,
      }),
    ).toEqual({
      input_tokens: 30,
      output_tokens: 30,
      cache_read_tokens: 60,
      cache_write_tokens: 10,
      reasoning_tokens: 20,
      requests: 1,
    });
  });

  it('never goes below zero', () => {
    expect(
      responseUsage({
        input_tokens: 5,
        cache_read_input_tokens: 9,
        output_tokens: 1,
        reasoning_output_tokens: 4,
      }),
    ).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it('omits input_tokens when Gateway cannot report cache reads', () => {
    expect(
      responseUsage({ input_tokens: 41, output_tokens: 7, cache_read_input_tokens: null }),
    ).toEqual({ output_tokens: 7, requests: 1 });
  });

  it('keeps unreported cache writes in input_tokens', () => {
    expect(
      responseUsage({
        input_tokens: 41,
        output_tokens: 7,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: null,
      }),
    ).toEqual({ input_tokens: 36, output_tokens: 7, cache_read_tokens: 5, requests: 1 });
  });

  it('keeps the whole completion as output_tokens when reasoning is unreported', () => {
    expect(
      responseUsage({ input_tokens: 41, output_tokens: 7, reasoning_output_tokens: null }),
    ).toEqual({ input_tokens: 41, output_tokens: 7, requests: 1 });
  });

  it('treats an absent split counter as unused', () => {
    expect(responseUsage({ input_tokens: 41, output_tokens: 7 })).toEqual({
      input_tokens: 41,
      output_tokens: 7,
      requests: 1,
    });
    expect(responseUsage(undefined)).toEqual({ requests: 1 });
    expect(responseUsage(null)).toEqual({ requests: 1 });
  });

  it('reads embedding input from prompt_tokens', () => {
    expect(embeddingUsage({ prompt_tokens: 3 })).toEqual({ input_tokens: 3, requests: 1 });
    expect(embeddingUsage(null)).toEqual({ requests: 1 });
  });
});

describe('cost', () => {
  it('asserts usage.cost as a USD total only', () => {
    expect(toCost({ cost: 0.5 })).toEqual({ total_cost: 0.5, currency: 'USD' });
    expect(toCost({ cost: 0 })).toEqual({ total_cost: 0, currency: 'USD' });
  });

  it('writes no cost when Gateway reports none', () => {
    expect(toCost({ cost: null })).toBeUndefined();
    expect(toCost({})).toBeUndefined();
    expect(toCost(undefined)).toBeUndefined();
  });
});

describe('run identifiers', () => {
  it('accepts a response id of 8 to 64 characters as a run id', () => {
    expect(fitsRunId('12345678')).toBe(true);
    expect(fitsRunId('x'.repeat(64))).toBe(true);
    expect(fitsRunId('1234567')).toBe(false);
    expect(fitsRunId('x'.repeat(65))).toBe(false);
  });
});

describe('diagnostics', () => {
  it('prints the fields in a fixed order', () => {
    expect(
      formatDiagnostic('RECORD_NOT_QUEUED', {
        issues: 'INVALID_TYPE@/run/run_id',
        operation: 'responses.create',
        outcome: 'rejected_invalid',
      }),
    ).toBe(
      '@openaudr/audr-adapter-merge-gateway: RECORD_NOT_QUEUED (outcome=rejected_invalid, operation=responses.create, issues=INVALID_TYPE@/run/run_id)',
    );
  });

  it('classifies errors by built-in type, never by their own name', () => {
    const renamed = new TypeError('private value');
    renamed.name = 'private value';
    expect(errorKind(renamed)).toBe('TypeError');
    expect(errorKind(new SyntaxError('x'))).toBe('SyntaxError');
    expect(errorKind(new (class Custom extends Error {})('x'))).toBe('Error');
    expect(errorKind('x')).toBe('string');
  });

  it('cannot throw while classifying a hostile error', () => {
    const error = new Proxy(new Error('private value'), {
      getPrototypeOf(): never {
        throw new RangeError('private value');
      },
    });
    expect(errorKind(error)).toBe('unknown');
  });
});
