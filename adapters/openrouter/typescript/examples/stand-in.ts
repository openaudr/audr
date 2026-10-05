/**
 * A local stand-in for the OpenRouter API, shared by the examples. It replaces
 * `globalThis.fetch`, which `@openrouter/sdk` calls, so the examples run without network
 * access or credentials. The real SDK still builds each request and parses each response.
 *
 * Like the service, it attaches router metadata only to a Chat or Responses request that
 * sends `xOpenRouterMetadata: 'enabled'`; Embeddings never carry it.
 */

const MODEL = 'anthropic/claude-sonnet-4.5';
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';

export interface StandInOptions {
  /** The vendor that "served" every call, as OpenRouter names it. */
  readonly provider?: string;
  /** Serve calls billed to the caller's own provider key (bring your own key). */
  readonly byok?: boolean;
}

export interface StandIn {
  /** Every request received, as `METHOD /path`, in order. */
  readonly requests: string[];
}

export function standIn({
  provider = 'Amazon Bedrock',
  byok = false,
}: StandInOptions = {}): StandIn {
  const requests: string[] = [];
  let served = 0;

  const metadata = {
    attempt: 1,
    endpoints: {
      available: [
        { model: MODEL, provider: 'Another Vendor', selected: false },
        { model: MODEL, provider, selected: true },
      ],
      total: 2,
    },
    is_byok: byok,
    region: null,
    requested: MODEL,
    strategy: 'direct',
    summary: 'routed',
  };

  // OpenRouter charges its fee in `cost`; a BYOK call adds the provider's own charge.
  const cost = byok ? 0.0005 : 0.0123;
  const costDetails = byok
    ? {
        upstream_inference_cost: 0.01,
        upstream_inference_prompt_cost: 0.006,
        upstream_inference_completions_cost: 0.004,
      }
    : undefined;

  const chatUsage = {
    prompt_tokens: 1000,
    completion_tokens: 300,
    total_tokens: 1300,
    prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
    completion_tokens_details: { reasoning_tokens: 200 },
    cost,
    cost_details: costDetails,
    is_byok: byok,
  };

  const responsesUsage = {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
    output_tokens: 300,
    output_tokens_details: { reasoning_tokens: 200 },
    total_tokens: 1300,
    cost,
    cost_details: byok
      ? {
          upstream_inference_cost: 0.01,
          upstream_inference_input_cost: 0.006,
          upstream_inference_output_cost: 0.004,
        }
      : undefined,
    is_byok: byok,
  };

  const generation = (id: string): unknown => ({
    data: {
      api_type: 'completions',
      app_id: null,
      cache_discount: null,
      cancelled: false,
      created_at: new Date().toISOString(),
      data_region: 'global',
      external_user: null,
      finish_reason: 'stop',
      generation_time: 100,
      http_referer: null,
      id,
      is_byok: byok,
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
      origin: 'https://example.com',
      preset_id: null,
      provider_name: provider,
      provider_responses: null,
      router: null,
      service_tier: null,
      streamed: false,
      tokens_completion: 300,
      tokens_prompt: 1000,
      total_cost: cost + (byok ? 0.01 : 0),
      upstream_id: null,
      upstream_inference_cost: byok ? 0.01 : null,
      usage: cost,
      user_agent: null,
      web_search_engine: null,
      workspace_id: null,
    },
  });

  const chat = (id: string, withMetadata: boolean): unknown => ({
    id,
    object: 'chat.completion',
    created: 1759680000,
    model: MODEL,
    system_fingerprint: null,
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello!' } },
    ],
    usage: chatUsage,
    openrouter_metadata: withMetadata ? metadata : undefined,
  });

  const chatChunks = (id: string, withMetadata: boolean): unknown[] => {
    const chunk = { id, object: 'chat.completion.chunk', created: 1759680000, model: MODEL };
    const delta = (content: string): unknown => ({
      ...chunk,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
    return [
      delta('Hel'),
      delta('lo!'),
      {
        ...chunk,
        choices: [],
        usage: chatUsage,
        openrouter_metadata: withMetadata ? metadata : undefined,
      },
    ];
  };

  const response = (id: string, withMetadata: boolean): unknown => ({
    id,
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
    openrouter_metadata: withMetadata ? metadata : undefined,
  });

  const embeddings = (id: string): unknown => ({
    id,
    object: 'list',
    model: EMBEDDING_MODEL,
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
    usage: { prompt_tokens: 8, total_tokens: 8, cost: 0.00000016, is_byok: false },
  });

  const events = (frames: readonly unknown[]): Response =>
    new Response(
      [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'].join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );

  globalThis.fetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    requests.push(`${request.method} ${path}`);
    if (request.method === 'GET' && path === '/generation') {
      return Response.json(generation(url.searchParams.get('id') ?? ''));
    }

    served += 1;
    const id = `gen-1759680000-example${String(served).padStart(4, '0')}`;
    const body = (await request.json()) as { stream?: boolean };
    const withMetadata = request.headers.get('x-openrouter-metadata') === 'enabled';
    switch (path) {
      case '/chat/completions':
        return body.stream === true
          ? events(chatChunks(id, withMetadata))
          : Response.json(chat(id, withMetadata));
      case '/responses':
        return body.stream === true
          ? events([
              {
                type: 'response.completed',
                sequence_number: 1,
                response: response(id, withMetadata),
              },
            ])
          : Response.json(response(id, withMetadata));
      case '/embeddings':
        return Response.json(embeddings(id));
      default:
        return Response.json({ error: { code: 404, message: 'not found' } }, { status: 404 });
    }
  };

  return { requests };
}
