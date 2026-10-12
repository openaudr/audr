import { ConfigurationError } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { instrumentOpenRouter } from '../src/index.js';
import {
  chatResult,
  embeddingsResult,
  FakeOpenRouter,
  harness,
  recordingClient,
  responsesResult,
} from './helpers.js';

const CHAT = { chatRequest: { model: 'anthropic/claude-sonnet-4.5', messages: [] } };
const RESPONSES = { responsesRequest: { model: 'anthropic/claude-sonnet-4.5', input: 'hi' } };
const EMBEDDINGS = { requestBody: { model: 'openai/text-embedding-3-small', input: 'hi' } };

describe('the facade', () => {
  it('passes every argument to the native method unchanged and returns its result', async () => {
    const h = harness();
    const chat = chatResult();
    const responses = responsesResult();
    const embeddings = embeddingsResult();
    h.fake
      .answer('chat.send', chat)
      .answer('responses.send', responses)
      .answer('embeddings.generate', embeddings)
      .answer('generations.getGeneration', { data: {} });
    const options = { timeoutMs: 1234 };
    const request = structuredClone(CHAT);

    expect(await h.openrouter.chat.send(request as never, options)).toBe(chat);
    expect(await h.openrouter.responses.send(RESPONSES as never)).toBe(responses);
    expect(await h.openrouter.embeddings.generate(EMBEDDINGS as never, options)).toBe(embeddings);

    const [first, second, third] = h.fake.calls;
    expect(first?.args[0]).toBe(request);
    expect(first?.args[1]).toBe(options);
    expect(request).toEqual(CHAT);
    expect(second?.args).toEqual([RESPONSES]);
    expect(third?.args[1]).toBe(options);
  });

  it('runs the native method on the native resource', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult());
    await h.openrouter.chat.send(CHAT);
    expect(h.fake.calls[0]?.receiver).toBe(h.fake.chat);
  });

  it('forwards every other member bound to the native client', async () => {
    const h = harness();
    expect(h.openrouter.apiKey).toBe('sk-or-test');
    expect(h.openrouter.describe()).toBe('client:sk-or-test');
    h.fake.answer('models.count', 3);
    expect(await h.openrouter.models.count()).toBe(3);
    expect(h.fake.calls[0]?.receiver).toBe(h.fake.models);
  });

  it('leaves the native client and its resources unmodified', () => {
    const fake = new FakeOpenRouter();
    const before = {
      chat: fake.chat,
      responses: fake.responses,
      embeddings: fake.embeddings,
      send: fake.chat.send,
      keys: Object.keys(fake),
      chatKeys: Object.keys(fake.chat),
    };
    instrumentOpenRouter(fake, {
      client: recordingClient(),
      attributionDefaults: { environment: 'test' },
    });
    expect(fake.chat).toBe(before.chat);
    expect(fake.responses).toBe(before.responses);
    expect(fake.embeddings).toBe(before.embeddings);
    expect(fake.chat.send).toBe(before.send);
    expect(Object.keys(fake)).toEqual(before.keys);
    expect(Object.keys(fake.chat)).toEqual(before.chatKeys);
  });

  it('rejects a second instrumentation of a facade', () => {
    const h = harness();
    expect(() => instrumentOpenRouter(h.openrouter, { client: h.client })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a client that cannot record', () => {
    expect(() => instrumentOpenRouter(new FakeOpenRouter(), { client: {} as never })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      instrumentOpenRouter(new FakeOpenRouter(), { client: undefined as never }),
    ).toThrow(ConfigurationError);
  });

  it('instruments one native client twice as two independent facades', async () => {
    const fake = new FakeOpenRouter();
    const first = recordingClient();
    const second = recordingClient();
    const a = instrumentOpenRouter(fake, {
      client: first,
      attributionDefaults: { environment: 'test' },
    });
    const b = instrumentOpenRouter(fake, {
      client: second,
      attributionDefaults: { environment: 'test' },
    });
    fake.answer('chat.send', chatResult()).answer('chat.send', chatResult());
    await a.chat.send(CHAT);
    await b.chat.send(CHAT);
    expect(first.submitted).toHaveLength(1);
    expect(second.submitted).toHaveLength(1);
  });
});

describe('a native rejection', () => {
  it('propagates unchanged and is not logged', async () => {
    const h = harness();
    const failure = new Error('429 from upstream');
    h.fake
      .fail('chat.send', failure)
      .fail('responses.send', failure)
      .fail('embeddings.generate', failure);
    await expect(h.openrouter.chat.send(CHAT as never)).rejects.toBe(failure);
    await expect(h.openrouter.responses.send(RESPONSES as never)).rejects.toBe(failure);
    await expect(h.openrouter.embeddings.generate(EMBEDDINGS as never)).rejects.toBe(failure);
    expect(await h.records()).toEqual([]);
    expect(h.logger.lines).toEqual([]);
    expect(h.fake.lookups).toHaveLength(0);
  });

  it('propagates a synchronous throw from the native method', async () => {
    const failure = new TypeError('thrown before a promise exists');
    const fake = new FakeOpenRouter();
    const native = Object.assign(Object.create(fake) as FakeOpenRouter, {
      chat: {
        send: () => {
          throw failure;
        },
      },
    });
    const facade = instrumentOpenRouter(native, {
      client: recordingClient(),
      attributionDefaults: { environment: 'test' },
    });
    await expect(facade.chat.send(CHAT as never)).rejects.toBe(failure);
  });
});
