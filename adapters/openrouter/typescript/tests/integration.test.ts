import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { HTTPClient, OpenRouter, type SDKOptions } from '@openrouter/sdk';
import { describe, expect, it } from 'vitest';

import { instrumentOpenRouter } from '../src/index.js';
import { CapturingLogger, drain, GENERATION_ID, LLM } from './helpers.js';

/**
 * These tests drive a real `OpenRouter` from `@openrouter/sdk`. Only the network is
 * replaced: the SDK builds the request, validates and parses the response and runs its own
 * event-stream reader, so a result here has exactly the shape a host's code receives.
 */

const MODEL = 'anthropic/claude-sonnet-4.5';
const PREFIX = '@openaudr/audr-adapter-openrouter';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly authorization: string | null;
}

type Route = () => Response | Promise<Response>;

/**
 * A network that answers by path, in order, and remembers what it was asked. Like `fetch`, it
 * rejects with the signal's reason when the request is aborted, and never sends an aborted one.
 */
class FakeNetwork {
  readonly seen: Seen[] = [];
  readonly #routes = new Map<string, Route[]>();

  on(path: string, ...routes: Route[]): this {
    this.#routes.set(path, [...(this.#routes.get(path) ?? []), ...routes]);
    return this;
  }

  get http(): HTTPClient {
    return new HTTPClient({
      fetcher: (input) => {
        const request = input as Request;
        const { signal } = request;
        if (signal.aborted) return Promise.reject(signal.reason as Error);
        const url = new URL(request.url);
        this.seen.push({
          method: request.method,
          path: url.pathname,
          query: url.search,
          authorization: request.headers.get('authorization'),
        });
        const queue = this.#routes.get(url.pathname);
        const route = queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0];
        const aborted = new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason as Error);
            },
            { once: true },
          );
        });
        return Promise.race([
          Promise.resolve(route?.() ?? json({ error: { message: 'no route' } }, 599)),
          aborted,
        ]);
      },
    });
  }

  count(path: string): number {
    return this.seen.filter((entry) => entry.path === path).length;
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const events = (frames: readonly unknown[]): Response =>
  new Response(
    [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'].join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const failure =
  (status: number): Route =>
  () =>
    json({ error: { code: status, message: 'x' } }, status);

/** A server that accepts the request and never answers. */
const silence: Route = () => new Promise<Response>(() => undefined);

function metadata(provider = 'Amazon Bedrock'): Record<string, unknown> {
  return {
    attempt: 1,
    endpoints: {
      available: [
        { model: MODEL, provider: 'Decoy One', selected: false },
        { model: MODEL, provider, selected: true },
      ],
      total: 2,
    },
    is_byok: false,
    region: null,
    requested: MODEL,
    strategy: 'direct',
    summary: 'routed',
  };
}

const chatUsage = {
  prompt_tokens: 1000,
  completion_tokens: 300,
  total_tokens: 1300,
  prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
  completion_tokens_details: { reasoning_tokens: 200 },
  cost: 0.0123,
  is_byok: false,
};

const chatBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: GENERATION_ID,
  object: 'chat.completion',
  created: 1759680000,
  model: MODEL,
  system_fingerprint: null,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  usage: chatUsage,
  openrouter_metadata: metadata(),
  ...overrides,
});

const chunk = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: GENERATION_ID,
  object: 'chat.completion.chunk',
  created: 1759680000,
  model: MODEL,
  choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
  ...overrides,
});

const responsesUsage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 200 },
  total_tokens: 1300,
  cost: 0.0123,
  is_byok: false,
};

const responsesBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: GENERATION_ID,
  object: 'response',
  created_at: 1759680000,
  completed_at: 1759680001,
  status: 'completed',
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: MODEL,
  output: [],
  parallel_tool_calls: true,
  temperature: null,
  top_p: null,
  frequency_penalty: null,
  presence_penalty: null,
  tool_choice: 'auto',
  tools: [],
  usage: responsesUsage,
  openrouter_metadata: metadata(),
  ...overrides,
});

const embeddingsBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: GENERATION_ID,
  object: 'list',
  model: 'openai/text-embedding-3-small',
  data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
  usage: { prompt_tokens: 8, total_tokens: 8, cost: 0.00000016, is_byok: false },
  ...overrides,
});

const generationBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  data: {
    api_type: 'completions',
    app_id: null,
    cache_discount: null,
    cancelled: false,
    created_at: '2026-10-05T00:00:00Z',
    data_region: 'global',
    external_user: null,
    finish_reason: 'stop',
    generation_time: 100,
    http_referer: null,
    id: GENERATION_ID,
    is_byok: false,
    latency: 200,
    model: MODEL,
    moderation_latency: null,
    native_finish_reason: 'stop',
    native_tokens_cached: null,
    native_tokens_completion: 300,
    native_tokens_completion_images: null,
    native_tokens_prompt: 1000,
    native_tokens_reasoning: 200,
    num_fetches: null,
    num_input_audio_prompt: null,
    num_media_completion: null,
    num_media_prompt: null,
    num_search_results: null,
    origin: 'https://example.test',
    preset_id: null,
    provider_name: 'Google Vertex',
    provider_responses: null,
    router: null,
    service_tier: null,
    streamed: false,
    tokens_completion: 300,
    tokens_prompt: 1000,
    total_cost: 0.0123,
    upstream_id: null,
    upstream_inference_cost: null,
    usage: 0.0123,
    user_agent: null,
    web_search_engine: null,
    workspace_id: null,
    ...overrides,
  },
});

const LOOKUP_MAX_WAIT_MS = 400;

function setup(network: FakeNetwork, native: SDKOptions = {}) {
  const sink = new MemorySink();
  const clientLogger = new CapturingLogger();
  const client = new Client(sink, { logger: clientLogger });
  const logger = new CapturingLogger();
  const openrouter = instrumentOpenRouter(
    new OpenRouter({
      apiKey: 'sk-or-test',
      httpClient: network.http,
      serverURL: 'https://openrouter.test/api/v1',
      ...native,
    }),
    {
      client,
      logger,
      attributionDefaults: { environment: 'test' },
      lookup: { maxWaitMs: LOOKUP_MAX_WAIT_MS, initialDelayMs: 1, maxDelayMs: 5 },
    },
  );
  return {
    openrouter,
    logger,
    clientLogger,
    records: async () => {
      await client.flush();
      return sink.records;
    },
  };
}

const CHAT = {
  chatRequest: { model: MODEL, messages: [{ role: 'user' as const, content: 'Hi' }] },
};
const CHAT_STREAM = { chatRequest: { ...CHAT.chatRequest, stream: true as const } };
const RESPONSES = { responsesRequest: { model: MODEL, input: 'Hi' } };
const RESPONSES_STREAM = {
  responsesRequest: { ...RESPONSES.responsesRequest, stream: true as const },
};
const EMBEDDINGS = { requestBody: { model: 'openai/text-embedding-3-small', input: 'Hi' } };

describe('with the real SDK', () => {
  it('returns a client that is still an OpenRouter', () => {
    const { openrouter } = setup(new FakeNetwork());
    expect(openrouter).toBeInstanceOf(OpenRouter);
  });

  it('chat.send() returns the parsed result and records it, from router metadata alone', async () => {
    const network = new FakeNetwork().on('/api/v1/chat/completions', () => json(chatBody()));
    const { openrouter, logger, records } = setup(network);
    const result = await openrouter.chat.send(CHAT);
    expect(result).toMatchObject({
      id: GENERATION_ID,
      model: MODEL,
      usage: { promptTokens: 1000 },
    });
    const recorded = await records();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      resource: { provider: 'amazon-bedrock', name: MODEL, operation: 'generation' },
      usage: { llm: LLM },
      cost: { total_cost: 0.0123, currency: 'USD' },
    });
    expect(network.seen).toHaveLength(1);
    expect(logger.lines).toEqual([]);
  });

  it('asks generations.getGeneration() through the same client when the result names no vendor', async () => {
    const network = new FakeNetwork()
      .on('/api/v1/chat/completions', () => json(chatBody({ openrouter_metadata: undefined })))
      .on('/api/v1/generation', () => json(generationBody()));
    const { openrouter, logger, records } = setup(network);
    await openrouter.chat.send(CHAT);
    expect((await records())[0]?.resource.provider).toBe('google-vertex');
    expect(network.seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      'POST /api/v1/chat/completions',
      'GET /api/v1/generation',
    ]);
    expect(network.seen[1]?.query).toBe(`?id=${GENERATION_ID}`);
    expect(network.seen[1]?.authorization).toBe(network.seen[0]?.authorization);
    expect(logger.lines).toEqual([]);
  });

  it('retries a generation the service has not stored yet', async () => {
    const network = new FakeNetwork()
      .on('/api/v1/chat/completions', () => json(chatBody({ openrouter_metadata: undefined })))
      .on('/api/v1/generation', failure(404), failure(404), () => json(generationBody()));
    const { openrouter, logger, records } = setup(network);
    await openrouter.chat.send(CHAT);
    expect((await records())[0]?.resource.provider).toBe('google-vertex');
    expect(network.count('/api/v1/generation')).toBe(3);
    expect(logger.lines).toEqual([]);
  });

  it('stops at once on an authentication failure and records openrouter as the provider', async () => {
    const network = new FakeNetwork()
      .on('/api/v1/chat/completions', () => json(chatBody({ openrouter_metadata: undefined })))
      .on('/api/v1/generation', failure(401));
    const { openrouter, logger, records } = setup(network);
    await openrouter.chat.send(CHAT);
    expect((await records()).map((r) => r.resource.provider)).toEqual(['openrouter']);
    expect(network.count('/api/v1/generation')).toBe(1);
    expect(logger.warnings).toEqual([
      `${PREFIX}: LOOKUP_FAILED (operation=chat.send, reason=rejected)`,
      `${PREFIX}: PROVIDER_UNRESOLVED (operation=chat.send)`,
    ]);
  });

  const hostRetries: SDKOptions = {
    retryConfig: {
      strategy: 'backoff',
      backoff: { initialInterval: 1, maxInterval: 1, exponent: 1, maxElapsedTime: 3_600_000 },
      retryConnectionErrors: true,
    },
  };

  it.each([
    ['answers 503 under the default SDK retries', failure(503), {}],
    ['never answers under the default SDK retries', silence, {}],
    ['never answers under a host retryConfig', silence, hostRetries],
  ] as const)(
    'releases the call within maxWaitMs when the generation endpoint %s',
    async (_, route, native) => {
      const network = new FakeNetwork()
        .on('/api/v1/chat/completions', () => json(chatBody({ openrouter_metadata: undefined })))
        .on('/api/v1/generation', route);
      const { openrouter, logger, records } = setup(network, native);
      const started = performance.now();
      const result = await openrouter.chat.send(CHAT);
      expect(performance.now() - started).toBeLessThan(LOOKUP_MAX_WAIT_MS + 1_000);
      expect(result).toMatchObject({ id: GENERATION_ID });
      expect((await records()).map((r) => r.resource.provider)).toEqual(['openrouter']);
      expect(logger.warnings).toEqual([
        `${PREFIX}: LOOKUP_FAILED (operation=chat.send, reason=exhausted)`,
        `${PREFIX}: PROVIDER_UNRESOLVED (operation=chat.send)`,
      ]);
    },
  );

  it('streams chat: every parsed chunk reaches the host and one record is written', async () => {
    const network = new FakeNetwork().on('/api/v1/chat/completions', () =>
      events([
        chunk(),
        chunk({ choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }] }),
        chunk({
          choices: [],
          usage: chatUsage,
          openrouter_metadata: metadata('Anthropic'),
        }),
      ]),
    );
    const { openrouter, logger, records } = setup(network);
    const stream = (await openrouter.chat.send(CHAT_STREAM)) as AsyncIterable<unknown>;
    const frames = (await drain(stream)) as { choices: unknown[]; usage?: unknown }[];
    expect(frames).toHaveLength(3);
    expect(frames[2]?.usage).toMatchObject({ promptTokens: 1000, cost: 0.0123 });
    const recorded = await records();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      resource: { provider: 'anthropic', name: MODEL },
      usage: { llm: LLM },
    });
    expect(logger.lines).toEqual([]);
  });

  it('reports a chat stream the host abandons', async () => {
    const network = new FakeNetwork().on('/api/v1/chat/completions', () =>
      events([chunk(), chunk(), chunk({ choices: [], usage: chatUsage })]),
    );
    const { openrouter, logger, records } = setup(network);
    const stream = (await openrouter.chat.send(CHAT_STREAM)) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(await records()).toEqual([]);
    expect(logger.warnings).toEqual([
      `${PREFIX}: STREAM_INCOMPLETE (operation=chat.send, reason=abandoned)`,
    ]);
  });

  it('responses.send() returns the parsed result and records it', async () => {
    const network = new FakeNetwork().on('/api/v1/responses', () => json(responsesBody()));
    const { openrouter, logger, records } = setup(network);
    const result = await openrouter.responses.send(RESPONSES);
    expect(result).toMatchObject({ id: GENERATION_ID, status: 'completed' });
    expect((await records())[0]).toMatchObject({
      resource: { provider: 'amazon-bedrock', name: MODEL },
      usage: { llm: LLM },
      cost: { total_cost: 0.0123 },
      run: { span_id: `response:${GENERATION_ID}` },
    });
    expect(logger.lines).toEqual([]);
  });

  it('streams Responses: the terminal event is recorded', async () => {
    const network = new FakeNetwork().on('/api/v1/responses', () =>
      events([{ type: 'response.completed', sequence_number: 1, response: responsesBody() }]),
    );
    const { openrouter, logger, records } = setup(network);
    const stream = await openrouter.responses.send(RESPONSES_STREAM);
    const frames = await drain(stream as AsyncIterable<unknown>);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'response.completed' });
    expect((await records())[0]).toMatchObject({ usage: { llm: LLM } });
    expect(logger.lines).toEqual([]);
  });

  it('embeddings.generate() names the vendor through the lookup', async () => {
    const network = new FakeNetwork()
      .on('/api/v1/embeddings', () => json(embeddingsBody()))
      .on('/api/v1/generation', () => json(generationBody({ provider_name: 'OpenAI' })));
    const { openrouter, logger, records } = setup(network);
    const result = await openrouter.embeddings.generate(EMBEDDINGS);
    expect(result).toMatchObject({ id: GENERATION_ID });
    expect((await records())[0]).toMatchObject({
      resource: {
        provider: 'openai',
        name: 'openai/text-embedding-3-small',
        operation: 'embedding',
      },
      usage: { llm: { input_tokens: 8, requests: 1 } },
      cost: { total_cost: 0.00000016 },
    });
    expect(logger.lines).toEqual([]);
  });

  it('prices a BYOK call from the upstream cost the real SDK parses', async () => {
    const byok = {
      ...chatUsage,
      is_byok: true,
      cost: 0.0005,
      cost_details: {
        upstream_inference_cost: 0.01,
        upstream_inference_prompt_cost: 0.006,
        upstream_inference_completions_cost: 0.004,
        server_tool_cost: 0.002,
      },
    };
    const network = new FakeNetwork().on('/api/v1/chat/completions', () =>
      json(chatBody({ usage: byok })),
    );
    const { openrouter, records } = setup(network);
    await openrouter.chat.send(CHAT);
    expect((await records())[0]?.cost?.total_cost).toBeCloseTo(0.0105, 12);
  });

  it('propagates a native failure as the SDK throws it', async () => {
    const network = new FakeNetwork().on('/api/v1/chat/completions', failure(429));
    const { openrouter, logger, records } = setup(network);
    await expect(openrouter.chat.send(CHAT)).rejects.toMatchObject({ statusCode: 429 });
    expect(await records()).toEqual([]);
    expect(logger.lines).toEqual([]);
  });
});
