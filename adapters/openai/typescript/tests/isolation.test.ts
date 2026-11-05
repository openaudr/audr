import { type Client } from '@openaudr/audr';
import { describe, expect, it, vi } from 'vitest';

import { instrumentOpenAI, type OpenAILike } from '../src/index.js';
import {
  CapturingLogger,
  CHAT_PARAMS,
  chatChunks,
  chatCompletion,
  drain,
  FakeApi,
  harness,
  nativeClient,
  response,
} from './helpers.js';

const STREAM = { ...CHAT_PARAMS, stream: true, stream_options: { include_usage: true } } as const;

function openaiWith(client: Client, logger: CapturingLogger | { warn(): void; error(): void }) {
  const fake = new FakeApi();
  vi.stubGlobal('fetch', fake.fetch);
  const openai = instrumentOpenAI(nativeClient(), {
    client,
    logger,
    attributionDefaults: { environment: 'test' },
  });
  return { fake, openai };
}

/** A structural client whose every resource answers `result`. */
function stub(result: unknown): OpenAILike {
  return {
    baseURL: 'https://api.openai.com/v1',
    chat: { completions: { create: () => Promise.resolve(result) } },
    responses: { create: () => Promise.resolve(result) },
    embeddings: { create: () => Promise.resolve(result) },
  };
}

describe('metering never breaks a native call', () => {
  it('a client that throws is logged by class name only', async () => {
    const logger = new CapturingLogger();
    const client = {
      record: () => {
        throw new TypeError('client exploded with a value');
      },
    } as unknown as Client;
    const { fake, openai } = openaiWith(client, logger);
    const body = chatCompletion();
    fake.json(body).sse(chatChunks());
    expect(await openai.chat.completions.create(CHAT_PARAMS)).toEqual(body);
    expect(await drain(await openai.chat.completions.create(STREAM))).toHaveLength(3);
    expect(logger.errors).toEqual([
      '@openaudr/audr-adapter-openai: HOOK_FAILED (operation=chat.completions.create, error=TypeError)',
      '@openaudr/audr-adapter-openai: HOOK_FAILED (operation=chat.completions.create, error=TypeError)',
    ]);
  });

  it('never trusts a writable error name', async () => {
    const logger = new CapturingLogger();
    const failure = new Error('private value');
    failure.name = 'SENTINEL_PRIVATE_VALUE';
    const client = {
      record: () => {
        throw failure;
      },
    } as unknown as Client;
    const { fake, openai } = openaiWith(client, logger);
    fake.json(chatCompletion());
    await expect(openai.chat.completions.create(CHAT_PARAMS)).resolves.toBeDefined();
    expect(logger.errors).toEqual([
      '@openaudr/audr-adapter-openai: HOOK_FAILED (operation=chat.completions.create, error=Error)',
    ]);
    expect(logger.errors.join()).not.toContain('SENTINEL_PRIVATE_VALUE');
  });

  it('a logger that throws is ignored', async () => {
    const client = {
      record: () => {
        throw new TypeError('boom');
      },
    } as unknown as Client;
    const throwing = {
      warn: () => {
        throw new Error('logger');
      },
      error: () => {
        throw new Error('logger');
      },
    };
    const { fake, openai } = openaiWith(client, throwing);
    fake.json(chatCompletion()).sse(chatChunks().slice(0, 1));
    await expect(openai.chat.completions.create(CHAT_PARAMS)).resolves.toBeDefined();
    await expect(drain(await openai.chat.completions.create(STREAM))).resolves.toHaveLength(1);
  });

  it('logs nothing unless given a logger', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const native = stub(chatCompletion());
    try {
      const unattributed = instrumentOpenAI(native, {
        client: { record: () => ({ outcome: 'queued', queued: true, issues: [] }) } as never,
      });
      await unattributed.chat.completions.create(CHAT_PARAMS);

      const failing = instrumentOpenAI(native, {
        client: {
          record: () => {
            throw new TypeError('private value');
          },
        } as never,
        attributionDefaults: { environment: 'test' },
      });
      await failing.chat.completions.create(CHAT_PARAMS);

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('returns a result it cannot read unchanged', async () => {
    const logger = new CapturingLogger();
    const record = vi.fn();
    const openai = instrumentOpenAI(stub(null), {
      client: { record } as never,
      logger,
      attributionDefaults: { environment: 'test' },
    });
    expect(await openai.chat.completions.create(CHAT_PARAMS)).toBeNull();
    expect(await openai.responses.create({ model: 'gpt-5.4', input: 'a' })).toBeNull();
    expect(await openai.embeddings.create({ model: 'e', input: 'a' })).toBeNull();
    expect(record).not.toHaveBeenCalled();
    expect(logger.lines).toEqual([
      '@openaudr/audr-adapter-openai: MODEL_UNREPORTED (operation=chat.completions.create)',
      '@openaudr/audr-adapter-openai: MODEL_UNREPORTED (operation=responses.create)',
      '@openaudr/audr-adapter-openai: MODEL_UNREPORTED (operation=embeddings.create)',
    ]);
  });

  it('returns a result whose stream shape cannot be inspected unchanged', async () => {
    const result = new Proxy(
      {},
      {
        has(_target, key): boolean {
          if (key === Symbol.asyncIterator) throw new TypeError('private value');
          return false;
        },
      },
    );
    const logger = new CapturingLogger();
    const record = vi.fn();
    const openai = instrumentOpenAI(stub(result), {
      client: { record } as never,
      logger,
      attributionDefaults: { environment: 'test' },
    });
    await expect(openai.chat.completions.create(CHAT_PARAMS)).resolves.toBe(result);
    expect(record).not.toHaveBeenCalled();
    expect(logger.errors).toEqual([
      '@openaudr/audr-adapter-openai: HOOK_FAILED (operation=chat.completions.create, error=TypeError)',
    ]);
  });

  it('passes a frame it cannot inspect on to the caller', async () => {
    const hostile = new Proxy(
      {},
      {
        get(_target, key): undefined {
          // `yield` awaits a thenable check, which a frame must survive to reach any consumer.
          if (key === 'then') return undefined;
          throw new RangeError('private value');
        },
      },
    );
    const frames = [hostile, chatChunks()[2]];
    const stream = {
      [Symbol.asyncIterator]: async function* () {
        yield* frames;
        await Promise.resolve();
      },
    };
    const logger = new CapturingLogger();
    const record = vi.fn(() => ({ outcome: 'queued', queued: true, issues: [] }) as const);
    const openai = instrumentOpenAI(stub(stream), {
      client: { record } as never,
      logger,
      attributionDefaults: { environment: 'test' },
    });
    const metered = (await openai.chat.completions.create(STREAM)) as AsyncIterable<unknown>;
    const yielded = await drain(metered);
    // Identity checks: a deep comparison would itself read the hostile frame.
    expect(yielded).toHaveLength(2);
    expect(yielded[0]).toBe(hostile);
    expect(yielded[1]).toBe(frames[1]);
    expect(record).toHaveBeenCalledOnce();
    expect(logger.errors).toEqual([
      '@openaudr/audr-adapter-openai: HOOK_FAILED (operation=chat.completions.create, error=RangeError)',
    ]);
  });

  it('reads only modalities in addition to the native request fields', async () => {
    const h = harness();
    h.fake.sse(chatChunks());
    const reads: PropertyKey[] = [];
    const watched = new Proxy(
      { ...STREAM },
      {
        get(target, key, receiver) {
          reads.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    await drain(await h.openai.chat.completions.create(watched));
    const instrumented = [...reads];
    reads.length = 0;
    h.fake.sse(chatChunks());
    await drain(await h.native.chat.completions.create(watched));
    expect(instrumented).toEqual(['modalities', ...reads]);
  });

  it('reads the baseURL when recording, so a reconfigured client is still right', async () => {
    const native = { ...stub(response()), baseURL: 'https://llm.example.internal/v1' };
    const logger = new CapturingLogger();
    const client = { record: vi.fn(() => ({ outcome: 'queued', queued: true, issues: [] })) };
    const openai = instrumentOpenAI(native, {
      client: client as never,
      logger,
      attributionDefaults: { environment: 'test' },
    });
    await openai.responses.create({ model: 'gpt-5.4', input: 'a' });
    expect(client.record).not.toHaveBeenCalled();
    native.baseURL = 'https://api.groq.com/openai/v1';
    await openai.responses.create({ model: 'gpt-5.4', input: 'a' });
    expect(client.record).toHaveBeenCalledOnce();
    expect(logger.warnings).toEqual([
      '@openaudr/audr-adapter-openai: PROVIDER_UNRESOLVED (operation=responses.create)',
    ]);
  });
});

describe('rejected records are reported without values', () => {
  it('logs the outcome and each issue path', async () => {
    const h = harness({ attributionDefaults: { environment: 'production' } });
    h.fake.json(chatCompletion());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toHaveLength(1);
    expect(h.logger.warnings[0]).toMatch(
      /^@openaudr\/audr-adapter-openai: RECORD_NOT_QUEUED \(outcome=rejected_invalid, operation=chat\.completions\.create, issues=[^\s()]+@\/attribution[^\s()]*\)$/,
    );
  });
});
