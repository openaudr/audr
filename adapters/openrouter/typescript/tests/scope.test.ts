import { describe, expect, it } from 'vitest';

import { mergeAttribution } from '../src/attribution.js';
import { withAudr } from '../src/index.js';
import {
  chatResult,
  embeddingsResult,
  generation,
  harness,
  responsesResult,
  sleep,
} from './helpers.js';

const CHAT = { chatRequest: { model: 'anthropic/claude-sonnet-4.5', messages: [] } };

function answered(options: Parameters<typeof harness>[0] = {}, results = 1) {
  const h = harness(options);
  for (let n = 0; n < results; n += 1)
    h.fake.answer('chat.send', chatResult({ id: `gen-${n}-abcdefgh` }));
  return h;
}

describe('attribution', () => {
  it('comes from the defaults when no scope is open', async () => {
    const h = answered({
      attributionDefaults: {
        environment: 'production',
        account_id: 'acct_default',
        labels: { a: '1' },
      },
    });
    await h.openrouter.chat.send(CHAT);
    expect((await h.records())[0]?.attribution).toEqual({
      environment: 'production',
      account_id: 'acct_default',
      labels: { a: '1' },
    });
  });

  it('is overridden field by field by a scope, which keeps the defaults it does not set', async () => {
    const h = answered({
      attributionDefaults: {
        environment: 'production',
        account_id: 'acct_default',
        user_id: 'u_default',
      },
    });
    await withAudr({ attribution: { account_id: 'acct_scope', subscription_id: 'sub_1' } }, () =>
      h.openrouter.chat.send(CHAT as never),
    );
    expect((await h.records())[0]?.attribution).toEqual({
      environment: 'production',
      account_id: 'acct_scope',
      subscription_id: 'sub_1',
      user_id: 'u_default',
    });
  });

  it('nests: an inner scope replaces outer fields and merges labels by key', async () => {
    const h = answered();
    await withAudr(
      {
        attribution: {
          account_id: 'outer',
          user_id: 'u_outer',
          labels: { team: 'a', tier: 'gold' },
        },
      },
      () =>
        withAudr({ attribution: { account_id: 'inner', labels: { team: 'b', env: 'x' } } }, () =>
          h.openrouter.chat.send(CHAT as never),
        ),
    );
    expect((await h.records())[0]?.attribution).toEqual({
      environment: 'test',
      account_id: 'inner',
      user_id: 'u_outer',
      labels: { team: 'b', tier: 'gold', env: 'x' },
    });
  });

  it('merges scope labels over default labels by key', async () => {
    const h = answered({
      attributionDefaults: { environment: 'test', labels: { a: '1', b: '2' } },
    });
    await withAudr({ attribution: { labels: { b: '3' } } }, () =>
      h.openrouter.chat.send(CHAT as never),
    );
    expect((await h.records())[0]?.attribution.labels).toEqual({ a: '1', b: '3' });
  });

  it('writes no labels when there are none', async () => {
    const h = answered();
    await h.openrouter.chat.send(CHAT);
    expect((await h.records())[0]?.attribution).toEqual({ environment: 'test' });
  });

  it('reaches calls made after an await inside the scope', async () => {
    const h = answered();
    await withAudr({ attribution: { account_id: 'acct_late' } }, async () => {
      await sleep(5);
      await h.openrouter.chat.send(CHAT);
    });
    expect((await h.records())[0]?.attribution.account_id).toBe('acct_late');
  });

  it('does not reach calls made outside the scope', async () => {
    const h = answered({}, 2);
    await withAudr({ attribution: { account_id: 'inside' } }, () =>
      h.openrouter.chat.send(CHAT as never),
    );
    await h.openrouter.chat.send(CHAT);
    const records = await h.records();
    expect(records[0]?.attribution.account_id).toBe('inside');
    expect(records[1]?.attribution).not.toHaveProperty('account_id');
  });

  it('keeps concurrent scopes apart', async () => {
    const h = answered({}, 2);
    await Promise.all([
      withAudr({ attribution: { account_id: 'one' } }, async () => {
        await sleep(10);
        await h.openrouter.chat.send(CHAT);
      }),
      withAudr({ attribution: { account_id: 'two' } }, async () => {
        await h.openrouter.chat.send(CHAT);
      }),
    ]);
    const accounts = (await h.records()).map((record) => record.attribution.account_id).sort();
    expect(accounts).toEqual(['one', 'two']);
  });

  it('is fixed where the call starts, even when the scope has ended by the time it completes', async () => {
    const h = harness();
    const release = h.fake.hold('chat.send');
    const pending = withAudr({ attribution: { account_id: 'acct_start' } }, () =>
      h.openrouter.chat.send(CHAT as never),
    );
    await sleep(5);
    release(chatResult());
    await pending;
    expect((await h.records())[0]?.attribution.account_id).toBe('acct_start');
  });

  it('copies only the fields AUDR defines', async () => {
    const h = answered({
      attributionDefaults: { environment: 'test', secret: 'leaked-default' } as never,
    });
    await withAudr({ attribution: { account_id: 'a', password: 'leaked-scope' } as never }, () =>
      h.openrouter.chat.send(CHAT as never),
    );
    expect(JSON.stringify(await h.records())).not.toContain('leaked');
  });

  it('applies the same way to Responses and Embeddings', async () => {
    const h = harness();
    h.fake
      .answer('responses.send', responsesResult())
      .answer('embeddings.generate', embeddingsResult())
      .answer('generations.getGeneration', generation());
    await withAudr({ attribution: { account_id: 'acct_all' } }, async () => {
      await h.openrouter.responses.send({ responsesRequest: {} });
      await h.openrouter.embeddings.generate({ requestBody: {} });
    });
    const records = await h.records();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.attribution.account_id)).toEqual([
      'acct_all',
      'acct_all',
    ]);
  });
});

describe('an unresolved environment', () => {
  it('skips the record, says so once per call, and still makes the native call', async () => {
    const h = harness({ attributionDefaults: undefined });
    const native = chatResult();
    h.fake.answer('chat.send', native);
    expect(await h.openrouter.chat.send(CHAT as never)).toBe(native);
    expect(h.fake.calls.map((call) => call.key)).toEqual(['chat.send']);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: ATTRIBUTION_UNRESOLVED (operation=chat.send)',
    ]);
  });

  it('does not make a lookup or read the result', async () => {
    const h = harness({ attributionDefaults: undefined });
    h.fake.answer('chat.send', chatResult({ openrouterMetadata: undefined }));
    await h.openrouter.chat.send(CHAT);
    expect(h.fake.lookups).toHaveLength(0);
  });

  it('is resolved by a scope that supplies the environment', async () => {
    const h = answered({ attributionDefaults: undefined });
    await withAudr({ attribution: { environment: 'staging' } }, () =>
      h.openrouter.chat.send(CHAT as never),
    );
    expect((await h.records())[0]?.attribution.environment).toBe('staging');
    expect(h.logger.lines).toEqual([]);
  });

  it('skips a streamed call too, without wrapping its stream', async () => {
    const h = harness({ attributionDefaults: undefined });
    const stream = new ReadableStream();
    h.fake.answer('chat.send', stream);
    expect(await h.openrouter.chat.send(CHAT as never)).toBe(stream);
  });
});

describe('withAudr', () => {
  it('returns exactly what the body returns', () => {
    const value = { marker: true };
    expect(withAudr({}, () => value)).toBe(value);
    const promise = Promise.resolve(value);
    expect(withAudr({}, () => promise)).toBe(promise);
  });

  it('propagates an exception from the body', () => {
    const failure = new Error('from body');
    expect(() =>
      withAudr({}, () => {
        throw failure;
      }),
    ).toThrow(failure);
  });

  it('ignores a context that cannot be read, and runs the body under the outer scope', async () => {
    const h = answered();
    const hostile = {
      get attribution(): never {
        throw new RangeError('private value');
      },
    };
    await withAudr({ attribution: { account_id: 'outer' } }, () =>
      withAudr(hostile, () => h.openrouter.chat.send(CHAT as never)),
    );
    expect((await h.records())[0]?.attribution.account_id).toBe('outer');
    expect(h.logger.lines).toEqual([]);
  });
});

describe('mergeAttribution', () => {
  it('prefers defined override fields and ignores undefined ones', () => {
    expect(
      mergeAttribution(
        { environment: 'staging', account_id: 'base' },
        { environment: undefined, account_id: 'over' },
      ),
    ).toEqual({
      environment: 'staging',
      account_id: 'over',
      subscription_id: undefined,
      user_id: undefined,
      labels: undefined,
    });
  });

  it('does not alias the label objects of its inputs', () => {
    const base = { labels: { a: '1' } };
    const merged = mergeAttribution(base, { labels: { b: '2' } });
    expect(merged.labels).toEqual({ a: '1', b: '2' });
    expect(base.labels).toEqual({ a: '1' });
  });
});
