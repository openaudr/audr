import { MergeGateway } from 'merge-gateway-sdk';
import { describe, expect, it } from 'vitest';

import { instrumentMergeGateway, withAudr } from '../src/index.js';
import { drain, harness, recordingClient, response, streamFrames } from './helpers.js';

const PARAMS = { model: 'openai/gpt-5.4', input: 'hi' };

describe('attribution resolution', () => {
  it('merges the scope over the defaults, labels by key', async () => {
    const h = harness({
      attributionDefaults: { environment: 'test', labels: { service: 'api', tier: 'free' } },
    });
    h.fake.json(response());
    await withAudr({ attribution: { account_id: 'acct_1', labels: { tier: 'pro' } } }, () =>
      h.gateway.responses.create(PARAMS),
    );
    const [record] = await h.records();
    expect(record!.attribution).toEqual({
      environment: 'test',
      account_id: 'acct_1',
      labels: { service: 'api', tier: 'pro' },
    });
  });

  it('nests scopes, inner fields replacing outer ones', async () => {
    const h = harness();
    h.fake.json(response()).json(response());
    await withAudr({ attribution: { account_id: 'outer', subscription_id: 'sub_1' } }, async () => {
      await withAudr({ attribution: { account_id: 'inner' } }, () =>
        h.gateway.responses.create(PARAMS),
      );
      await h.gateway.responses.create(PARAMS);
    });
    const [inner, outer] = await h.records();
    expect(inner!.attribution).toEqual({
      environment: 'test',
      account_id: 'inner',
      subscription_id: 'sub_1',
    });
    expect(outer!.attribution).toEqual({
      environment: 'test',
      account_id: 'outer',
      subscription_id: 'sub_1',
    });
  });

  it('copies only the AUDR attribution fields', async () => {
    const h = harness({
      attributionDefaults: { environment: 'test', prompt: 'SENTINEL' } as never,
    });
    h.fake.json(response());
    await withAudr(
      { attribution: { user_id: 'u_1', feature_id: 'support-chat', extra: 'SENTINEL' } as never },
      () => h.gateway.responses.create(PARAMS),
    );
    const [record] = await h.records();
    expect(record!.attribution).toEqual({
      environment: 'test',
      user_id: 'u_1',
      feature_id: 'support-chat',
    });
    expect(JSON.stringify(record)).not.toContain('SENTINEL');
  });

  it('leaves a mistyped field to the Client, which rejects the record', async () => {
    const h = harness();
    h.fake.json(response());
    await withAudr({ attribution: { account_id: 42 } as never }, () =>
      h.gateway.responses.create(PARAMS),
    );
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings[0]).toMatch(
      /RECORD_NOT_QUEUED .*issues=\w+@\/attribution\/account_id\)$/,
    );
  });

  it('snapshots attributionDefaults when instrumenting', async () => {
    const defaults = { environment: 'test' as const, account_id: 'acct_1' };
    const h = harness({ attributionDefaults: defaults });
    defaults.account_id = 'acct_2';
    h.fake.json(response());
    await h.gateway.responses.create(PARAMS);
    const [record] = await h.records();
    expect(record!.attribution.account_id).toBe('acct_1');
  });

  it('ignores a context that is not an object', async () => {
    const h = harness();
    h.fake.json(response());
    await withAudr(null as never, () => h.gateway.responses.create(PARAMS));
    const [record] = await h.records();
    expect(record!.attribution).toEqual({ environment: 'test' });
  });

  it('ignores an unreadable context and still runs the body', async () => {
    const h = harness();
    h.fake.json(response());
    const context = {
      get attribution(): never {
        throw new RangeError('private value');
      },
    };
    await expect(
      withAudr(context, () => h.gateway.responses.create(PARAMS)),
    ).resolves.toBeDefined();
    expect(await h.records()).toHaveLength(1);
  });

  it('captures attribution when the stream starts, not when it is read', async () => {
    const h = harness();
    h.fake.sse(streamFrames());
    const stream = await withAudr({ attribution: { account_id: 'acct_1' } }, () =>
      h.gateway.responses.create({ ...PARAMS, stream: true }),
    );
    await withAudr({ attribution: { account_id: 'acct_2' } }, () => drain(stream));
    const [record] = await h.records();
    expect(record!.attribution.account_id).toBe('acct_1');
  });

  it('skips a call without an environment, without changing it', async () => {
    const h = harness({ attributionDefaults: { account_id: 'acct_1' } });
    const body = response();
    h.fake.json(body).json(response());
    expect(await h.gateway.responses.create(PARAMS)).toEqual(body);
    await withAudr({ attribution: { environment: 'test' } }, () =>
      h.gateway.responses.create(PARAMS),
    );
    expect(await h.records()).toHaveLength(1);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-merge-gateway: ATTRIBUTION_UNRESOLVED (operation=responses.create)',
    ]);
  });

  it('does not meter an unattributed stream', async () => {
    const h = harness({ attributionDefaults: {} });
    const frames = streamFrames();
    h.fake.sse(frames);
    expect(await drain(await h.gateway.responses.create({ ...PARAMS, stream: true }))).toEqual(
      frames,
    );
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toHaveLength(1);
  });

  it('returns exactly what the scope body returns', () => {
    const value = { a: 1 };
    expect(withAudr({}, () => value)).toBe(value);
    expect(() =>
      withAudr({}, () => {
        throw new RangeError('body');
      }),
    ).toThrow(RangeError);
  });
});

describe('scopes apply to every facade', () => {
  it('a scope reaches a client instrumented inside it', async () => {
    const h = harness();
    const other = recordingClient();
    h.fake.json(response());
    await withAudr({ attribution: { account_id: 'acct_1' } }, () => {
      const second = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_test' }), {
        client: other,
        attributionDefaults: { environment: 'test' },
      });
      return second.responses.create(PARAMS);
    });
    expect(other.submitted[0]!.attribution).toEqual({ environment: 'test', account_id: 'acct_1' });
  });

  it('a per-run client sends its Merge trace id and its records join that run', async () => {
    const h = harness();
    const traceId = 'run-0001-support';
    const traced = instrumentMergeGateway(
      new MergeGateway({ apiKey: 'mg_test', defaultHeaders: { 'X-Merge-Trace-Id': traceId } }),
      { client: h.client, attributionDefaults: { environment: 'test' } },
    );
    h.fake.json(response({ id: 'resp_aaaaaaaa' })).json(response({ id: 'resp_bbbbbbbb' }));
    await withAudr(
      { attribution: { account_id: 'acct_1' }, run: { run_id: traceId, name: 'support-agent' } },
      async () => {
        await traced.responses.create(PARAMS);
        await traced.responses.create(PARAMS);
      },
    );
    expect(h.fake.requests.map((r) => r.headers['x-merge-trace-id'])).toEqual([traceId, traceId]);
    const records = await h.records();
    expect(records.map((r) => [r.run.run_id, r.attribution.account_id])).toEqual([
      [traceId, 'acct_1'],
      [traceId, 'acct_1'],
    ]);
  });
});
