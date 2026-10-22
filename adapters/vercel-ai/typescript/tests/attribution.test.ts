import { describe, expect, it } from 'vitest';

import {
  type AttributionSource,
  mergeAttribution,
  readRuntimeAttribution,
  resolveAttribution,
} from '../src/attribution.js';

function source(runtimeContext: Record<string, unknown> = {}): AttributionSource {
  return { operationId: 'ai.generateText', functionId: undefined, runtimeContext };
}

describe('default runtimeContext reader', () => {
  it('keeps the string fields and string labels', () => {
    expect(
      readRuntimeAttribution(
        source({
          audr: {
            environment: 'production',
            user_id: 'u',
            account_id: 'a',
            subscription_id: 's',
            feature_id: 'f',
            labels: { team: 'x' },
          },
        }),
      ),
    ).toEqual({
      environment: 'production',
      user_id: 'u',
      account_id: 'a',
      subscription_id: 's',
      feature_id: 'f',
      labels: { team: 'x' },
    });
  });

  it('unknown fields are dropped', () => {
    expect(
      readRuntimeAttribution(
        source({ audr: { account_id: 42, environment: 'test', cost_center: 'x', email: 'e' } }),
      ),
    ).toEqual({ environment: 'test' });
  });

  it.each([
    ['labels with a non-string value', { labels: { a: 'x', b: 1 } }],
    ['labels as an array', { labels: ['x'] }],
    ['labels as a string', { labels: 'x' }],
  ])('drops %s', (_, audr) => {
    expect(readRuntimeAttribution(source({ audr }))).toEqual({});
  });

  it.each([undefined, null, 'acct', 42, ['a'], new Map()])(
    'no per-call attribution when audr is %s',
    (audr) => {
      expect(readRuntimeAttribution(source({ audr }))).toBeUndefined();
    },
  );

  it('accepts a null-prototype object', () => {
    const audr = Object.assign(Object.create(null) as object, { account_id: 'a' });
    expect(readRuntimeAttribution(source({ audr }))).toEqual({ account_id: 'a' });
  });

  it('ignores an inherited audr namespace', () => {
    const runtimeContext = Object.create({
      audr: { environment: 'production', account_id: 'attacker' },
    }) as Record<string, unknown>;
    expect(readRuntimeAttribution(source(runtimeContext))).toBeUndefined();
  });

  it('ignores attribution fields inherited through Object.prototype', () => {
    Object.defineProperty(Object.prototype, 'account_id', {
      configurable: true,
      value: 'attacker',
    });
    try {
      expect(readRuntimeAttribution(source({ audr: { environment: 'test' } }))).toEqual({
        environment: 'test',
      });
    } finally {
      delete (Object.prototype as { account_id?: unknown }).account_id;
    }
  });
});

describe('merge', () => {
  it('per-call wins field by field', () => {
    expect(
      mergeAttribution(
        { environment: 'production', account_id: 'a', user_id: 'u' },
        { account_id: 'b' },
      ),
    ).toEqual({ environment: 'production', account_id: 'b', user_id: 'u' });
  });

  it('labels merge by key', () => {
    expect(
      mergeAttribution(
        { environment: 'test', labels: { team: 'a', region: 'eu' } },
        { labels: { team: 'b' } },
      ),
    ).toEqual({ environment: 'test', labels: { team: 'b', region: 'eu' } });
  });

  it('undefined fields do not erase defaults', () => {
    expect(
      mergeAttribution({ environment: 'test', account_id: 'a' }, { account_id: undefined }),
    ).toEqual({ environment: 'test', account_id: 'a' });
  });

  it('nothing on either side is empty', () => {
    expect(mergeAttribution(undefined, undefined)).toEqual({});
  });
});

describe('resolution', () => {
  it('defaults only', () => {
    expect(resolveAttribution(source(), { environment: 'test' })).toEqual({
      kind: 'resolved',
      attribution: { environment: 'test' },
    });
  });

  it('per-call only', () => {
    expect(resolveAttribution(source({ audr: { environment: 'staging' } }), undefined)).toEqual({
      kind: 'resolved',
      attribution: { environment: 'staging' },
    });
  });

  it('nothing resolves', () => {
    expect(resolveAttribution(source(), { account_id: 'a' })).toEqual({
      kind: 'unresolved',
    });
  });

  it('a non-object audr value leaves the defaults', () => {
    expect(resolveAttribution(source({ audr: 'acct' }), { environment: 'test' })).toEqual({
      kind: 'resolved',
      attribution: { environment: 'test' },
    });
  });
});
