import { type AudrRecord } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { preflight } from '../src/preflight.js';
import { FEATURE_ID, record } from './helpers.js';

const run = (batch: readonly AudrRecord[]): ReturnType<typeof preflight> => preflight(batch);

describe('preflight', () => {
  it('turns a record into one event with the agreed field mapping', () => {
    const source = record(
      { subscription_id: 'sub_42' },
      { timing: { event_time: '2022-04-29T14:19:51.123Z' } },
    );

    const { events, rejected } = run([source]);

    expect(rejected).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      transaction_id: source.record_id,
      external_subscription_id: 'sub_42',
      code: FEATURE_ID,
      timestamp: '1651241991.123',
    });
    expect(events[0]?.properties).toMatchObject({
      record_id: source.record_id,
      attribution__subscription_id: 'sub_42',
      usage__llm__input_tokens: 10,
    });
  });

  it('does not send the precise total amount', () => {
    expect(Object.keys(run([record()]).events[0] ?? {}).sort()).toEqual([
      'code',
      'external_subscription_id',
      'properties',
      'timestamp',
      'transaction_id',
    ]);
  });

  it('handles an empty batch', () => {
    expect(run([])).toEqual({ events: [], rejected: [] });
  });

  it('keeps batch order', () => {
    const batch = [record(), record(), record()];

    expect(run(batch).events.map((event) => event.transaction_id)).toEqual(
      batch.map((entry) => entry.record_id),
    );
  });

  it.each([undefined, '', '  '])('rejects the subscription %j as missing', (subscription_id) => {
    const source = record({ subscription_id });

    expect(run([source])).toEqual({
      events: [],
      rejected: [{ recordId: source.record_id, detail: 'missing_subscription_id' }],
    });
  });

  describe('metric code', () => {
    it('bills each record against the metric its feature_id names', () => {
      const batch = [record({ feature_id: 'llm_tokens' }), record({ feature_id: 'tool_calls' })];

      const { events, rejected } = preflight(batch);

      expect(rejected).toEqual([]);
      expect(events.map((event) => event.code)).toEqual(['llm_tokens', 'tool_calls']);
    });

    it('rejects a record without a feature_id, and sends the others', () => {
      const named = record();
      const unnamed = record({ feature_id: undefined });

      const { events, rejected } = preflight([named, unnamed]);

      expect(rejected).toEqual([{ recordId: unnamed.record_id, detail: 'missing_metric_code' }]);
      expect(events.map((event) => event.transaction_id)).toEqual([named.record_id]);
    });

    it.each([' llm_tokens', 'llm_tokens '])('rejects a record whose feature_id is %j', (code) => {
      const source = record({ feature_id: code });

      expect(preflight([source]).rejected).toEqual([
        { recordId: source.record_id, detail: 'invalid_metric_code' },
      ]);
    });
  });

  it('rejects a correction, which Lago cannot restate', () => {
    const source = record({}, { corrects: record().record_id });

    expect(run([source]).rejected).toEqual([
      { recordId: source.record_id, detail: 'unsupported_correction' },
    ]);
  });

  it('rejects a correction before it checks the subscription', () => {
    const source = record({ subscription_id: undefined }, { corrects: record().record_id });

    expect(run([source]).rejected[0]?.detail).toBe('unsupported_correction');
  });

  it('rejects an unparseable event time', () => {
    const source = record({}, { timing: { event_time: 'not a time' } });

    expect(run([source]).rejected).toEqual([
      { recordId: source.record_id, detail: 'invalid_timestamp' },
    ]);
  });

  it('names a field that cannot be encoded by pointer, never by value', () => {
    const source = record({}, { usage: { llm: { x_acme_odd: Number.NaN } } });

    expect(run([source]).rejected).toEqual([
      { recordId: source.record_id, detail: 'unencodable_field:/usage/llm/x_acme_odd' },
    ]);
  });

  it('rejects a record that lacks the structure the encoder reads', () => {
    const broken = { ...record(), attribution: undefined } as unknown as AudrRecord;

    expect(run([broken]).rejected).toEqual([
      { recordId: broken.record_id, detail: 'unencodable_record' },
    ]);
  });

  it('judges each record on its own', () => {
    const good = record();
    const bad = record({ subscription_id: undefined });
    const alsoGood = record();

    const { events, rejected } = run([good, bad, alsoGood]);

    expect(events.map((event) => event.transaction_id)).toEqual([
      good.record_id,
      alsoGood.record_id,
    ]);
    expect(rejected).toEqual([{ recordId: bad.record_id, detail: 'missing_subscription_id' }]);
  });

  it('collapses a byte-identical duplicate into one event', () => {
    const source = record();

    const { events, rejected } = run([source, structuredClone(source)]);

    expect(events).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it('rejects every record that shares a record_id but differs in content', () => {
    const first = record();
    const conflicting = { ...first, attribution: { ...first.attribution, account_id: 'other' } };
    const identicalToFirst = structuredClone(first);

    const { events, rejected } = run([first, conflicting, identicalToFirst]);

    expect(events).toEqual([]);
    expect(rejected).toEqual([{ recordId: first.record_id, detail: 'duplicate_record_id' }]);
  });

  it('does not send either record when one of two with the same record_id is unusable', () => {
    const valid = record();
    const unusable = { ...valid, attribution: { ...valid.attribution, subscription_id: '' } };

    for (const batch of [
      [valid, unusable],
      [unusable, valid],
    ]) {
      const { events, rejected } = run(batch);

      expect(events).toEqual([]);
      expect(rejected).toEqual([
        { recordId: valid.record_id, detail: expect.any(String) as string },
      ]);
    }
  });

  it('reports the first reason when a record_id is rejected twice', () => {
    const first = record({ subscription_id: undefined });
    const second = { ...first, corrects: record().record_id };

    expect(run([first, second]).rejected).toEqual([
      { recordId: first.record_id, detail: 'missing_subscription_id' },
    ]);
  });
});
