import { type AudrRecord } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { preflight } from '../src/preflight.js';
import { CUSTOMER_ID, EVENT_NAME, record } from './helpers.js';

const run = (batch: readonly AudrRecord[]): ReturnType<typeof preflight> =>
  preflight(batch, EVENT_NAME);

describe('preflight', () => {
  it('turns a record into one event with the agreed field mapping', () => {
    const source = record(
      { subscription_id: 'sub_42' },
      { timing: { event_time: '2022-04-29T16:19:51.123+02:00' } },
    );

    const { events, rejected } = run([source]);

    expect(rejected).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventName: EVENT_NAME,
      customerId: CUSTOMER_ID,
      idempotencyKey: source.record_id,
      timestamp: '2022-04-29T14:19:51.123Z',
    });
    expect(events[0]?.dimensions).toMatchObject({
      record_id: source.record_id,
      attribution__account_id: CUSTOMER_ID,
      attribution__subscription_id: 'sub_42',
      usage__llm__input_tokens: 10,
    });
  });

  it('sends only the fields Stigg accepts', () => {
    expect(Object.keys(run([record({ subscription_id: 'sub_1' })]).events[0] ?? {}).sort()).toEqual(
      ['customerId', 'dimensions', 'eventName', 'idempotencyKey', 'timestamp'],
    );
  });

  it('sends a subscription_id only as a dimension, never as a Stigg resource', () => {
    const [event] = run([record({ subscription_id: 'sub@1' })]).events;

    expect(event).toBeDefined();
    expect(event && 'resourceId' in event).toBe(false);
    expect(event?.dimensions).toMatchObject({ attribution__subscription_id: 'sub@1' });
  });

  it('handles an empty batch', () => {
    expect(run([])).toEqual({ events: [], rejected: [] });
  });

  it('keeps batch order', () => {
    const batch = [record(), record(), record()];

    expect(run(batch).events.map((event) => event.idempotencyKey)).toEqual(
      batch.map((entry) => entry.record_id),
    );
  });

  it('rejects a record without an account_id', () => {
    const source = record({ account_id: undefined });

    expect(run([source])).toEqual({
      events: [],
      rejected: [{ recordId: source.record_id, detail: 'missing_customer_id' }],
    });
  });

  it.each(['', 'has space', 'a/b'])('rejects the account_id %j', (account_id) => {
    const source = record({ account_id });

    expect(run([source]).rejected).toEqual([
      { recordId: source.record_id, detail: 'invalid_customer_id' },
    ]);
  });

  describe('event name', () => {
    it('sends a record without a feature_id, which is only a dimension here', () => {
      const source = record({ feature_id: undefined });

      expect(run([source]).events).toHaveLength(1);
    });
  });

  it('rejects a correction, which Stigg usage cannot restate', () => {
    const source = record({}, { corrects: record().record_id });

    expect(run([source]).rejected).toEqual([
      { recordId: source.record_id, detail: 'unsupported_correction' },
    ]);
  });

  it('rejects a correction before it checks the customer', () => {
    const source = record({ account_id: undefined }, { corrects: record().record_id });

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
    const bad = record({ account_id: undefined });
    const alsoGood = record();

    const { events, rejected } = run([good, bad, alsoGood]);

    expect(events.map((event) => event.idempotencyKey)).toEqual([
      good.record_id,
      alsoGood.record_id,
    ]);
    expect(rejected).toEqual([{ recordId: bad.record_id, detail: 'missing_customer_id' }]);
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
    const unusable = { ...valid, attribution: { ...valid.attribution, account_id: '' } };

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
    const first = record({ account_id: undefined });
    const second = { ...first, corrects: record().record_id };

    expect(run([first, second]).rejected).toEqual([
      { recordId: first.record_id, detail: 'missing_customer_id' },
    ]);
  });
});
