import { describe, expect, it } from 'vitest';

import {
  Diagnostics,
  errorName,
  formatDiagnostic,
  formatIssues,
  SILENT,
} from '../src/diagnostics.js';

describe('diagnostics carry no values', () => {
  it('formats the code and fields in a fixed order', () => {
    expect(
      formatDiagnostic('RECORD_NOT_QUEUED', {
        issues: 'REQUIRED@/attribution/account_id',
        outcome: 'rejected_invalid',
      }),
    ).toBe(
      '@openaudr/audr-adapter-mastra: RECORD_NOT_QUEUED (outcome=rejected_invalid, issues=REQUIRED@/attribution/account_id)',
    );
    expect(formatDiagnostic('EXPORT_FAILED', { error: 'TypeError' })).toBe(
      '@openaudr/audr-adapter-mastra: EXPORT_FAILED (error=TypeError)',
    );
    expect(formatDiagnostic('CONFIG_DROPS_SPANS', { setting: 'sampling' })).toBe(
      '@openaudr/audr-adapter-mastra: CONFIG_DROPS_SPANS (setting=sampling)',
    );
  });

  it.each([
    [new AggregateError([], 'secret'), 'AggregateError'],
    [new EvalError('secret'), 'EvalError'],
    [new RangeError('secret'), 'RangeError'],
    [new ReferenceError('secret'), 'ReferenceError'],
    [new SyntaxError('secret'), 'SyntaxError'],
    [new TypeError('secret'), 'TypeError'],
    [new URIError('secret'), 'URIError'],
    [
      new (class CustomError extends Error {
        override name = 'secret-account-id';
      })('secret'),
      'Error',
    ],
    ['secret', 'string'],
    [undefined, 'undefined'],
    [{ message: 'secret' }, 'object'],
  ])('errorName(%s) is %s', (error, name) => {
    expect(errorName(error)).toBe(name);
  });

  it('errorName cannot throw while inspecting a hostile value', () => {
    const error = new Proxy(new Error('secret'), {
      getPrototypeOf(): never {
        throw new TypeError('secret');
      },
    });
    expect(errorName(error)).toBe('unknown');
  });

  it('formats issues as code@path', () => {
    expect(
      formatIssues({
        outcome: 'rejected_invalid',
        queued: false,
        issues: [{ code: 'REQUIRED', path: '/attribution/account_id', message: 'm' }],
      }),
    ).toBe('REQUIRED@/attribution/account_id');
    expect(formatIssues({ outcome: 'dropped_queue_full', queued: false, issues: [] })).toBe(
      undefined,
    );
  });

  it('swallows logger failures', () => {
    const diagnostics = new Diagnostics({
      warn: (): void => {
        throw new Error('logger failed');
      },
      error: (): void => {
        throw new Error('logger failed');
      },
    });
    expect(() => {
      diagnostics.warn('EXPORT_FAILED', { error: 'Error' });
    }).not.toThrow();
    expect(() => {
      diagnostics.error('EXPORT_FAILED', { error: 'Error' });
    }).not.toThrow();
    SILENT.warn('x');
    SILENT.error('x');
  });
});
