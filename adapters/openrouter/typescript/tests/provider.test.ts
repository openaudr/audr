import { describe, expect, it } from 'vitest';

import { providerSlug, readRouter } from '../src/mapping.js';
import {
  chatResult,
  chatUsage,
  generation,
  GENERATION_ID,
  harness,
  LLM,
  responsesResult,
  routerMetadata,
} from './helpers.js';

const REQUEST = { chatRequest: { model: 'anthropic/claude-sonnet-4.5', messages: [] } };

/** A Chat result whose metadata is absent, so the lookup must name the vendor. */
const BARE = chatResult({ openrouterMetadata: undefined });

describe('the serving vendor', () => {
  it('comes from the selected endpoint of router metadata, with no lookup', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult({ openrouterMetadata: routerMetadata('Google Vertex') }));
    await h.openrouter.chat.send(REQUEST);
    const [record] = await h.records();
    expect(record?.resource.provider).toBe('google-vertex');
    expect(h.fake.lookups).toHaveLength(0);
  });

  it('is never inferred from the model author', async () => {
    const h = harness();
    h.fake
      .answer(
        'chat.send',
        chatResult({ model: 'anthropic/claude-sonnet-4.5', openrouterMetadata: undefined }),
      )
      .answer('generations.getGeneration', generation({ providerName: 'Amazon Bedrock' }));
    await h.openrouter.chat.send(REQUEST);
    const [record] = await h.records();
    expect(record?.resource.provider).toBe('amazon-bedrock');
    expect(record?.resource.name).toBe('anthropic/claude-sonnet-4.5');
  });

  it('is looked up when metadata lists endpoints but none is selected', async () => {
    const h = harness();
    const metadata = routerMetadata('Anthropic');
    h.fake
      .answer(
        'chat.send',
        chatResult({
          openrouterMetadata: {
            ...metadata,
            endpoints: {
              available: [{ model: 'm', provider: 'Anthropic', selected: false }],
              total: 1,
            },
          },
        }),
      )
      .answer('generations.getGeneration', generation({ providerName: 'Google' }));
    await h.openrouter.chat.send(REQUEST);
    expect((await h.records())[0]?.resource.provider).toBe('google');
    expect(h.fake.lookups).toHaveLength(1);
  });

  it('is looked up when the selected endpoint names no provider', async () => {
    const h = harness();
    h.fake
      .answer(
        'chat.send',
        chatResult({
          openrouterMetadata: routerMetadata('', {}),
        }),
      )
      .answer('generations.getGeneration', generation({ providerName: 'Together' }));
    await h.openrouter.chat.send(REQUEST);
    expect((await h.records())[0]?.resource.provider).toBe('together');
  });

  it('takes the first selected endpoint', async () => {
    const h = harness();
    h.fake.answer(
      'chat.send',
      chatResult({
        openrouterMetadata: routerMetadata('First', {
          endpoints: {
            available: [
              { model: 'm', provider: 'First', selected: true },
              { model: 'm', provider: 'Second', selected: true },
            ],
            total: 2,
          },
        }),
      }),
    );
    await h.openrouter.chat.send(REQUEST);
    expect((await h.records())[0]?.resource.provider).toBe('first');
  });

  it('is openrouter for a response-cache replay, which no upstream vendor served', async () => {
    const h = harness();
    h.fake
      .answer('chat.send', BARE)
      .answer(
        'generations.getGeneration',
        generation({ providerName: 'Amazon Bedrock', responseCacheSourceId: 'gen-original' }),
      );
    await h.openrouter.chat.send(REQUEST);
    const [record] = await h.records();
    expect(record?.resource.provider).toBe('openrouter');
    expect(record?.resource.name).toBe('anthropic/claude-sonnet-4.5');
  });

  it('is openrouter for a replay even when router metadata also named a vendor, once looked up', async () => {
    const h = harness();
    h.fake
      .answer(
        'chat.send',
        chatResult({
          usage: chatUsage({ isByok: undefined }),
          openrouterMetadata: routerMetadata('Anthropic', { isByok: undefined }),
        }),
      )
      .answer('generations.getGeneration', generation({ responseCacheSourceId: 'gen-original' }));
    await h.openrouter.chat.send(REQUEST);
    expect((await h.records())[0]?.resource.provider).toBe('openrouter');
  });

  it('is openrouter, with a value-free warning, when it stays unresolved', async () => {
    const h = harness();
    h.fake
      .answer('chat.send', BARE)
      .answer('generations.getGeneration', generation({ providerName: null }));
    await h.openrouter.chat.send(REQUEST);
    const records = await h.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.resource).toMatchObject({
      provider: 'openrouter',
      name: 'anthropic/claude-sonnet-4.5',
    });
    expect(records[0]?.usage.llm).toEqual(LLM);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: PROVIDER_UNRESOLVED (operation=chat.send)',
    ]);
  });

  it('is openrouter for a vendor name that has no slug', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult({ openrouterMetadata: routerMetadata('日本語') }));
    await h.openrouter.chat.send(REQUEST);
    expect((await h.records())[0]?.resource.provider).toBe('openrouter');
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: PROVIDER_UNRESOLVED (operation=chat.send)',
    ]);
  });

  it('is openrouter, and the log says why, when the lookup fails', async () => {
    const h = harness();
    h.fake.answer('chat.send', BARE).fail('generations.getGeneration', { statusCode: 401 });
    await h.openrouter.chat.send(REQUEST);
    expect((await h.records())[0]?.resource.provider).toBe('openrouter');
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: LOOKUP_FAILED (operation=chat.send, reason=rejected)',
      '@openaudr/audr-adapter-openrouter: PROVIDER_UNRESOLVED (operation=chat.send)',
    ]);
  });

  it('is not looked up at all when lookups are disabled and metadata is absent', async () => {
    const h = harness({ lookup: { maxWaitMs: 0 } });
    h.fake.answer('chat.send', BARE);
    await h.openrouter.chat.send(REQUEST);
    expect(h.fake.lookups).toHaveLength(0);
    expect((await h.records())[0]?.resource.provider).toBe('openrouter');
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: LOOKUP_FAILED (operation=chat.send, reason=disabled)',
      '@openaudr/audr-adapter-openrouter: PROVIDER_UNRESOLVED (operation=chat.send)',
    ]);
  });

  it('reads only the four generation fields, and never the rest of the response', async () => {
    const h = harness();
    const reads: string[] = [];
    const data = new Proxy(generation().data as Record<string, unknown>, {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    h.fake.answer('chat.send', BARE).answer('generations.getGeneration', { data });
    await h.openrouter.chat.send(REQUEST);
    expect(new Set(reads)).toEqual(
      new Set(['providerName', 'responseCacheSourceId', 'isByok', 'upstreamInferenceCost']),
    );
  });
});

describe('resource mapping', () => {
  it('receives the model and the raw served vendor, and may override both', async () => {
    const seen: unknown[] = [];
    const h = harness({
      mapResource: (source) => {
        seen.push(source);
        return { provider: 'bedrock', name: 'claude-sonnet-4.5' };
      },
    });
    h.fake.answer('chat.send', BARE).answer('generations.getGeneration', generation());
    await h.openrouter.chat.send(REQUEST);
    const [record] = await h.records();
    expect(seen).toEqual([{ model: 'anthropic/claude-sonnet-4.5', vendor: 'Amazon Bedrock' }]);
    expect(record?.resource).toMatchObject({ provider: 'bedrock', name: 'claude-sonnet-4.5' });
  });

  it('receives openrouter as the vendor of a response-cache replay', async () => {
    const seen: unknown[] = [];
    const h = harness({
      mapResource: (source) => {
        seen.push(source);
        return undefined;
      },
    });
    h.fake
      .answer('chat.send', BARE)
      .answer('generations.getGeneration', generation({ responseCacheSourceId: 'gen-x' }));
    await h.openrouter.chat.send(REQUEST);
    expect(seen).toEqual([{ model: 'anthropic/claude-sonnet-4.5', vendor: 'openrouter' }]);
  });

  it('receives no vendor when none was resolved, and may still supply one', async () => {
    const seen: unknown[] = [];
    const h = harness({
      lookup: { maxWaitMs: 0 },
      mapResource: (source) => {
        seen.push(source);
        return undefined;
      },
    });
    h.fake.answer('chat.send', BARE);
    await h.openrouter.chat.send(REQUEST);
    expect(seen).toEqual([{ model: 'anthropic/claude-sonnet-4.5', vendor: undefined }]);
    expect((await h.records())[0]?.resource.provider).toBe('openrouter');
  });

  it.each([undefined, null])('keeps the defaults when it returns %s', async (returned) => {
    const h = harness({ mapResource: () => returned });
    h.fake.answer('chat.send', chatResult());
    await h.openrouter.chat.send(REQUEST);
    expect((await h.records())[0]?.resource).toMatchObject({
      provider: 'amazon-bedrock',
      name: 'anthropic/claude-sonnet-4.5',
    });
  });

  it('can supply a missing vendor, and then nothing is logged about it', async () => {
    const h = harness({
      lookup: { maxWaitMs: 0 },
      mapResource: ({ model }) => ({ provider: 'anthropic', name: model ?? 'unknown' }),
    });
    h.fake.answer('chat.send', BARE);
    await h.openrouter.chat.send(REQUEST);
    expect((await h.records())[0]?.resource.provider).toBe('anthropic');
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: LOOKUP_FAILED (operation=chat.send, reason=disabled)',
    ]);
  });

  it('skips a result that names no model unless the mapping does', async () => {
    const h = harness();
    h.fake.answer('responses.send', responsesResult({ model: undefined }));
    await h.openrouter.responses.send({ responsesRequest: {} });
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: MODEL_UNREPORTED (operation=responses.send)',
    ]);

    const mapped = harness({ mapResource: () => ({ provider: 'anthropic', name: 'claude' }) });
    mapped.fake.answer('responses.send', responsesResult({ model: undefined }));
    await mapped.openrouter.responses.send({ responsesRequest: {} });
    expect((await mapped.records())[0]?.resource.name).toBe('claude');
  });

  it('leaves a mapped provider that is not a slug to the Client to reject', async () => {
    const h = harness({ mapResource: () => ({ provider: 'Not A Slug', name: 'm' }) });
    h.fake.answer('chat.send', chatResult());
    await h.openrouter.chat.send(REQUEST);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings[0]).toMatch(/RECORD_NOT_QUEUED \(outcome=rejected_invalid/);
  });
});

describe('provider slugs', () => {
  it.each([
    ['Amazon Bedrock', 'amazon-bedrock'],
    ['Google Vertex', 'google-vertex'],
    ['OpenAI', 'openai'],
    ['Anthropic', 'anthropic'],
    ['amazon-bedrock', 'amazon-bedrock'],
    ['  Fireworks  ', 'fireworks'],
    ['Z.AI', 'z-ai'],
    ['Together  AI', 'together-ai'],
    ['AI21!!Labs', 'ai21-labs'],
    ['google-vertex/europe', 'google-vertex-europe'],
  ])('%s becomes %s', (name, slug) => {
    expect(providerSlug(name)).toBe(slug);
  });

  it.each(['', '   ', '---', '日本語', '!!'])('%j has no slug', (name) => {
    expect(providerSlug(name)).toBeUndefined();
  });
});

describe('router metadata', () => {
  it.each([
    ['nothing', undefined],
    ['a non-object', 'metadata'],
    ['no endpoints', {}],
    ['endpoints without a list', { endpoints: { available: 'x' } }],
  ])('%s names no vendor', (_name, metadata) => {
    expect(readRouter(metadata)?.provider).toBeUndefined();
  });

  it('ignores entries that are not objects', () => {
    expect(
      readRouter({
        endpoints: { available: [null, 'x', { provider: 'Anthropic', selected: true }] },
      })?.provider,
    ).toBe('Anthropic');
  });

  it('reads the BYOK flag only when it is a boolean', () => {
    expect(readRouter({ isByok: true })?.isByok).toBe(true);
    expect(readRouter({ isByok: 'yes' })?.isByok).toBeUndefined();
  });
});

describe('the lookup id', () => {
  it('is the result id, passed through exactly', async () => {
    const h = harness();
    h.fake
      .answer('chat.send', chatResult({ id: GENERATION_ID, openrouterMetadata: undefined }))
      .answer('generations.getGeneration', generation());
    await h.openrouter.chat.send(REQUEST);
    expect(h.fake.lookups[0]?.args[0]).toStrictEqual({ id: GENERATION_ID });
  });
});
