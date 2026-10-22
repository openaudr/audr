import { describe, expect, it } from 'vitest';

import { flatten, flattenRecord } from '../src/flatten.js';
import { record } from './helpers.js';

function reason(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as Error).message;
  }
  return 'accepted';
}

describe('flatten', () => {
  it('joins nested names with the fixed double underscore', () => {
    expect(flatten({ usage: { llm: { input_tokens: 10, requests: 1 } }, name: 'm' })).toEqual({
      usage__llm__input_tokens: 10,
      usage__llm__requests: 1,
      name: 'm',
    });
  });

  it('makes each label its own property, keeping the key verbatim', () => {
    expect(flatten({ attribution: { labels: { b: '2', 'cost-center': '1' } } })).toEqual({
      attribution__labels__b: '2',
      'attribution__labels__cost-center': '1',
    });
  });

  it('stores arrays as canonical JSON, sorting the keys of nested objects', () => {
    expect(flatten({ tags: [{ z: 1, a: [true, null, 'x'] }, 2] })).toEqual({
      tags__json: '[{"a":[true,null,"x"],"z":1},2]',
    });
  });

  it('omits undefined values, including inside an array', () => {
    expect(
      flatten({ a: undefined, labels: { b: '1', c: undefined }, d: [{ e: undefined }] }),
    ).toEqual({ labels__b: '1', d__json: '[{}]' });
  });

  it('keeps zero, negative and fractional numbers and the empty string', () => {
    expect(flatten({ a: 0, b: -2, c: 0.5, d: '' })).toEqual({ a: 0, b: -2, c: 0.5, d: '' });
  });

  it.each([
    ['not a number', { usage: { x_bad: Number.NaN } }, '/usage/x_bad'],
    ['infinite', { usage: { x_bad: Number.POSITIVE_INFINITY } }, '/usage/x_bad'],
    ['a boolean', { flag: true }, '/flag'],
    ['null', { run: { value: null } }, '/run/value'],
    ['a function', { fn: () => 1 }, '/fn'],
    ['a bigint', { big: 1n }, '/big'],
    ['a date', { when: new Date(0) }, '/when'],
    ['a non-finite number in labels', { labels: { x: Number.NaN } }, '/labels/x'],
    ['an undefined array item', { list: [undefined] }, '/list'],
    ['a class instance in an array', { list: [new Date(0)] }, '/list'],
  ])('rejects a field that is %s, naming only its pointer', (_name, nested, path) => {
    expect(reason(() => flatten(nested))).toBe(`unencodable_field:${path}`);
  });

  it('escapes the characters a pointer reserves in a field name', () => {
    expect(reason(() => flatten({ 'a/b': { 'c~d': true } }))).toBe('unencodable_field:/a~1b/c~0d');
  });

  it.each([null, 'text', 3, [1]])('rejects a root that is %j', (root) => {
    expect(reason(() => flatten(root))).toBe('unencodable_record');
  });

  it('accepts an object without a prototype', () => {
    expect(flatten(Object.assign(Object.create(null) as object, { a: 1 }))).toEqual({ a: 1 });
  });
});

describe('flattenRecord', () => {
  it('forwards every field of a record, with labels and extension counters', () => {
    const source = record(
      { account_id: 'acct_1', feature_id: 'search', labels: { team: 'search', env: 'blue' } },
      {
        timing: { event_time: '2022-04-29T14:19:51.123Z' },
        usage: { llm: { input_tokens: 12, output_tokens: 3, requests: 1, x_acme_cached: 4 } },
      },
    );

    expect(flattenRecord(source)).toEqual({
      spec_version: source.spec_version,
      record_id: source.record_id,
      emitter__component: 'harness',
      emitter__name: 'audr-testing',
      emitter__version: '0',
      timing__event_time: '2022-04-29T14:19:51.123Z',
      resource__provider: 'anthropic',
      resource__type: 'model',
      resource__name: 'test-model',
      resource__operation: 'generation',
      resource__modality: 'text',
      run__run_id: source.run.run_id,
      run__span_id: 'span-1',
      attribution__environment: 'test',
      attribution__subscription_id: 'sub_test',
      attribution__account_id: 'acct_1',
      attribution__feature_id: 'search',
      attribution__labels__team: 'search',
      attribution__labels__env: 'blue',
      usage__llm__input_tokens: 12,
      usage__llm__output_tokens: 3,
      usage__llm__requests: 1,
      usage__llm__x_acme_cached: 4,
    });
  });

  it('is deterministic', () => {
    const source = record({ labels: { b: '1', a: '2' } });

    expect(flattenRecord(source)).toEqual(flattenRecord(structuredClone(source)));
  });

  it('names a field that cannot be encoded without its value', () => {
    const source = record({}, { usage: { llm: { input_tokens: Number.NaN } } });

    expect(reason(() => flattenRecord(source))).toBe('unencodable_field:/usage/llm/input_tokens');
  });
});
