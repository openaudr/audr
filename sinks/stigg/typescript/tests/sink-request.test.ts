import { ConfigurationError } from '@openaudr/audr';
import { describe, expect, it, vi } from 'vitest';

import { flattenRecord, StiggSink, VERSION } from '../src/index.js';
import {
  API_KEY,
  API_URL,
  CUSTOMER_ID,
  EVENT_NAME,
  EVENTS_URL,
  fakeFetch,
  makeSink,
  record,
  records,
  respond,
  settle,
} from './helpers.js';

const ok = (): Response => respond(202, { data: {} });

describe('StiggSink requests', () => {
  it('sends one authenticated POST to the events endpoint', async () => {
    const { fetch, calls } = fakeFetch(ok);

    await makeSink({ fetch }).deliver([record()]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(EVENTS_URL);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(calls[0]?.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': `audr-sink-stigg/${VERSION}`,
      'X-API-KEY': API_KEY,
    });
  });

  it('wraps events in an events array and sends nothing else', async () => {
    const { fetch, calls } = fakeFetch(ok);

    await makeSink({ fetch }).deliver([record()]);

    expect(Object.keys(JSON.parse(calls[0]?.text ?? '{}') as object)).toEqual(['events']);
  });

  it('maps one record to one event with the agreed fields', async () => {
    const source = record(
      { subscription_id: 'sub_42' },
      { timing: { event_time: '2022-04-29T14:19:51.123Z' } },
    );
    const { fetch, calls } = fakeFetch(ok);

    await makeSink({ fetch }).deliver([source]);

    expect(calls[0]?.events).toEqual([
      {
        eventName: EVENT_NAME,
        customerId: CUSTOMER_ID,
        timestamp: '2022-04-29T14:19:51.123Z',
        idempotencyKey: source.record_id,
        dimensions: flattenRecord(source),
      },
    ]);
  });

  it('sends an event time with an offset as the same instant in UTC', async () => {
    const { fetch, calls } = fakeFetch(ok);

    await makeSink({ fetch }).deliver([
      record({}, { timing: { event_time: '2022-04-29T16:19:51.123+02:00' } }),
    ]);

    expect(calls[0]?.events[0]?.timestamp).toBe('2022-04-29T14:19:51.123Z');
  });

  it('names each event through an eventName function', async () => {
    const batch = [record({ feature_id: 'llm_tokens' }), record({ feature_id: 'tool_calls' })];
    const { fetch, calls } = fakeFetch(ok);

    await makeSink({
      fetch,
      eventName: (source) => `ai.${source.attribution.feature_id ?? 'other'}`,
    }).deliver(batch);

    expect(calls[0]?.events.map((event) => event.eventName)).toEqual([
      'ai.llm_tokens',
      'ai.tool_calls',
    ]);
  });

  it('sends cost as ordinary dimensions and adds no field of its own', async () => {
    const { fetch, calls } = fakeFetch(ok);

    await makeSink({ fetch }).deliver([
      record(
        {},
        {
          cost: {
            currency: 'USD',
            total_cost: 0.75,
            llm: { input_token_cost: 0.5, total_token_cost: 0.5 },
          },
        },
      ),
    ]);

    const [event] = calls[0]?.events ?? [];
    expect(Object.keys(event ?? {}).sort()).toEqual([
      'customerId',
      'dimensions',
      'eventName',
      'idempotencyKey',
      'timestamp',
    ]);
    expect(event?.dimensions).toMatchObject({
      cost__currency: 'USD',
      cost__total_cost: 0.75,
      cost__llm__input_token_cost: 0.5,
    });
  });

  it('forwards the whole record, labels and extension counters included', async () => {
    const source = record(
      { labels: { team: 'search', env: 'blue' } },
      { usage: { llm: { input_tokens: 12, x_acme_cached: 4 } } },
    );
    const { fetch, calls } = fakeFetch(ok);

    await makeSink({ fetch }).deliver([source]);

    expect(calls[0]?.events[0]?.dimensions).toMatchObject({
      attribution__labels__team: 'search',
      attribution__labels__env: 'blue',
      usage__llm__x_acme_cached: 4,
      usage__llm__input_tokens: 12,
      record_id: source.record_id,
    });
  });

  it('does not change the records it is given', async () => {
    const batch = [record({ labels: { b: '1', a: '2' } })];
    const before = structuredClone(batch);

    await makeSink({ fetch: fakeFetch(ok).fetch }).deliver(batch);

    expect(batch).toEqual(before);
  });

  it('answers an empty batch without a request', async () => {
    const { fetch, calls } = fakeFetch(ok);

    expect(await makeSink({ fetch }).deliver([])).toEqual({ outcome: 'accepted', rejected: [] });
    expect(calls).toHaveLength(0);
  });

  it('answers a batch of unusable records without a request', async () => {
    const first = record({ account_id: undefined });
    const second = record({}, { corrects: record().record_id });
    const { fetch, calls } = fakeFetch(ok);

    expect(await makeSink({ fetch }).deliver([first, second])).toEqual({
      outcome: 'accepted',
      rejected: [
        { recordId: first.record_id, detail: 'missing_customer_id' },
        { recordId: second.record_id, detail: 'unsupported_correction' },
      ],
    });
    expect(calls).toHaveLength(0);
  });

  it('sends the usable records of a mixed batch and rejects the rest by name', async () => {
    const good = record();
    const bad = record({ account_id: 'not valid' });
    const { fetch, calls } = fakeFetch(ok);

    const result = await makeSink({ fetch }).deliver([bad, good]);

    expect(calls[0]?.events.map((event) => event.idempotencyKey)).toEqual([good.record_id]);
    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: bad.record_id, detail: 'invalid_customer_id' }],
    });
  });

  it('sends a byte-identical duplicate once', async () => {
    const source = record();
    const { fetch, calls } = fakeFetch(ok);

    const result = await makeSink({ fetch }).deliver([source, structuredClone(source)]);

    expect(calls[0]?.events).toHaveLength(1);
    expect(result).toEqual({ outcome: 'accepted', rejected: [] });
  });

  it('sends neither of two records that share a record_id but differ', async () => {
    const first = record();
    const second = { ...first, attribution: { ...first.attribution, account_id: 'other' } };
    const { fetch, calls } = fakeFetch(ok);

    const result = await makeSink({ fetch }).deliver([first, second]);

    expect(calls).toHaveLength(0);
    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: first.record_id, detail: 'duplicate_record_id' }],
    });
  });

  describe('batching', () => {
    it.each([
      [1, [1]],
      [500, [500]],
      [1000, [1000]],
      [1001, [1000, 1]],
    ])('sends %i records as requests of %j events', async (count, sizes) => {
      const { fetch, calls } = fakeFetch(ok);

      const result = await makeSink({ fetch }).deliver(records(count));

      expect(calls.map((call) => call.events.length)).toEqual(sizes);
      expect(result).toEqual({ outcome: 'accepted', rejected: [] });
    });

    it('keeps batch order across requests, sending each record once', async () => {
      const batch = records(1200);
      const { fetch, calls } = fakeFetch(ok);

      await makeSink({ fetch }).deliver(batch);

      expect(calls.flatMap((call) => call.events.map((event) => event.idempotencyKey))).toEqual(
        batch.map((entry) => entry.record_id),
      );
    });

    it('sends one request at a time', async () => {
      let active = 0;
      let peak = 0;
      const { fetch } = fakeFetch(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await settle();
        active -= 1;
        return ok();
      });

      await makeSink({ fetch }).deliver(records(2100));

      expect(peak).toBe(1);
    });
  });

  describe('eventName option', () => {
    it('is required', () => {
      expect(
        () =>
          new StiggSink({ apiKey: API_KEY } as unknown as ConstructorParameters<
            typeof StiggSink
          >[0]),
      ).toThrow('eventName is required');
    });

    it.each(['', ' ai.usage', 'x'.repeat(256), '$usage.reported', 42])(
      'refuses the fixed name %j at construction',
      (eventName) => {
        expect(() => makeSink({ eventName: eventName as string })).toThrow(ConfigurationError);
      },
    );
  });

  describe('environment', () => {
    it('reads the key and URL from the environment once, at construction', async () => {
      vi.stubEnv('STIGG_API_KEY', 'env-key');
      vi.stubEnv('STIGG_API_URL', 'https://env.example.test/api/v1');
      const { fetch, calls } = fakeFetch(ok);
      const sink = new StiggSink({ eventName: EVENT_NAME, fetch });
      vi.stubEnv('STIGG_API_KEY', 'changed-key');

      await sink.deliver([record()]);

      expect(calls[0]?.url).toBe('https://env.example.test/api/v1/events');
      expect(calls[0]?.headers['X-API-KEY']).toBe('env-key');
    });

    it('prefers explicit options to the environment', async () => {
      vi.stubEnv('STIGG_API_KEY', 'env-key');
      const { fetch, calls } = fakeFetch(ok);

      await makeSink({ fetch }).deliver([record()]);

      expect(calls[0]?.headers['X-API-KEY']).toBe(API_KEY);
    });

    it('defaults to the Stigg API when no URL is set', async () => {
      const { fetch, calls } = fakeFetch(ok);

      await new StiggSink({ apiKey: API_KEY, eventName: EVENT_NAME, fetch }).deliver([record()]);

      expect(calls[0]?.url).toBe('https://api.stigg.io/api/v1/events');
    });

    it('is unaffected by later changes to the options object', async () => {
      const options = { apiKey: API_KEY, apiUrl: API_URL, eventName: EVENT_NAME };
      const { fetch, calls } = fakeFetch(ok);
      const sink = new StiggSink({ ...options, fetch });
      options.apiKey = 'swapped';
      options.apiUrl = 'https://swapped.example.test';
      options.eventName = 'swapped';

      await sink.deliver([record()]);

      expect(calls[0]?.url).toBe(EVENTS_URL);
      expect(calls[0]?.headers['X-API-KEY']).toBe(API_KEY);
      expect(calls[0]?.events[0]?.eventName).toBe(EVENT_NAME);
    });
  });
});
