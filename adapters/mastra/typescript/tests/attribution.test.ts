import { describe, expect, it } from 'vitest';

import {
  mergeAttribution,
  readMetadataAttribution,
  resolveAttribution,
} from '../src/attribution.js';

describe('metadata.audr reader', () => {
  it('keeps the string fields and string labels', () => {
    expect(
      readMetadataAttribution({
        audr: {
          environment: 'production',
          user_id: 'u',
          account_id: 'a',
          subscription_id: 's',
          labels: { team: 'x' },
        },
      }),
    ).toEqual({
      environment: 'production',
      user_id: 'u',
      account_id: 'a',
      subscription_id: 's',
      labels: { team: 'x' },
    });
  });

  it('unknown fields are dropped', () => {
    expect(
      readMetadataAttribution({
        audr: { account_id: 42, environment: 'test', cost_center: 'x', email: 'e' },
      }),
    ).toEqual({ environment: 'test' });
  });

  it.each([
    ['labels with a non-string value', { labels: { a: 'x', b: 1 } }],
    ['labels as an array', { labels: ['x'] }],
    ['labels as a string', { labels: 'x' }],
  ])('drops %s', (_, audr) => {
    expect(readMetadataAttribution({ audr })).toEqual({});
  });

  it('ignores an inherited audr namespace', () => {
    const metadata = Object.create({
      audr: { environment: 'production', account_id: 'attacker' },
    }) as Record<string, unknown>;
    expect(readMetadataAttribution(metadata)).toBeUndefined();
  });

  it('returns undefined when metadata is absent', () => {
    expect(readMetadataAttribution(undefined)).toBeUndefined();
  });
});

describe('merge', () => {
  it('per-span wins field by field', () => {
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
});

describe('resolution', () => {
  it('defaults only', () => {
    expect(resolveAttribution({}, { environment: 'test' })).toEqual({
      kind: 'resolved',
      attribution: { environment: 'test' },
    });
  });

  it('nothing resolves', () => {
    expect(resolveAttribution({}, { account_id: 'a' })).toEqual({ kind: 'unresolved' });
  });
});
