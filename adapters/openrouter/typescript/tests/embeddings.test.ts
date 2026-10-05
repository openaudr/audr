import { describe, expect, it } from 'vitest';

import {
  embeddingsResult,
  generation,
  GENERATION_ID,
  harness,
  recordingClient,
} from './helpers.js';
import { instrumentOpenRouter } from '../src/index.js';
import { FakeOpenRouter } from './helpers.js';

const REQUEST = { requestBody: { model: 'openai/text-embedding-3-small', input: 'hi' } };

async function embed(
  result: unknown,
  looked: Record<string, unknown> | Error = generation({ providerName: 'OpenAI' }),
) {
  const h = harness();
  h.fake.answer('embeddings.generate', result);
  if (looked instanceof Error) h.fake.fail('generations.getGeneration', looked);
  else h.fake.answer('generations.getGeneration', looked);
  await h.openrouter.embeddings.generate(REQUEST);
  return { h, records: await h.records() };
}

describe('embeddings.generate()', () => {
  it('records one embedding, naming the vendor through the lookup', async () => {
    const { h, records } = await embed(embeddingsResult());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      resource: {
        provider: 'openai',
        type: 'model',
        name: 'openai/text-embedding-3-small',
        operation: 'embedding',
        modality: 'text',
      },
      usage: { llm: { input_tokens: 8, requests: 1 } },
      cost: { total_cost: 0.00000016, currency: 'USD' },
      run: {
        run_id: GENERATION_ID,
        span_id: `embedding:${GENERATION_ID}`,
        run_type: 'single_call',
      },
    });
    expect(records[0]?.cost).not.toHaveProperty('llm');
    expect(h.fake.lookups[0]?.args[0]).toEqual({ id: GENERATION_ID });
    expect(h.logger.lines).toEqual([]);
  });

  it('records an embedding result with no id as openrouter and says why', async () => {
    const { h, records } = await embed(embeddingsResult({ id: undefined }));
    expect(records).toHaveLength(1);
    expect(records[0]?.resource).toMatchObject({
      provider: 'openrouter',
      name: 'openai/text-embedding-3-small',
    });
    expect(records[0]?.run.run_id).toMatch(/^.{8,64}$/);
    expect(h.fake.lookups).toHaveLength(0);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: LOOKUP_FAILED (operation=embeddings.generate, reason=no_id)',
      '@openaudr/audr-adapter-openrouter: PROVIDER_UNRESOLVED (operation=embeddings.generate)',
    ]);
  });

  it('records an id-less result once mapResource names the vendor', async () => {
    const h = harness({
      mapResource: () => ({ provider: 'openai', name: 'text-embedding-3-small' }),
    });
    h.fake.answer('embeddings.generate', embeddingsResult({ id: undefined }));
    await h.openrouter.embeddings.generate(REQUEST);
    const [record] = await h.records();
    expect(record?.resource).toMatchObject({ provider: 'openai', name: 'text-embedding-3-small' });
    expect(record?.run.run_id).toMatch(/^.{8,64}$/);
    expect(record?.run.span_id).toMatch(/^embedding:.+/);
  });

  it('skips a string result, which is what the SDK returns for a raw body', async () => {
    const { h, records } = await embed('data: not a parsed body');
    expect(records).toEqual([]);
    expect(h.fake.lookups).toHaveLength(0);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: USAGE_UNREPORTED (operation=embeddings.generate)',
    ]);
  });

  it('skips a result with no usage', async () => {
    const { h, records } = await embed(embeddingsResult({ usage: undefined }));
    expect(records).toEqual([]);
    expect(h.logger.warnings).toHaveLength(1);
  });

  it('omits an input count the result does not report', async () => {
    const { records } = await embed(
      embeddingsResult({ usage: { totalTokens: 0, cost: 0, isByok: false } }),
    );
    expect(records[0]?.usage.llm).toEqual({ requests: 1 });
    expect(records[0]?.cost?.total_cost).toBe(0);
  });

  it('keeps an explicit zero input count', async () => {
    const { records } = await embed(
      embeddingsResult({ usage: { promptTokens: 0, cost: 0, isByok: false } }),
    );
    expect(records[0]?.usage.llm).toEqual({ input_tokens: 0, requests: 1 });
  });

  const modalities: readonly [string, Record<string, number>, string][] = [
    ['text tokens', { textTokens: 8 }, 'text'],
    ['no details', {}, 'text'],
    ['image tokens alone', { imageTokens: 8 }, 'image'],
    ['audio tokens alone', { audioTokens: 8 }, 'audio'],
    ['text and image tokens', { textTokens: 4, imageTokens: 4 }, 'multimodal'],
    ['video tokens', { textTokens: 4, videoTokens: 4 }, 'multimodal'],
    ['file tokens', { fileTokens: 4 }, 'multimodal'],
    ['zero image tokens', { textTokens: 8, imageTokens: 0 }, 'text'],
  ];

  it.each(modalities)('modality from %s', async (_name, promptTokensDetails, expected) => {
    const { records } = await embed(
      embeddingsResult({
        usage: { promptTokens: 8, cost: 0, isByok: false, promptTokensDetails },
      }),
    );
    expect(records[0]?.resource.modality).toBe(expected);
  });

  it('is metered by a facade whose client never sees a non-object result', async () => {
    const fake = new FakeOpenRouter().answer('embeddings.generate', null);
    const client = recordingClient();
    const facade = instrumentOpenRouter(fake, {
      client,
      attributionDefaults: { environment: 'test' },
    });
    expect(await facade.embeddings.generate(REQUEST as never)).toBeNull();
    expect(client.submitted).toEqual([]);
  });
});
