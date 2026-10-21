import { describe, expect, it } from 'vitest';

import { InvalidUsageEventError } from '../src/event.js';
import { flatten } from '../src/flatten.js';
import { flattenRecord } from '../src/index.js';
import { record } from './helpers.js';

describe('flatten', () => {
  it('joins nested object keys with double underscores', () => {
    expect(flatten({ a: { b: { c: 1 } }, d: 'x' })).toEqual({ a__b__c: 1, d: 'x' });
  });

  it.each([1, 1.5, 'text', true, false, null])('passes the scalar %j through', (value) => {
    expect(flatten({ field: value })).toEqual({ field: value });
  });

  it('stores an array as canonical JSON under a json suffix', () => {
    expect(flatten({ items: [3, 1, { b: 2, a: 1 }] })).toEqual({
      items__json: '[3,1,{"a":1,"b":2}]',
    });
  });

  it('makes each label its own property, rewriting . and - to _', () => {
    expect(flatten({ labels: { team: 'core', 'cost-center': 'r1', 'env.tier': 'gold' } })).toEqual({
      labels__team: 'core',
      labels__cost_center: 'r1',
      labels__env_tier: 'gold',
    });
  });

  it('rejects label keys that collide after rewriting, naming no value', () => {
    const collide = () => flatten({ attribution: { labels: { 'a.b': '1', 'a-b': '2' } } });

    expect(collide).toThrow(InvalidUsageEventError);
    expect(collide).toThrow('labels at /attribution/labels collide');
    expect(collide).not.toThrow(/[12]/);
  });

  it('does not escape non-ASCII values', () => {
    expect(flatten({ labels: { team: 'Ümlaut' }, items: ['Ümlaut'] })).toEqual({
      labels__team: 'Ümlaut',
      items__json: '["Ümlaut"]',
    });
  });

  it('drops undefined values and empty objects', () => {
    expect(flatten({ a: {}, b: 1, c: undefined, labels: { d: undefined, e: 'x' } })).toEqual({
      b: 1,
      labels__e: 'x',
    });
  });

  it('refuses a value that is not a JSON object', () => {
    expect(() => flatten(['not', 'an', 'object'])).toThrow('must encode to a JSON object');
  });

  it.each([
    [{ outer: { inner: new Date() } }, '/outer/inner'],
    [{ outer: { items: [() => 1] } }, '/outer/items'],
    [{ items: [Number.NaN] }, '/items'],
    [{ 'a/b': { 'c~d': Symbol('s') } }, '/a~1b/c~0d'],
  ])('refuses %o, naming its pointer', (value, pointer) => {
    expect(() => flatten(value)).toThrow(InvalidUsageEventError);
    expect(() => flatten(value)).toThrow(`field at ${pointer} is not JSON-encodable`);
  });
});

describe('flattenRecord', () => {
  it('flattens a real record into addressable scalar properties', () => {
    const flattened = flattenRecord(
      record({
        account_id: 'acct_1',
        subscription_id: 'sub_1',
        feature_id: 'support-chat',
        labels: { team: 'billing', 'cost-center': 'r1' },
      }),
    );

    expect(flattened.usage__llm__input_tokens).toBe(10);
    expect(flattened.resource__type).toBe('model');
    expect(flattened.attribution__subscription_id).toBe('sub_1');
    expect(flattened.attribution__feature_id).toBe('support-chat');
    expect(flattened.attribution__labels__team).toBe('billing');
    expect(flattened.attribution__labels__cost_center).toBe('r1');
    for (const [key, value] of Object.entries(flattened)) {
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });

  it('uses the separator for label names too', () => {
    const flattened = flattenRecord(record({ labels: { team: 'billing' } }), { separator: '_' });

    expect(flattened).toHaveProperty('usage_llm_input_tokens');
    expect(flattened).toHaveProperty('attribution_labels_team');
    expect(flattened).not.toHaveProperty('usage__llm__input_tokens');
  });
});
