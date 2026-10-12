import { describe, expect, it } from 'vitest';

import {
  chatResult,
  chatUsage,
  generation,
  GENERATION_ID,
  harness,
  LLM,
  routerMetadata,
  sleep,
} from './helpers.js';

const REQUEST = { chatRequest: { model: 'anthropic/claude-sonnet-4.5', messages: [] } };

async function sendChat(
  result: Record<string, unknown>,
  request: unknown = REQUEST,
  options: Parameters<typeof harness>[0] = {},
) {
  const h = harness(options);
  h.fake.answer('chat.send', result);
  await h.openrouter.chat.send(request);
  return { h, records: await h.records() };
}

describe('chat.send()', () => {
  it('records one generation from the result and router metadata, with no lookup', async () => {
    const { h, records } = await sendChat(chatResult());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      emitter: { component: 'router', name: '@openaudr/audr-adapter-openrouter' },
      resource: {
        provider: 'amazon-bedrock',
        type: 'model',
        name: 'anthropic/claude-sonnet-4.5',
        operation: 'generation',
        modality: 'text',
      },
      usage: { llm: LLM },
      cost: { total_cost: 0.0123, currency: 'USD' },
      run: { run_id: GENERATION_ID, span_id: `chat:${GENERATION_ID}`, run_type: 'single_call' },
      attribution: { environment: 'test' },
    });
    expect(records[0]?.cost).not.toHaveProperty('llm');
    expect(h.fake.lookups).toHaveLength(0);
    expect(h.logger.lines).toEqual([]);
    expect(h.clientLogger.lines).toEqual([]);
  });

  it('never writes total_tokens, run.step, run.trace_id or run.outcome', async () => {
    const { records } = await sendChat(chatResult());
    const record = records[0];
    expect(record?.usage.llm).not.toHaveProperty('total_tokens');
    for (const field of ['step', 'trace_id', 'outcome', 'parent_span_id', 'name', 'error_code']) {
      expect(record?.run).not.toHaveProperty(field);
    }
  });

  it('asks the lookup for the vendor when the result carries no metadata', async () => {
    const h = harness();
    h.fake
      .answer('chat.send', chatResult({ openrouterMetadata: undefined }))
      .answer('generations.getGeneration', generation({ providerName: 'Google Vertex' }));
    await h.openrouter.chat.send(REQUEST);
    const [record] = await h.records();
    expect(record?.resource.provider).toBe('google-vertex');
    expect(h.fake.lookups).toHaveLength(1);
    expect(h.fake.lookups[0]?.args[0]).toEqual({ id: GENERATION_ID });
    expect(h.fake.lookups[0]?.receiver).toBe(h.fake.generations);
  });

  it('measures the primary call alone: the lookup does not count towards duration or event_time', async () => {
    const h = harness({ lookup: { maxWaitMs: 1000 } });
    h.fake.answer('chat.send', chatResult({ openrouterMetadata: undefined }));
    h.fake.generations.getGeneration = async () => {
      await sleep(80);
      return generation();
    };
    const started = Date.now();
    await h.openrouter.chat.send(REQUEST);
    const finished = Date.now();
    const [record] = await h.records();
    expect(finished - started).toBeGreaterThanOrEqual(75);
    expect(record?.timing.duration_ms).toBeLessThan(40);
    expect(Date.parse(record?.timing.event_time ?? '')).toBeLessThan(finished - 60);
  });
});

describe('chat token arithmetic', () => {
  const cases: readonly {
    readonly name: string;
    readonly usage: Record<string, unknown>;
    readonly llm: Record<string, number>;
  }[] = [
    {
      name: 'subtracts cache reads and writes from the prompt and reasoning from the completion',
      usage: chatUsage(),
      llm: LLM,
    },
    {
      name: 'subtracts cache writes from the prompt when nothing was read',
      usage: chatUsage({
        promptTokens: 100,
        promptTokensDetails: { cachedTokens: 0, cacheWriteTokens: 80 },
        completionTokensDetails: null,
      }),
      llm: {
        input_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 80,
        output_tokens: 300,
        requests: 1,
      },
    },
    {
      name: 'keeps explicit zeroes',
      usage: chatUsage({
        promptTokens: 10,
        completionTokens: 5,
        promptTokensDetails: { cachedTokens: 0, cacheWriteTokens: 0 },
        completionTokensDetails: { reasoningTokens: 0 },
      }),
      llm: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        requests: 1,
      },
    },
    {
      name: 'omits null and absent detail objects',
      usage: chatUsage({
        promptTokens: 10,
        completionTokens: 5,
        promptTokensDetails: null,
        completionTokensDetails: undefined,
      }),
      llm: { input_tokens: 10, output_tokens: 5, requests: 1 },
    },
    {
      name: 'omits null and absent counters inside the details',
      usage: chatUsage({
        promptTokens: 10,
        completionTokens: 5,
        promptTokensDetails: { cachedTokens: undefined, cacheWriteTokens: 3 },
        completionTokensDetails: { reasoningTokens: null },
      }),
      llm: { input_tokens: 7, output_tokens: 5, cache_write_tokens: 3, requests: 1 },
    },
    {
      name: 'clamps at zero when cache reads exceed the prompt or reasoning exceeds the completion',
      usage: chatUsage({
        promptTokens: 10,
        completionTokens: 5,
        promptTokensDetails: { cachedTokens: 50 },
        completionTokensDetails: { reasoningTokens: 9 },
      }),
      llm: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 50,
        reasoning_tokens: 9,
        requests: 1,
      },
    },
    {
      name: 'omits a counter the result does not report',
      usage: { cost: 0.5, isByok: false },
      llm: { requests: 1 },
    },
  ];

  it.each(cases)('$name', async ({ usage, llm }) => {
    const { h, records } = await sendChat(chatResult({ usage }));
    expect(records[0]?.usage.llm).toEqual(llm);
    expect(h.logger.lines).toEqual([]);
  });
});

describe('chat modality', () => {
  const cases: readonly {
    readonly name: string;
    readonly modalities?: unknown;
    readonly usage?: Record<string, unknown>;
    readonly expected: string;
  }[] = [
    { name: 'defaults to text', expected: 'text' },
    { name: 'a declared single modality', modalities: ['image'], expected: 'image' },
    { name: 'audio alone', modalities: ['audio'], expected: 'audio' },
    { name: 'text and image', modalities: ['text', 'image'], expected: 'multimodal' },
    {
      name: 'audio tokens in the completion',
      usage: chatUsage({ completionTokensDetails: { audioTokens: 12 } }),
      expected: 'multimodal',
    },
    {
      name: 'audio tokens in the prompt',
      usage: chatUsage({ promptTokensDetails: { audioTokens: 12 } }),
      expected: 'multimodal',
    },
    {
      name: 'video tokens in the prompt',
      usage: chatUsage({ promptTokensDetails: { videoTokens: 12 } }),
      expected: 'multimodal',
    },
    {
      name: 'zero audio tokens',
      usage: chatUsage({ completionTokensDetails: { audioTokens: 0 } }),
      expected: 'text',
    },
    { name: 'a selector AUDR has no name for', modalities: ['hologram'], expected: 'text' },
    { name: 'a selector that is not a list', modalities: 'image', expected: 'text' },
  ];

  it.each(cases)('$name', async ({ modalities, usage, expected }) => {
    const request = { chatRequest: { model: 'm', messages: [], modalities } };
    const { records } = await sendChat(chatResult(usage === undefined ? {} : { usage }), request);
    expect(records[0]?.resource.modality).toBe(expected);
  });

  it('reads nothing from a request it cannot inspect', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new RangeError('private value');
        },
      },
    );
    const { h, records } = await sendChat(chatResult(), hostile);
    expect(records[0]?.resource.modality).toBe('text');
    expect(h.logger.lines).toEqual([]);
  });
});

describe('chat identifiers', () => {
  it.each([
    ['7 characters', 'abcdefg', false],
    ['8 characters', 'abcdefgh', true],
    ['64 characters', 'a'.repeat(64), true],
    ['65 characters', 'a'.repeat(65), false],
  ])('a result id of %s as run_id: %s', async (_name, id, fits) => {
    const { records } = await sendChat(
      chatResult({ id, openrouterMetadata: routerMetadata('Anthropic') }),
    );
    const run = records[0]?.run;
    if (fits) expect(run?.run_id).toBe(id);
    else expect(run?.run_id).not.toBe(id);
    expect(run?.run_id).toMatch(/^.{8,64}$/);
    expect(run?.span_id).toBe(`chat:${id}`);
  });
});
