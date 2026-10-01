import { describe, expect, it } from 'vitest';

import { errorName, formatDiagnostic, formatIssues } from '../src/diagnostics.js';

describe('diagnostics carry no values', () => {
  it('formats the code and fields in a fixed order', () => {
    expect(
      formatDiagnostic('RECORD_NOT_QUEUED', {
        issues: 'REQUIRED@/attribution/account_id',
        operation: 'ai.generateText',
        outcome: 'rejected_invalid',
      }),
    ).toBe(
      '@openaudr/audr-adapter-vercel-ai: RECORD_NOT_QUEUED (outcome=rejected_invalid, operation=ai.generateText, issues=REQUIRED@/attribution/account_id)',
    );
    expect(formatDiagnostic('HOOK_FAILED', { error: 'TypeError', hook: 'onEnd' })).toBe(
      '@openaudr/audr-adapter-vercel-ai: HOOK_FAILED (hook=onEnd, error=TypeError)',
    );
    expect(formatDiagnostic('OPERATION_UNSUPPORTED', { operation: 'ai.generateObject' })).toBe(
      '@openaudr/audr-adapter-vercel-ai: OPERATION_UNSUPPORTED (operation=ai.generateObject)',
    );
  });

  it('skips undefined fields and never includes unknown keys', () => {
    expect(
      formatDiagnostic('ATTRIBUTION_UNRESOLVED', { operation: 'ai.embed', error: undefined }),
    ).toBe('@openaudr/audr-adapter-vercel-ai: ATTRIBUTION_UNRESOLVED (operation=ai.embed)');
    const smuggled = { operation: 'ai.embed', account_id: 'acct_42' } as never;
    expect(formatDiagnostic('ATTRIBUTION_UNRESOLVED', smuggled)).not.toContain('acct_42');
    expect(formatDiagnostic('HOOK_FAILED', {})).toBe(
      '@openaudr/audr-adapter-vercel-ai: HOOK_FAILED',
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

  it('errorName never reads a mutable Error.name', () => {
    const error = Object.defineProperty(new Error('secret'), 'name', {
      get(): never {
        throw new TypeError('secret');
      },
    });
    expect(errorName(error)).toBe('Error');
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
        issues: [
          { code: 'REQUIRED', path: '/attribution/account_id', message: 'm' },
          { code: 'INVALID_ENUM', path: '/attribution/environment', message: 'm' },
        ],
      }),
    ).toBe('REQUIRED@/attribution/account_id,INVALID_ENUM@/attribution/environment');
    expect(formatIssues({ outcome: 'dropped_queue_full', queued: false, issues: [] })).toBe(
      undefined,
    );
  });
});
