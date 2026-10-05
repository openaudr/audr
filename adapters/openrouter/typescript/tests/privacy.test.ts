import type { AudrRecord } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import {
  chatChunks,
  chatResult,
  chatUsage,
  drain,
  embeddingsResult,
  eventStream,
  generation,
  harness,
  responsesEvents,
  responsesResult,
  responsesUsage,
  routerMetadata,
} from './helpers.js';

/** A value no record, log line or diagnostic may ever contain. */
const SENTINEL = 'PRIVATE-SENTINEL-7f3a91';

/** Keys the language itself reads on any object or array; they say nothing about content. */
const MECHANICAL = new Set(['then', 'length', 'map', 'find', 'includes', 'constructor']);

/**
 * `value` behind a proxy that notes every property read, as a dotted path with array
 * indices written `[]`. Reading a property is the only way the adapter can use a value.
 */
function watched<T extends object>(value: T, reads: Set<string>, path = ''): T {
  return new Proxy(value, {
    get(target, key, receiver): unknown {
      const result: unknown = Reflect.get(target, key, receiver);
      if (typeof key === 'symbol' || MECHANICAL.has(key)) return result;
      const here = `${path}${path === '' ? '' : '.'}${/^\d+$/.test(key) ? '[]' : key}`;
      reads.add(here);
      return typeof result === 'object' && result !== null ? watched(result, reads, here) : result;
    },
  });
}

const sorted = (reads: Set<string>): string[] => [...reads].sort();

/** Everything a result might hold that is not a number, an id, a model or a flag. */
const PRIVATE_CHOICES = [
  {
    index: 0,
    finishReason: 'stop',
    message: {
      role: 'assistant',
      content: SENTINEL,
      reasoning: SENTINEL,
      refusal: SENTINEL,
      toolCalls: [{ id: SENTINEL, function: { name: SENTINEL, arguments: SENTINEL } }],
    },
  },
];

const PRIVATE_RESPONSE = {
  instructions: SENTINEL,
  metadata: { note: SENTINEL },
  tools: [{ type: 'function', name: SENTINEL, description: SENTINEL }],
  output: [{ type: 'message', content: [{ type: 'output_text', text: SENTINEL }] }],
  error: { code: 'server_error', message: SENTINEL },
};

function assertClean(records: readonly AudrRecord[], logs: readonly string[]): void {
  const everything = JSON.stringify(records) + logs.join('\n');
  expect(everything).not.toContain(SENTINEL);
  expect(everything).not.toContain('Decoy');
}

const CHAT_FIELDS = [
  'id',
  'model',
  'openrouterMetadata',
  'openrouterMetadata.endpoints',
  'openrouterMetadata.endpoints.available',
  'openrouterMetadata.endpoints.available.[]',
  'openrouterMetadata.endpoints.available.[].provider',
  'openrouterMetadata.endpoints.available.[].selected',
  'openrouterMetadata.isByok',
  'usage',
  'usage.completionTokens',
  'usage.completionTokensDetails',
  'usage.completionTokensDetails.audioTokens',
  'usage.completionTokensDetails.reasoningTokens',
  'usage.cost',
  'usage.costDetails',
  'usage.costDetails.upstreamInferenceCost',
  'usage.isByok',
  'usage.promptTokens',
  'usage.promptTokensDetails',
  'usage.promptTokensDetails.audioTokens',
  'usage.promptTokensDetails.cacheWriteTokens',
  'usage.promptTokensDetails.cachedTokens',
  'usage.promptTokensDetails.videoTokens',
];

const RESPONSES_FIELDS = [
  'id',
  'model',
  'openrouterMetadata',
  'openrouterMetadata.endpoints',
  'openrouterMetadata.endpoints.available',
  'openrouterMetadata.endpoints.available.[]',
  'openrouterMetadata.endpoints.available.[].provider',
  'openrouterMetadata.endpoints.available.[].selected',
  'openrouterMetadata.isByok',
  'status',
  'usage',
  'usage.cost',
  'usage.costDetails',
  'usage.costDetails.upstreamInferenceCost',
  'usage.inputTokens',
  'usage.inputTokensDetails',
  'usage.inputTokensDetails.cacheWriteTokens',
  'usage.inputTokensDetails.cachedTokens',
  'usage.isByok',
  'usage.outputTokens',
  'usage.outputTokensDetails',
  'usage.outputTokensDetails.reasoningTokens',
];

describe('what a non-streamed result lets the adapter read', () => {
  it('chat.send(): ids, the model, usage, cost and the selected vendor, and nothing else', async () => {
    const h = harness();
    const reads = new Set<string>();
    h.fake.answer(
      'chat.send',
      watched(
        chatResult({
          choices: PRIVATE_CHOICES,
          systemFingerprint: SENTINEL,
          usage: chatUsage({
            extra: SENTINEL,
            promptTokensDetails: { cachedTokens: 1, extra: SENTINEL },
          }),
          openrouterMetadata: routerMetadata('Amazon Bedrock', {
            summary: SENTINEL,
            region: SENTINEL,
          }),
        }),
        reads,
      ),
    );
    await h.openrouter.chat.send({ chatRequest: { messages: [{ content: SENTINEL }] } });
    assertClean(await h.records(), h.logger.lines);
    expect(sorted(reads).filter((path) => !CHAT_FIELDS.includes(path))).toEqual([]);
    expect(reads.has('usage.promptTokens')).toBe(true);
    expect([...reads].some((path) => path.startsWith('choices'))).toBe(false);
  });

  it('responses.send(): ids, status, the model, usage, cost and the selected vendor', async () => {
    const h = harness();
    const reads = new Set<string>();
    h.fake.answer(
      'responses.send',
      watched(
        responsesResult({
          ...PRIVATE_RESPONSE,
          usage: responsesUsage({ extra: SENTINEL }),
          openrouterMetadata: routerMetadata('Amazon Bedrock', { summary: SENTINEL }),
        }),
        reads,
      ),
    );
    await h.openrouter.responses.send({ responsesRequest: { input: SENTINEL } });
    assertClean(await h.records(), h.logger.lines);
    expect(sorted(reads).filter((path) => !RESPONSES_FIELDS.includes(path))).toEqual([]);
  });

  it('embeddings.generate(): ids, the model and usage, never a vector', async () => {
    const h = harness();
    const reads = new Set<string>();
    h.fake
      .answer(
        'embeddings.generate',
        watched(
          embeddingsResult({
            data: [{ object: 'embedding', index: 0, embedding: [0.5, SENTINEL] }],
            usage: { promptTokens: 8, cost: 0.1, isByok: false, extra: SENTINEL },
          }),
          reads,
        ),
      )
      .answer('generations.getGeneration', generation());
    await h.openrouter.embeddings.generate({ requestBody: { input: SENTINEL } });
    assertClean(await h.records(), h.logger.lines);
    expect(sorted(reads)).toEqual([
      'id',
      'model',
      'usage',
      'usage.cost',
      'usage.costDetails',
      'usage.isByok',
      'usage.promptTokens',
      'usage.promptTokensDetails',
    ]);
  });
});

describe('what a streamed frame lets the adapter read', () => {
  it('a chat stream: openrouterMetadata, usage and error on every chunk; the result fields on the last', async () => {
    const h = harness();
    const reads = new Set<string>();
    const chunks = chatChunks(
      chatResult({
        choices: PRIVATE_CHOICES,
        usage: chatUsage({ extra: SENTINEL }),
        openrouterMetadata: routerMetadata('Amazon Bedrock', { summary: SENTINEL }),
      }),
    ).map((chunk) => {
      const frame = chunk as { choices: { delta?: { content: string } }[] };
      return {
        ...frame,
        choices: frame.choices.length === 0 ? [] : [{ index: 0, delta: { content: SENTINEL } }],
      };
    });
    h.fake.answer('chat.send', eventStream(chunks.map((chunk) => watched(chunk, reads))));
    const stream = await h.openrouter.chat.send({ chatRequest: { stream: true } });
    await drain(stream as AsyncIterable<unknown>);
    assertClean(await h.records(), h.logger.lines);
    expect(sorted(reads).filter((path) => ![...CHAT_FIELDS, 'error'].includes(path))).toEqual([]);
  });

  it('a Responses stream: the event type, and the response of a terminal event', async () => {
    const h = harness();
    const reads = new Set<string>();
    const events = responsesEvents(
      'response.completed',
      responsesResult({ ...PRIVATE_RESPONSE, usage: responsesUsage({ extra: SENTINEL }) }),
    ).map((event) => ({ ...(event as object), delta: SENTINEL }));
    h.fake.answer('responses.send', eventStream(events.map((event) => watched(event, reads))));
    const stream = await h.openrouter.responses.send({
      responsesRequest: { stream: true },
    });
    await drain(stream as AsyncIterable<unknown>);
    assertClean(await h.records(), h.logger.lines);
    const allowed = ['type', 'response', ...RESPONSES_FIELDS.map((field) => `response.${field}`)];
    expect(sorted(reads).filter((path) => !allowed.includes(path))).toEqual([]);
  });
});

describe('what a request lets the adapter read', () => {
  it.each([
    ['chat.send', 'chatRequest'],
    ['responses.send', 'responsesRequest'],
  ] as const)('%s: only the declared output modalities', async (method, body) => {
    const h = harness();
    const reads = new Set<string>();
    const request = watched(
      {
        [body]: {
          model: SENTINEL,
          messages: [{ role: 'user', content: SENTINEL }],
          input: SENTINEL,
          tools: [{ name: SENTINEL }],
          metadata: { user: SENTINEL },
          user: SENTINEL,
          modalities: ['text'],
        },
        options: { headers: { authorization: SENTINEL } },
      },
      reads,
    );
    h.fake.answer(method, method === 'chat.send' ? chatResult() : responsesResult());
    const resource = method === 'chat.send' ? h.openrouter.chat : h.openrouter.responses;
    await resource.send(request);
    assertClean(await h.records(), h.logger.lines);
    expect(sorted(reads)).toEqual([body, `${body}.modalities`, `${body}.modalities.[]`]);
  });

  it('embeddings.generate(): nothing', async () => {
    const h = harness();
    const reads = new Set<string>();
    h.fake
      .answer('embeddings.generate', embeddingsResult())
      .answer('generations.getGeneration', generation());
    await h.openrouter.embeddings.generate(
      watched({ requestBody: { input: SENTINEL, model: SENTINEL } }, reads),
    );
    assertClean(await h.records(), h.logger.lines);
    expect(sorted(reads)).toEqual([]);
  });
});

describe('what the lookup lets the adapter read', () => {
  it('four generation fields, and nothing from the rest of the response', async () => {
    const h = harness();
    const reads = new Set<string>();
    h.fake.answer('chat.send', chatResult({ openrouterMetadata: undefined })).answer(
      'generations.getGeneration',
      watched(
        generation({
          appId: SENTINEL,
          apiKeyName: SENTINEL,
          userId: SENTINEL,
          externalUser: SENTINEL,
          origin: SENTINEL,
          finishReason: SENTINEL,
          tokensPrompt: 1,
          model: SENTINEL,
        }),
        reads,
      ),
    );
    await h.openrouter.chat.send({ chatRequest: {} });
    assertClean(await h.records(), h.logger.lines);
    expect(sorted(reads)).toEqual([
      'data',
      'data.isByok',
      'data.providerName',
      'data.responseCacheSourceId',
      'data.upstreamInferenceCost',
    ]);
  });
});

describe('what a failure lets the adapter log', () => {
  it('names the operation and a category, never an error message', async () => {
    const lookupFailure = Object.assign(new Error(SENTINEL), { statusCode: 401, body: SENTINEL });
    const h = harness({
      client: {
        record: () => {
          throw new TypeError(SENTINEL);
        },
      } as never,
    });
    h.fake
      .answer('chat.send', chatResult({ openrouterMetadata: undefined }))
      .fail('generations.getGeneration', lookupFailure)
      .answer('chat.send', chatResult());
    await h.openrouter.chat.send({ chatRequest: {} });
    await h.openrouter.chat.send({ chatRequest: {} });
    expect(h.logger.lines.length).toBeGreaterThan(1);
    assertClean([], h.logger.lines);
  });

  it('does not log a record value when the client rejects a record', async () => {
    const h = harness({ mapResource: () => ({ provider: SENTINEL, name: SENTINEL }) });
    h.fake.answer('chat.send', chatResult());
    await h.openrouter.chat.send({ chatRequest: {} });
    expect(h.logger.warnings).toHaveLength(1);
    assertClean(await h.records(), [...h.logger.lines, ...h.clientLogger.lines]);
  });
});
