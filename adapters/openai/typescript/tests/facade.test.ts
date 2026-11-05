import { ConfigurationError } from '@openaudr/audr';
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { instrumentOpenAI, type OpenAILike } from '../src/index.js';
import {
  CHAT_PARAMS,
  chatCompletion,
  embedding,
  EMBEDDINGS_PARAMS,
  FakeApi,
  harness,
  nativeClient,
  recordingClient,
  response,
  RESPONSES_PARAMS,
} from './helpers.js';

describe('facade', () => {
  it('keeps the native type and forwards every other resource', async () => {
    const h = harness();
    expect(h.openai).toBeInstanceOf(OpenAI);
    expect(h.openai.baseURL).toBe('https://api.openai.com/v1');
    h.fake.json({ object: 'list', data: [] });
    await h.openai.models.list();
    expect(h.fake.requests.map((r) => r.path)).toEqual(['/models']);
    expect(typeof h.openai.chat.completions.stream).toBe('function');
    expect('files' in h.openai).toBe(true);
    expect(await h.records()).toEqual([]);
  });

  it('never modifies the native client', async () => {
    const h = harness();
    const before = {
      chat: h.native.chat,
      completions: h.native.chat.completions,
      responses: h.native.responses,
      embeddings: h.native.embeddings,
    };
    h.fake.json(chatCompletion()).json(chatCompletion());
    await h.native.chat.completions.create(CHAT_PARAMS);
    expect(h.native.chat).toBe(before.chat);
    expect(h.native.chat.completions).toBe(before.completions);
    expect(h.native.responses).toBe(before.responses);
    expect(h.native.embeddings).toBe(before.embeddings);
    expect(await h.records()).toEqual([]);
    await h.openai.chat.completions.create(CHAT_PARAMS);
    expect(await h.records()).toHaveLength(1);
  });

  it('sends exactly the request the native client sends', async () => {
    const h = harness();
    const params = { ...CHAT_PARAMS, temperature: 0.2, user: 'u_1', metadata: { team: 'x' } };
    h.fake
      .json(chatCompletion())
      .json(chatCompletion())
      .json(response())
      .json(response())
      .json(embedding())
      .json(embedding());
    await h.native.chat.completions.create(params);
    await h.openai.chat.completions.create(params);
    await h.native.responses.create(RESPONSES_PARAMS);
    await h.openai.responses.create(RESPONSES_PARAMS);
    await h.native.embeddings.create(EMBEDDINGS_PARAMS);
    await h.openai.embeddings.create(EMBEDDINGS_PARAMS);
    const [a, b, c, d, e, f] = h.fake.requests;
    expect(b).toEqual(a);
    expect(d).toEqual(c);
    expect(f).toEqual(e);
  });

  it('passes every argument to the native create()', async () => {
    const options = { headers: { 'X-Request-Source': 'draft' } };
    const native = {
      baseURL: 'https://api.openai.com/v1',
      chat: {
        completions: {
          create: vi.fn<(params: unknown, opts?: typeof options) => Promise<unknown>>(() =>
            Promise.resolve(chatCompletion()),
          ),
        },
      },
      responses: {
        create: vi.fn<(params: unknown, opts?: typeof options) => Promise<unknown>>(() =>
          Promise.resolve(response()),
        ),
      },
      embeddings: {
        create: vi.fn<(params: unknown, opts?: typeof options) => Promise<unknown>>(() =>
          Promise.resolve(embedding()),
        ),
      },
    };
    const client = recordingClient();
    const openai = instrumentOpenAI(native, {
      client,
      attributionDefaults: { environment: 'test' },
    });
    await openai.chat.completions.create(CHAT_PARAMS, options);
    await openai.responses.create(RESPONSES_PARAMS, options);
    await openai.embeddings.create(EMBEDDINGS_PARAMS, options);
    expect(native.chat.completions.create.mock.calls).toEqual([[CHAT_PARAMS, options]]);
    expect(native.chat.completions.create.mock.contexts).toEqual([native.chat.completions]);
    expect(native.responses.create.mock.calls).toEqual([[RESPONSES_PARAMS, options]]);
    expect(native.embeddings.create.mock.calls[0]![1]).toBe(options);
    expect(client.submitted).toHaveLength(3);
  });

  it('returns the native response object itself', async () => {
    const h = harness();
    const body = chatCompletion();
    h.fake.json(body);
    expect(await h.openai.chat.completions.create(CHAT_PARAMS)).toEqual(body);
  });

  it('meters a client without a baseURL only through mapResource', async () => {
    const native: OpenAILike = {
      chat: { completions: { create: () => Promise.resolve(chatCompletion()) } },
      responses: { create: () => Promise.resolve(response()) },
      embeddings: { create: () => Promise.resolve(embedding()) },
    };
    const client = recordingClient();
    const openai = instrumentOpenAI(native, {
      client,
      attributionDefaults: { environment: 'test' },
      mapResource: ({ baseUrl, model }) =>
        baseUrl === undefined && model ? { provider: 'vllm', name: model } : null,
    });
    await openai.chat.completions.create(CHAT_PARAMS);
    expect(client.submitted[0]!.resource).toMatchObject({ provider: 'vllm' });
  });
});

describe('configuration', () => {
  it('requires a client with record()', () => {
    expect(() => instrumentOpenAI(nativeClient(), { client: {} as never })).toThrow(
      new ConfigurationError('client must implement record()'),
    );
  });
});

describe('double instrumentation', () => {
  it('refuses to instrument a facade twice', () => {
    const facade = instrumentOpenAI(nativeClient(), { client: recordingClient() });
    expect(() => instrumentOpenAI(facade, { client: recordingClient() })).toThrow(
      new ConfigurationError('openai is already instrumented'),
    );
  });

  it('lets one native client back several facades', async () => {
    const fake = new FakeApi();
    vi.stubGlobal('fetch', fake.fetch);
    const native = nativeClient();
    const first = recordingClient();
    const second = recordingClient();
    const options = { attributionDefaults: { environment: 'test' } } as const;
    const a = instrumentOpenAI(native, { client: first, ...options });
    const b = instrumentOpenAI(native, { client: second, ...options });
    fake.json(chatCompletion()).json(chatCompletion());
    await a.chat.completions.create(CHAT_PARAMS);
    await b.chat.completions.create(CHAT_PARAMS);
    expect([first.submitted.length, second.submitted.length]).toEqual([1, 1]);
  });
});

describe('host owns the client', () => {
  it('only ever calls record()', async () => {
    const fake = new FakeApi();
    vi.stubGlobal('fetch', fake.fetch);
    const client = {
      record: vi.fn(() => ({ outcome: 'queued', queued: true, issues: [] })),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const openai = instrumentOpenAI(nativeClient(), {
      client: client as never,
      attributionDefaults: { environment: 'test' },
    });
    fake.json(chatCompletion()).json(response()).json(embedding());
    await openai.chat.completions.create(CHAT_PARAMS);
    await openai.responses.create(RESPONSES_PARAMS);
    await openai.embeddings.create(EMBEDDINGS_PARAMS);
    expect(client.record).toHaveBeenCalledTimes(3);
    expect(client.flush).not.toHaveBeenCalled();
    expect(client.shutdown).not.toHaveBeenCalled();
  });
});
