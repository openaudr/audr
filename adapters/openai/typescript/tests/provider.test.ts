import { AzureOpenAI } from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { instrumentOpenAI } from '../src/index.js';
import {
  CHAT_PARAMS,
  chatCompletion,
  embedding,
  EMBEDDINGS_PARAMS,
  FakeApi,
  harness,
  recordingClient,
} from './helpers.js';

describe('provider from the client baseURL', () => {
  it.each([
    ['https://api.openai.com/v1', 'openai'],
    ['https://api.groq.com/openai/v1', 'groq'],
    ['https://api.mistral.ai/v1', 'mistral'],
    ['https://api.together.xyz/v1', 'together'],
    ['https://api.fireworks.ai/inference/v1', 'fireworks'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://my-resource.openai.azure.com/openai/v1', 'azure-openai'],
    ['https://my-resource.services.ai.azure.com/models', 'azure-openai'],
  ])('%s is %s', async (baseURL, provider) => {
    const h = harness({}, { baseURL });
    h.fake.json(chatCompletion());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    const [record] = await h.records();
    expect(record!.resource).toMatchObject({ provider, name: 'gpt-5.4-2026-03-01' });
    expect(record!.resource.deployment).toBeUndefined();
    expect(h.fake.requests[0]!.url.startsWith(baseURL)).toBe(true);
  });

  it.each(['http://localhost:11434/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:11434/v1'])(
    '%s is a self-hosted ollama endpoint',
    async (baseURL) => {
      const h = harness({}, { baseURL });
      h.fake.json(chatCompletion({ model: 'llama3.2' }));
      await h.openai.chat.completions.create({ ...CHAT_PARAMS, model: 'llama3.2' });
      const [record] = await h.records();
      expect(record!.resource).toMatchObject({
        provider: 'ollama',
        name: 'llama3.2',
        deployment: 'self-hosted',
      });
    },
  );

  it('names Azure from the AzureOpenAI client', async () => {
    const fake = new FakeApi();
    vi.stubGlobal('fetch', fake.fetch);
    const client = recordingClient();
    const azure = instrumentOpenAI(
      new AzureOpenAI({
        apiKey: 'azure-test',
        apiVersion: '2025-04-01-preview',
        endpoint: 'https://my-resource.openai.azure.com',
        deployment: 'gpt-5-4',
      }),
      { client, attributionDefaults: { environment: 'test' } },
    );
    fake.json(chatCompletion({ model: 'gpt-5.4' }));
    await azure.chat.completions.create({ ...CHAT_PARAMS, model: 'gpt-5-4' });
    expect(client.submitted[0]!.resource).toMatchObject({
      provider: 'azure-openai',
      name: 'gpt-5.4',
    });
  });

  it('skips a host it does not know rather than guessing', async () => {
    const h = harness({}, { baseURL: 'https://llm.example.internal/v1' });
    const body = chatCompletion();
    h.fake.json(body);
    expect(await h.openai.chat.completions.create(CHAT_PARAMS)).toEqual(body);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openai: PROVIDER_UNRESOLVED (operation=chat.completions.create)',
    ]);
  });

  it('does not match a lookalike host', async () => {
    const h = harness({}, { baseURL: 'https://api.openai.com.example.net/v1' });
    h.fake.json(chatCompletion());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toHaveLength(1);
  });
});

describe('mapResource', () => {
  it('receives the baseURL and the served model', async () => {
    const mapResource = vi.fn(({ model }: { model: string | undefined }) =>
      model ? { provider: 'databricks', name: model } : null,
    );
    const h = harness(
      { mapResource },
      { baseURL: 'https://adb-1.azuredatabricks.net/serving-endpoints' },
    );
    h.fake.json(chatCompletion({ model: 'databricks-llama-4' })).json(embedding());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    await h.openai.embeddings.create(EMBEDDINGS_PARAMS);
    expect(mapResource.mock.calls).toEqual([
      [
        {
          baseUrl: 'https://adb-1.azuredatabricks.net/serving-endpoints',
          model: 'databricks-llama-4',
        },
      ],
      [
        {
          baseUrl: 'https://adb-1.azuredatabricks.net/serving-endpoints',
          model: 'text-embedding-3-small',
        },
      ],
    ]);
    const [generation, embed] = await h.records();
    expect(generation!.resource).toMatchObject({
      provider: 'databricks',
      name: 'databricks-llama-4',
    });
    expect(embed!.resource).toMatchObject({
      provider: 'databricks',
      name: 'text-embedding-3-small',
    });
  });

  it('keeps the default when mapResource returns nothing', async () => {
    const h = harness({ mapResource: () => undefined });
    h.fake.json(chatCompletion());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    const [record] = await h.records();
    expect(record!.resource).toMatchObject({ provider: 'openai', name: 'gpt-5.4-2026-03-01' });
  });

  it('keeps the self-hosted deployment under a mapped provider', async () => {
    const h = harness(
      { mapResource: ({ model }) => (model ? { provider: 'vllm', name: model } : null) },
      { baseURL: 'http://localhost:8000/v1' },
    );
    h.fake.json(chatCompletion());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    const [record] = await h.records();
    expect(record!.resource).toMatchObject({ provider: 'vllm', deployment: 'self-hosted' });
  });

  it('skips the record when mapResource throws', async () => {
    const h = harness({
      mapResource: () => {
        throw new SyntaxError('host bug');
      },
    });
    h.fake.json(chatCompletion());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.errors).toEqual([
      '@openaudr/audr-adapter-openai: HOOK_FAILED (operation=chat.completions.create, error=SyntaxError)',
    ]);
  });

  it('leaves a mapped provider that is not a slug to the Client to reject', async () => {
    const h = harness({ mapResource: () => ({ provider: 'Open AI', name: 'gpt' }) });
    h.fake.json(chatCompletion());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toHaveLength(1);
    expect(h.logger.warnings[0]).toMatch(/RECORD_NOT_QUEUED .*issues=\w+@\/resource\/provider\)$/);
  });

  it('skips a response that names no model', async () => {
    const h = harness();
    h.fake.json(chatCompletion({ model: '' })).json(embedding({ model: undefined }));
    await h.openai.chat.completions.create(CHAT_PARAMS);
    await h.openai.embeddings.create(EMBEDDINGS_PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openai: MODEL_UNREPORTED (operation=chat.completions.create)',
      '@openaudr/audr-adapter-openai: MODEL_UNREPORTED (operation=embeddings.create)',
    ]);
  });

  it('lets mapResource name a model the response did not report', async () => {
    const h = harness({ mapResource: () => ({ provider: 'openai', name: 'gpt-5.4' }) });
    h.fake.json(chatCompletion({ model: undefined }));
    await h.openai.chat.completions.create(CHAT_PARAMS);
    const [record] = await h.records();
    expect(record!.resource).toMatchObject({ provider: 'openai', name: 'gpt-5.4' });
  });
});
