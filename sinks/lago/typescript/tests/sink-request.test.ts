import { describe, expect, it, vi } from 'vitest';

import { flattenRecord, LagoSink, VERSION } from '../src/index.js';
import {
  API_KEY,
  API_URL,
  BATCH_URL,
  fakeFetch,
  makeSink,
  FEATURE_ID,
  record,
  records,
  respond,
  settle,
} from './helpers.js';

const ok = (): Response => respond(200, { events: [] });

describe('LagoSink requests', () => {
  it('sends one authenticated POST to the batch endpoint', async () => {
    const { fetch, calls } = fakeFetch(ok);

    await makeSink({ fetch }).deliver([record()]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(BATCH_URL);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(calls[0]?.headers).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': `audr-sink-lago/${VERSION}`,
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
        transaction_id: source.record_id,
        external_subscription_id: 'sub_42',
        code: FEATURE_ID,
        timestamp: '1651241991.123',
        properties: flattenRecord(source),
      },
    ]);
  });

  it('bills each record against the metric its feature_id names', async () => {
    const unnamed = record({ feature_id: undefined });
    const batch = [
      record({ feature_id: 'llm_tokens' }),
      record({ feature_id: 'tool_calls' }),
      unnamed,
    ];
    const { fetch, calls } = fakeFetch(ok);

    expect(await makeSink({ fetch }).deliver(batch)).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: unnamed.record_id, detail: 'missing_metric_code' }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.events.map((event) => event.code)).toEqual(['llm_tokens', 'tool_calls']);
  });

  it('sends no cost or amount field of its own', async () => {
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
      'code',
      'external_subscription_id',
      'properties',
      'timestamp',
      'transaction_id',
    ]);
    expect(event?.properties).toMatchObject({
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

    expect(calls[0]?.events[0]?.properties).toMatchObject({
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
    const first = record({ subscription_id: undefined });
    const second = record({}, { corrects: record().record_id });
    const { fetch, calls } = fakeFetch(ok);

    expect(await makeSink({ fetch }).deliver([first, second])).toEqual({
      outcome: 'accepted',
      rejected: [
        { recordId: first.record_id, detail: 'missing_subscription_id' },
        { recordId: second.record_id, detail: 'unsupported_correction' },
      ],
    });
    expect(calls).toHaveLength(0);
  });

  it('sends the usable records of a mixed batch and rejects the rest by name', async () => {
    const good = record();
    const bad = record({ subscription_id: '' });
    const { fetch, calls } = fakeFetch(ok);

    const result = await makeSink({ fetch }).deliver([bad, good]);

    expect(calls[0]?.events.map((event) => event.transaction_id)).toEqual([good.record_id]);
    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: bad.record_id, detail: 'missing_subscription_id' }],
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
      [99, [99]],
      [100, [100]],
      [101, [100, 1]],
      [200, [100, 100]],
      [250, [100, 100, 50]],
      [500, [100, 100, 100, 100, 100]],
    ])('splits %i records into requests of %j events', async (count, sizes) => {
      const { fetch, calls } = fakeFetch(ok);

      const result = await makeSink({ fetch }).deliver(records(count));

      expect(calls.map((call) => call.events.length)).toEqual(sizes);
      expect(result).toEqual({ outcome: 'accepted', rejected: [] });
    });

    it('keeps batch order across requests, sending each record once', async () => {
      const batch = records(230);
      const { fetch, calls } = fakeFetch(ok);

      await makeSink({ fetch }).deliver(batch);

      expect(calls.flatMap((call) => call.events.map((event) => event.transaction_id))).toEqual(
        batch.map((entry) => entry.record_id),
      );
    });

    it('chunks after local rejections, so every request is as full as it can be', async () => {
      const batch = [...records(60), record({ subscription_id: undefined }), ...records(60)];
      const { fetch, calls } = fakeFetch(ok);

      await makeSink({ fetch }).deliver(batch);

      expect(calls.map((call) => call.events.length)).toEqual([100, 20]);
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

      await makeSink({ fetch }).deliver(records(350));

      expect(peak).toBe(1);
    });
  });

  describe('environment', () => {
    it('reads the key and URL from the environment once, at construction', async () => {
      vi.stubEnv('LAGO_API_KEY', 'env-key');
      vi.stubEnv('LAGO_API_URL', 'https://env.example.test/api/v1');
      const { fetch, calls } = fakeFetch(ok);
      const sink = new LagoSink({ fetch });
      vi.stubEnv('LAGO_API_KEY', 'changed-key');

      await sink.deliver([record()]);

      expect(calls[0]?.url).toBe('https://env.example.test/api/v1/events/batch');
      expect(calls[0]?.headers.Authorization).toBe('Bearer env-key');
    });

    it('prefers explicit options to the environment', async () => {
      vi.stubEnv('LAGO_API_KEY', 'env-key');
      const { fetch, calls } = fakeFetch(ok);

      await makeSink({ fetch }).deliver([record()]);

      expect(calls[0]?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    it('defaults to Lago Cloud when no URL is set', async () => {
      const { fetch, calls } = fakeFetch(ok);

      await new LagoSink({ apiKey: API_KEY, fetch }).deliver([record()]);

      expect(calls[0]?.url).toBe('https://api.getlago.com/api/v1/events/batch');
    });

    it('sends over http only when explicitly allowed', async () => {
      const { fetch, calls } = fakeFetch(ok);
      const sink = makeSink({ apiUrl: 'http://localhost:3000', allowInsecureHttp: true, fetch });

      await sink.deliver([record()]);

      expect(calls[0]?.url).toBe('http://localhost:3000/api/v1/events/batch');
    });

    it('is unaffected by later changes to the options object', async () => {
      const options = { apiKey: API_KEY, apiUrl: API_URL };
      const { fetch, calls } = fakeFetch(ok);
      const sink = new LagoSink({ ...options, fetch });
      options.apiKey = 'swapped';
      options.apiUrl = 'https://swapped.example.test';

      await sink.deliver([record()]);

      expect(calls[0]?.url).toBe(BATCH_URL);
      expect(calls[0]?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });
  });
});
