import { ConfigurationError } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { flattenRecord, VERSION } from '../src/index.js';
import { BATCH_URL, fakeFetch, makeSink, record, respond } from './helpers.js';

describe('ChargebeeSink requests', () => {
  it('sends one batch request carrying every event', async () => {
    const { fetch, calls } = fakeFetch(() => respond(202));
    const first = record({ subscription_id: 'sub_123' });
    const second = record({ subscription_id: 'sub_456' });

    const result = await makeSink({ fetch }).deliver([first, second]);

    expect(result).toEqual({ outcome: 'accepted', rejected: [], unknown: undefined });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(BATCH_URL);
    expect(call?.init.method).toBe('POST');
    expect(call?.headers).toEqual({
      Accept: 'application/json',
      Authorization: `Basic ${btoa('test_key:')}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': `audr-sink-chargebee/${VERSION} (typescript)`,
    });
    expect(call?.body.events.map((event) => Object.keys(event).sort())).toEqual([
      ['deduplication_id', 'properties', 'subscription_id', 'usage_timestamp'],
      ['deduplication_id', 'properties', 'subscription_id', 'usage_timestamp'],
    ]);
    expect(call?.body.events[0]).toMatchObject({
      subscription_id: 'sub_123',
      deduplication_id: first.record_id,
      usage_timestamp: Date.parse(first.timing.event_time),
    });
  });

  it.each(['_', '__'])(
    'sends every record field as properties flattened with %j',
    async (separator) => {
      const { fetch, calls } = fakeFetch(() => respond(202));
      const sent = record({ labels: { team: 'billing' } });

      await makeSink({ fetch, separator }).deliver([sent]);

      expect(calls[0]?.body.events[0]?.properties).toEqual(flattenRecord(sent, { separator }));
    },
  );

  it('flattens with a double underscore by default', async () => {
    const { fetch, calls } = fakeFetch(() => respond(202));
    const sent = record({ labels: { team: 'billing' } });

    await makeSink({ fetch }).deliver([sent]);

    const properties = calls[0]?.body.events[0]?.properties;
    expect(properties).toEqual(flattenRecord(sent, { separator: '__' }));
    expect(properties).toHaveProperty('usage__llm__input_tokens');
  });

  it.each(['-', '', '_a', 'a_', ' '])('rejects the separator %j', (separator) => {
    expect(() => makeSink({ separator })).toThrow(ConfigurationError);
    expect(() => makeSink({ separator })).toThrow('separator');
  });

  it('makes no request for an empty batch', async () => {
    const { fetch, calls } = fakeFetch(() => respond(202));

    expect(await makeSink({ fetch }).deliver([])).toEqual({ outcome: 'accepted', rejected: [] });
    expect(calls).toHaveLength(0);
  });

  it('rejects a record without a subscription_id, and never sends it', async () => {
    const { fetch, calls } = fakeFetch(() => respond(202));
    const unrouted = record({ subscription_id: undefined });

    const result = await makeSink({ fetch }).deliver([unrouted]);

    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: unrouted.record_id, detail: 'missing_subscription_id' }],
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a record the destination could not accept without losing the batch', async () => {
    const { fetch, calls } = fakeFetch(() => respond(202));
    const good = record();
    const bad = record({ subscription_id: 's'.repeat(500) });

    const result = await makeSink({ fetch }).deliver([good, bad]);

    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [
        { recordId: bad.record_id, detail: 'subscription_id must be at most 50 characters' },
      ],
      unknown: undefined,
    });
    expect(calls[0]?.body.events.map((event) => event.deduplication_id)).toEqual([good.record_id]);
  });

  it('rejects a record whose event_time is not a timestamp', async () => {
    const { fetch, calls } = fakeFetch(() => respond(202));
    const bad = record({}, { timing: { event_time: 'yesterday' } });

    const result = await makeSink({ fetch }).deliver([bad]);

    expect(result).toMatchObject({ rejected: [{ recordId: bad.record_id }] });
    expect(calls).toHaveLength(0);
  });
});
