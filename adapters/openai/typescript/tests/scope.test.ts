import { describe, expect, it } from 'vitest';

import { instrumentOpenAI, withAudr } from '../src/index.js';
import {
  CHAT_PARAMS,
  chatChunks,
  chatCompletion,
  drain,
  harness,
  nativeClient,
  recordingClient,
} from './helpers.js';

describe('attribution resolution', () => {
  it('merges the scope over the defaults, labels by key', async () => {
    const h = harness({
      attributionDefaults: { environment: 'test', labels: { service: 'api', tier: 'free' } },
    });
    h.fake.json(chatCompletion());
    await withAudr({ attribution: { account_id: 'acct_1', labels: { tier: 'pro' } } }, () =>
      h.openai.chat.completions.create(CHAT_PARAMS),
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
    h.fake.json(chatCompletion()).json(chatCompletion());
    await withAudr({ attribution: { account_id: 'outer', subscription_id: 'sub_1' } }, async () => {
      await withAudr({ attribution: { account_id: 'inner' } }, () =>
        h.openai.chat.completions.create(CHAT_PARAMS),
      );
      await h.openai.chat.completions.create(CHAT_PARAMS);
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
    h.fake.json(chatCompletion());
    await withAudr(
      { attribution: { user_id: 'u_1', feature_id: 'support-chat', extra: 'SENTINEL' } as never },
      () => h.openai.chat.completions.create(CHAT_PARAMS),
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
    h.fake.json(chatCompletion());
    await withAudr({ attribution: { account_id: 42 } as never }, () =>
      h.openai.chat.completions.create(CHAT_PARAMS),
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
    h.fake.json(chatCompletion());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    const [record] = await h.records();
    expect(record!.attribution.account_id).toBe('acct_1');
  });

  it('ignores a context that is not an object', async () => {
    const h = harness();
    h.fake.json(chatCompletion());
    await withAudr(null as never, () => h.openai.chat.completions.create(CHAT_PARAMS));
    const [record] = await h.records();
    expect(record!.attribution).toEqual({ environment: 'test' });
  });

  it('ignores an unreadable context and still runs the body', async () => {
    const h = harness();
    h.fake.json(chatCompletion());
    const context = {
      get attribution(): never {
        throw new RangeError('private value');
      },
    };
    await expect(
      withAudr(context, () => h.openai.chat.completions.create(CHAT_PARAMS)),
    ).resolves.toBeDefined();
    expect(await h.records()).toHaveLength(1);
  });

  it('captures attribution when the stream starts, not when it is read', async () => {
    const h = harness();
    h.fake.sse(chatChunks());
    const stream = await withAudr({ attribution: { account_id: 'acct_1' } }, () =>
      h.openai.chat.completions.create({ ...CHAT_PARAMS, stream: true }),
    );
    await withAudr({ attribution: { account_id: 'acct_2' } }, () => drain(stream));
    const [record] = await h.records();
    expect(record!.attribution.account_id).toBe('acct_1');
  });

  it('skips a call without an environment, without changing it', async () => {
    const h = harness({ attributionDefaults: { account_id: 'acct_1' } });
    const body = chatCompletion();
    h.fake.json(body).json(chatCompletion());
    expect(await h.openai.chat.completions.create(CHAT_PARAMS)).toEqual(body);
    await withAudr({ attribution: { environment: 'test' } }, () =>
      h.openai.chat.completions.create(CHAT_PARAMS),
    );
    expect(await h.records()).toHaveLength(1);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openai: ATTRIBUTION_UNRESOLVED (operation=chat.completions.create)',
    ]);
  });

  it('does not meter an unattributed stream', async () => {
    const h = harness({ attributionDefaults: {} });
    const chunks = chatChunks();
    h.fake.sse(chunks);
    expect(
      await drain(await h.openai.chat.completions.create({ ...CHAT_PARAMS, stream: true })),
    ).toEqual(chunks);
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
    h.fake.json(chatCompletion());
    await withAudr({ attribution: { account_id: 'acct_1' } }, () => {
      const second = instrumentOpenAI(nativeClient(), {
        client: other,
        attributionDefaults: { environment: 'test' },
      });
      return second.chat.completions.create(CHAT_PARAMS);
    });
    expect(other.submitted[0]!.attribution).toEqual({ environment: 'test', account_id: 'acct_1' });
  });
});
