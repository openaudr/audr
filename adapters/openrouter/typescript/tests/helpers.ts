import { type AudrRecord, Client, type Logger } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';

import { instrumentOpenRouter, type InstrumentOpenRouterOptions } from '../src/index.js';

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

export interface NativeCall {
  /** `resource.method`, e.g. `chat.send`. */
  readonly key: string;
  /** The object the method ran on, to prove a forwarded method keeps its receiver. */
  readonly receiver: unknown;
  readonly args: readonly unknown[];
}

/** What a queued call does: return the answer, return a promise of it, or throw. */
type Answer = () => unknown;

/**
 * A structural stand-in for an `OpenRouter` client: the three metered methods and
 * `generations.getGeneration` answer from per-method queues, and every call is recorded.
 * An empty queue rejects, so a test that triggers an unexpected call fails loudly.
 */
export class FakeOpenRouter {
  readonly calls: NativeCall[] = [];
  readonly #queues = new Map<string, Answer[]>();

  readonly apiKey = 'sk-or-test';
  readonly chat = { send: this.#method('chat.send') };
  readonly responses = { send: this.#method('responses.send') };
  readonly embeddings = { generate: this.#method('embeddings.generate') };
  readonly generations = { getGeneration: this.#method('generations.getGeneration') };
  readonly models = { count: this.#method('models.count') };

  /** Answer the next `key` call with `value`. */
  answer(key: string, value: unknown): this {
    return this.#enqueue(key, () => value);
  }

  /** Reject the next `key` call with `error`. */
  fail(key: string, error: unknown): this {
    return this.#enqueue(key, () => {
      throw error;
    });
  }

  /** Answer the next `key` call only once the returned function is called with the answer. */
  hold(key: string): (value: unknown) => void {
    let release: (value: unknown) => void = () => undefined;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    this.#enqueue(key, () => gate);
    return release;
  }

  /** The `getGeneration` calls made so far. */
  get lookups(): NativeCall[] {
    return this.calls.filter((call) => call.key === 'generations.getGeneration');
  }

  /** A method that uses `this`, to prove forwarded methods are bound to the native object. */
  describe(): string {
    return `client:${this.apiKey}`;
  }

  #enqueue(key: string, answer: Answer): this {
    this.#queues.set(key, [...(this.#queues.get(key) ?? []), answer]);
    return this;
  }

  #method(key: string): (...args: unknown[]) => Promise<unknown> {
    const calls = this.calls;
    const queues = this.#queues;
    return function (this: unknown, ...args: unknown[]): Promise<unknown> {
      calls.push({ key, receiver: this, args });
      const next = queues.get(key)?.shift();
      if (next === undefined) return Promise.reject(new Error(`no ${key} answer queued`));
      return new Promise((resolve) => {
        resolve(next());
      });
    };
  }
}

export interface Harness {
  readonly fake: FakeOpenRouter;
  readonly openrouter: FakeOpenRouter;
  readonly sink: MemorySink;
  readonly client: Client;
  readonly logger: CapturingLogger;
  /** The client's own diagnostics, kept apart from the adapter's. */
  readonly clientLogger: CapturingLogger;
  /** Flush the client and return every record the sink has accepted. */
  records(): Promise<AudrRecord[]>;
}

/** Lookup bounds that keep a retrying test well under a second. */
export const FAST_LOOKUP = { maxWaitMs: 100, initialDelayMs: 1, maxDelayMs: 4 } as const;

export function harness(options: Partial<InstrumentOpenRouterOptions> = {}): Harness {
  const fake = new FakeOpenRouter();
  const sink = new MemorySink();
  const clientLogger = new CapturingLogger();
  const client = new Client(sink, { logger: clientLogger });
  const logger = new CapturingLogger();
  const openrouter = instrumentOpenRouter(fake, {
    client,
    logger,
    attributionDefaults: { environment: 'test' },
    lookup: FAST_LOOKUP,
    ...options,
  });
  return {
    fake,
    openrouter,
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

/** An id of the length OpenRouter gives a generation. */
export const GENERATION_ID = 'gen-1759680000-AbCdEfGhIjKl';

/** Router metadata as the SDK parses it, with `provider` selected among others. */
export function routerMetadata(
  provider: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attempt: 1,
    endpoints: {
      available: [
        { model: 'anthropic/claude-sonnet-4.5', provider: 'Decoy One', selected: false },
        { model: 'anthropic/claude-sonnet-4.5', provider, selected: true },
        { model: 'anthropic/claude-sonnet-4.5', provider: 'Decoy Two', selected: false },
      ],
      total: 3,
    },
    isByok: false,
    region: null,
    requested: 'anthropic/claude-sonnet-4.5',
    strategy: 'default',
    summary: 'routed',
    ...overrides,
  };
}

/** A parsed `getGeneration` response. */
export function generation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      id: GENERATION_ID,
      providerName: 'Amazon Bedrock',
      responseCacheSourceId: null,
      isByok: false,
      upstreamInferenceCost: null,
      totalCost: 0.0123,
      model: 'anthropic/claude-sonnet-4.5',
      ...overrides,
    },
  };
}

/** A parsed Chat usage object: cache and reasoning counters, and a cost. */
export function chatUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    promptTokens: 1000,
    completionTokens: 300,
    totalTokens: 1300,
    promptTokensDetails: { cachedTokens: 600, cacheWriteTokens: 100 },
    completionTokensDetails: { reasoningTokens: 200 },
    cost: 0.0123,
    isByok: false,
    ...overrides,
  };
}

/** A parsed `chat.send()` result with router metadata naming Bedrock. */
export function chatResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GENERATION_ID,
    object: 'chat.completion',
    created: 1759680000,
    model: 'anthropic/claude-sonnet-4.5',
    systemFingerprint: null,
    choices: [{ index: 0, finishReason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: chatUsage(),
    openrouterMetadata: routerMetadata('Amazon Bedrock'),
    ...overrides,
  };
}

/** The AUDR counters `chatUsage()` and `responsesUsage()` map to. */
export const LLM = {
  input_tokens: 300,
  output_tokens: 100,
  cache_read_tokens: 600,
  cache_write_tokens: 100,
  reasoning_tokens: 200,
  requests: 1,
};

/** A parsed Responses usage object. */
export function responsesUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputTokens: 1000,
    inputTokensDetails: { cachedTokens: 600, cacheWriteTokens: 100 },
    outputTokens: 300,
    outputTokensDetails: { reasoningTokens: 200 },
    totalTokens: 1300,
    cost: 0.0123,
    isByok: false,
    ...overrides,
  };
}

/** A parsed `responses.send()` result, or the `response` of a terminal event. */
export function responsesResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GENERATION_ID,
    object: 'response',
    status: 'completed',
    model: 'anthropic/claude-sonnet-4.5',
    createdAt: 1759680000,
    output: [],
    usage: responsesUsage(),
    openrouterMetadata: routerMetadata('Amazon Bedrock'),
    ...overrides,
  };
}

/** A parsed `embeddings.generate()` result. It carries no router metadata. */
export function embeddingsResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GENERATION_ID,
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
    model: 'openai/text-embedding-3-small',
    usage: { promptTokens: 8, totalTokens: 8, cost: 0.00000016, isByok: false },
    ...overrides,
  };
}

/** An event stream of `frames`; `failAfter` errors the body after that many frames. */
export function eventStream<T>(
  frames: readonly T[],
  options: { failAfter?: number } = {},
): ReadableStream<T> {
  let sent = 0;
  return new ReadableStream<T>({
    pull(controller) {
      if (options.failAfter !== undefined && sent === options.failAfter) {
        controller.error(new TypeError('network'));
        return;
      }
      const frame = frames[sent];
      if (frame === undefined) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(frame);
    },
  });
}

/** Chat chunks: two deltas, then the chunk that carries `usage`. */
export function chatChunks(final: Record<string, unknown> = chatResult()): unknown[] {
  const delta = (text: string): Record<string, unknown> => ({
    id: GENERATION_ID,
    object: 'chat.completion.chunk',
    created: 1759680000,
    model: 'anthropic/claude-sonnet-4.5',
    choices: [{ index: 0, delta: { content: text } }],
  });
  return [delta('a'), delta('b'), { ...final, object: 'chat.completion.chunk', choices: [] }];
}

/** Responses events: a delta, then the terminal event `type` carrying `response`. */
export function responsesEvents(
  type: 'response.completed' | 'response.failed' | 'response.incomplete' = 'response.completed',
  response: Record<string, unknown> = responsesResult(),
): unknown[] {
  return [
    { type: 'response.created', sequenceNumber: 0, response: responsesResult({ usage: null }) },
    { type: 'response.output_text.delta', sequenceNumber: 1, delta: 'a' },
    { type, sequenceNumber: 2, response },
  ];
}

export async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
