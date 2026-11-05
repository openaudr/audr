import { type AudrRecord, Client, type Logger } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import OpenAI, { type ClientOptions } from 'openai';
import { vi } from 'vitest';

import { instrumentOpenAI, type InstrumentOpenAIOptions } from '../src/index.js';

/** A logger that keeps every line it is given. */
export class CapturingLogger implements Logger {
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  get lines(): string[] {
    return [...this.warnings, ...this.errors];
  }
}

export interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * Stands in for an OpenAI-compatible API behind the real SDK: `fetch` is stubbed and answers
 * the queued responses in order, recording each request.
 */
export class FakeApi {
  readonly requests: SentRequest[] = [];
  readonly #queue: (() => Response)[] = [];

  json(body: unknown, status = 200): this {
    this.#queue.push(
      () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    return this;
  }

  /**
   * A native SSE stream of `frames`, each as the SDK sends it: a bare `data:` line for Chat
   * chunks, an `event:` line as well for Responses events. `failAfter` errors the body after
   * that many frames; otherwise the stream ends with `[DONE]`.
   */
  sse(frames: readonly unknown[], options: { failAfter?: number } = {}): this {
    this.#queue.push(() => {
      const encoder = new TextEncoder();
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (options.failAfter !== undefined && sent === options.failAfter) {
            controller.error(new TypeError('network'));
            return;
          }
          const frame = frames[sent];
          if (frame === undefined) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }
          sent += 1;
          const type = (frame as { type?: unknown }).type;
          const event = typeof type === 'string' ? `event: ${type}\n` : '';
          controller.enqueue(encoder.encode(`${event}data: ${JSON.stringify(frame)}\n\n`));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    return this;
  }

  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const raw = init?.body;
    this.requests.push({
      method: init?.method ?? 'GET',
      url: url.href,
      path: url.pathname.replace(/^\/v1/, ''),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
    });
    const next = this.#queue.shift();
    return next === undefined
      ? Promise.reject(new Error('no response queued'))
      : Promise.resolve(next());
  };
}

export interface Harness {
  readonly fake: FakeApi;
  readonly native: OpenAI;
  readonly openai: OpenAI;
  readonly sink: MemorySink;
  readonly client: Client;
  readonly logger: CapturingLogger;
  /** The client's own diagnostics, kept apart from the adapter's. */
  readonly clientLogger: CapturingLogger;
  /** Flush the client and return every record the sink has accepted. */
  records(): Promise<AudrRecord[]>;
}

/** A native client pointed at `fake`, without retries so that a failure is answered once. */
export function nativeClient(options: ClientOptions = {}): OpenAI {
  return new OpenAI({ apiKey: 'sk-test', maxRetries: 0, ...options });
}

export function harness(
  options: Partial<InstrumentOpenAIOptions> = {},
  clientOptions: ClientOptions = {},
): Harness {
  const fake = new FakeApi();
  vi.stubGlobal('fetch', fake.fetch);
  const sink = new MemorySink();
  const clientLogger = new CapturingLogger();
  const client = new Client(sink, { logger: clientLogger });
  const logger = new CapturingLogger();
  const native = nativeClient(clientOptions);
  const openai = instrumentOpenAI(native, {
    client,
    logger,
    attributionDefaults: { environment: 'test' },
    ...options,
  });
  return {
    fake,
    native,
    openai,
    sink,
    client,
    logger,
    clientLogger,
    async records() {
      await client.flush();
      return sink.records;
    },
  };
}

/** A `Client` stand-in that accepts every record and keeps it. */
export function recordingClient(): Client & { readonly submitted: AudrRecord[] } {
  const submitted: AudrRecord[] = [];
  return {
    submitted,
    record: (record: AudrRecord) => {
      submitted.push(record);
      return { outcome: 'queued', queued: true, issues: [] };
    },
  } as unknown as Client & { readonly submitted: AudrRecord[] };
}

export const CHAT_PARAMS = {
  model: 'gpt-5.4',
  messages: [{ role: 'user' as const, content: 'hi' }],
};
export const RESPONSES_PARAMS = { model: 'gpt-5.4', input: 'hi' };
export const EMBEDDINGS_PARAMS = { model: 'text-embedding-3-small', input: ['first', 'second'] };

/** A Chat Completions body as documented, with cache and reasoning counters. */
export function chatCompletion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-01J9Z8QK4M',
    object: 'chat.completion',
    created: 1_727_697_600,
    model: 'gpt-5.4-2026-03-01',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok', refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 5620,
      completion_tokens: 180,
      total_tokens: 5800,
      prompt_tokens_details: { cached_tokens: 5533, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 30,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
    ...overrides,
  };
}

/** The AUDR counters `chatCompletion()` and `response()` map to. */
export const GENERATION_LLM = {
  input_tokens: 87,
  output_tokens: 150,
  cache_read_tokens: 5533,
  reasoning_tokens: 30,
  requests: 1,
};

/** The chunks of a Chat stream: two deltas, then the usage chunk `include_usage` adds. */
export function chatChunks(done: Record<string, unknown> = chatCompletion()): unknown[] {
  const chunk = {
    id: done.id,
    object: 'chat.completion.chunk',
    created: done.created,
    model: done.model,
    usage: null,
  };
  return [
    { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'o' } }] },
    { ...chunk, choices: [{ index: 0, delta: { content: 'k' }, finish_reason: 'stop' }] },
    { ...chunk, choices: [], usage: done.usage },
  ];
}

/** A Responses body as documented, with cache and reasoning counters. */
export function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_01J9Z8QK4M',
    object: 'response',
    created_at: 1_727_697_600,
    status: 'completed',
    model: 'gpt-5.4-2026-03-01',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 5620,
      output_tokens: 180,
      total_tokens: 5800,
      input_tokens_details: { cached_tokens: 5533 },
      output_tokens_details: { reasoning_tokens: 30 },
    },
    ...overrides,
  };
}

/** The events of a Responses stream: created, in progress, then the terminal event. */
export function responseEvents(
  done: Record<string, unknown> = response(),
  terminal = 'response.completed',
): unknown[] {
  const pending = { ...done, status: 'in_progress', output: [], usage: null };
  return [
    { type: 'response.created', sequence_number: 0, response: pending },
    { type: 'response.in_progress', sequence_number: 1, response: pending },
    { type: terminal, sequence_number: 2, response: done },
  ];
}

/** An Embeddings body as documented. */
export function embedding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'list',
    data: [
      { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
      { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
    ],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 8, total_tokens: 8 },
    ...overrides,
  };
}

export async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}
