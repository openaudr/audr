/** The hooks called directly with hand-built events, a real `Client` and a `MemorySink`. */
import type { Telemetry } from 'ai';
import { type Client, ConfigurationError } from '@openaudr/audr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { audrTelemetry, TOOL_ERROR_CODE } from '../src/index.js';
import { harness, LLM_USAGE, SDK_USAGE } from './helpers.js';

type Hooks = Required<Omit<Telemetry, 'executeLanguageModelCall'>>;
type EventOf<K extends keyof Hooks> = Parameters<Hooks[K]>[0];

function hooks(telemetry: Telemetry): Hooks {
  return telemetry as Hooks;
}

function start(
  callId: string,
  overrides: Partial<{ operationId: string; functionId: string; runtimeContext: unknown }> = {},
): EventOf<'onStart'> {
  return {
    callId,
    operationId: 'ai.generateText',
    provider: 'openai.chat',
    modelId: 'gpt-5.4',
    runtimeContext: {},
    ...overrides,
  } as unknown as EventOf<'onStart'>;
}

function modelEnd(
  callId: string,
  overrides: Partial<{ provider: string; modelId: string; responseTimeMs: number }> = {},
): EventOf<'onLanguageModelCallEnd'> {
  return {
    callId,
    provider: overrides.provider ?? 'openai.chat',
    modelId: overrides.modelId ?? 'gpt-5.4',
    usage: SDK_USAGE,
    performance: { responseTimeMs: overrides.responseTimeMs ?? 812.4 },
  } as unknown as EventOf<'onLanguageModelCallEnd'>;
}

function toolEnd(
  callId: string,
  toolCallId: string,
  outcome: 'tool-result' | 'tool-error' = 'tool-result',
): EventOf<'onToolExecutionEnd'> {
  return {
    callId,
    toolExecutionMs: 12,
    toolCall: { toolCallId, toolName: 'lookup' },
    toolOutput: { type: outcome },
  } as unknown as EventOf<'onToolExecutionEnd'>;
}

function embedEvent(callId: string, embedCallId: string, tokens = 7): EventOf<'onEmbedEnd'> {
  return {
    callId,
    embedCallId,
    operationId: 'ai.embed',
    provider: 'openai.embedding',
    modelId: 'text-embedding-3-small',
    usage: { tokens },
  } as unknown as EventOf<'onEmbedEnd'>;
}

function rerankEvent(callId: string): EventOf<'onRerankEnd'> {
  return {
    callId,
    operationId: 'ai.rerank',
    provider: 'cohere.reranking',
    modelId: 'rerank-v3.5',
  } as unknown as EventOf<'onRerankEnd'>;
}

function end(callId: string): EventOf<'onEnd'> {
  return { callId } as unknown as EventOf<'onEnd'>;
}

/** Throws `value` as is, so the non-`Error` path can be exercised. */
function raise(value: unknown): never {
  throw value;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('option validation', () => {
  it.each([undefined, null, {}, { record: 'no' }])(
    'rejects a client without record()',
    (candidate) => {
      expect(() => audrTelemetry({ client: candidate as unknown as Client })).toThrow(
        new ConfigurationError('client must implement record()'),
      );
    },
  );

  it('accepts a structural client and logs nothing by default', () => {
    const record = vi.fn(() => ({ outcome: 'queued' as const, queued: true, issues: [] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = hooks(audrTelemetry({ client: { record } as unknown as Client }));
    t.onStart(start('call-00000001'));
    t.onStart(null as never);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('host owns the client', () => {
  it('submits to the client and leaves it open', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    t.onLanguageModelCallEnd(modelEnd('call-00000001'));
    t.onEnd(end('call-00000001'));
    expect(h.client.stats.submitted).toBe(1);
    expect(h.sink.closed).toBe(false);
    expect(await h.records()).toHaveLength(1);
    expect(h.client.record((await h.records())[0]!).queued).toBe(true);
  });
});

describe('generation record', () => {
  it('builds the exact generation record', async () => {
    const h = harness({ attributionDefaults: { environment: 'staging', account_id: 'a' } });
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { functionId: 'support' }));
    t.onLanguageModelCallEnd(modelEnd('call-00000001', { modelId: 'gpt-5.4-2026-01-01' }));
    const [record] = await h.records();
    expect(record).toMatchObject({
      spec_version: '1.0.0',
      emitter: { component: 'harness', name: 'vercel-ai-tests' },
      timing: { duration_ms: 812 },
      resource: {
        provider: 'openai',
        type: 'model',
        name: 'gpt-5.4-2026-01-01',
        operation: 'generation',
        modality: 'text',
      },
      usage: { llm: LLM_USAGE },
      run: {
        run_id: 'call-00000001',
        span_id: 'model:call-00000001:0',
        step: 0,
        run_type: 'agent_run',
        name: 'support',
      },
      attribution: { environment: 'staging', account_id: 'a' },
    });
    expect(record!.record_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record!.run).not.toHaveProperty('parent_span_id');
    expect(record!.run).not.toHaveProperty('error_code');
    expect(record).not.toHaveProperty('cost');
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'omits duration_ms for responseTimeMs %s',
    async (responseTimeMs) => {
      const h = harness();
      const t = hooks(h.telemetry);
      t.onStart(start('call-00000001'));
      t.onLanguageModelCallEnd(modelEnd('call-00000001', { responseTimeMs }));
      const [record] = await h.records();
      expect(record!.timing).not.toHaveProperty('duration_ms');
    },
  );

  it('mapResource overrides provider and name', async () => {
    const mapResource = vi.fn(() => ({ provider: 'openai', name: 'gpt-5.4-custom' }));
    const h = harness({ mapResource });
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    t.onLanguageModelCallEnd(modelEnd('call-00000001', { provider: 'my-proxy.chat' }));
    const [record] = await h.records();
    expect(record!.resource).toMatchObject({ provider: 'openai', name: 'gpt-5.4-custom' });
    expect(mapResource).toHaveBeenCalledWith({ provider: 'my-proxy.chat', modelId: 'gpt-5.4' });
  });

  it.each([undefined, null])('mapResource returning %s keeps the default', async (none) => {
    const h = harness({ mapResource: () => none });
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    t.onLanguageModelCallEnd(modelEnd('call-00000001', { provider: 'anthropic.messages' }));
    const [record] = await h.records();
    expect(record!.resource).toMatchObject({ provider: 'anthropic', name: 'gpt-5.4' });
    expect(h.logger.lines).toEqual([]);
  });
});

describe('tool execution record', () => {
  it('marks a failed tool with the error code', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    t.onToolExecutionEnd(toolEnd('call-00000001', 'tc-1'));
    t.onToolExecutionEnd(toolEnd('call-00000001', 'tc-2', 'tool-error'));
    const records = await h.records();
    expect(records.map((r) => r.run.error_code)).toEqual([undefined, TOOL_ERROR_CODE]);
    expect(records[1]).toMatchObject({
      timing: { duration_ms: 12 },
      resource: {
        provider: 'self-hosted',
        type: 'tool',
        name: 'lookup',
        operation: 'tool_execution',
      },
      usage: { tool: { type: 'invocation', call_count: 1 } },
      run: { span_id: 'tool:call-00000001:1:tc-2', step: 1 },
    });
    expect(records[1]!.resource).not.toHaveProperty('modality');
  });

  it('onToolExecutionStart for an untracked call does nothing', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onToolExecutionStart(toolEnd('call-unknown01', 'tc'));
    expect(await h.records()).toEqual([]);
    expect(h.logger.lines).toEqual([]);
  });
});

describe('embedding and reranking', () => {
  it('measures embedding duration from its start', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1042.6);
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { operationId: 'ai.embed' }));
    t.onEmbedStart(embedEvent('call-00000001', 'call-embed0001'));
    t.onEmbedEnd(embedEvent('call-00000001', 'call-embed0001'));
    const [record] = await h.records();
    expect(now).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({
      timing: { duration_ms: 43 },
      resource: { operation: 'embedding', provider: 'openai' },
      usage: { llm: { input_tokens: 7, requests: 1 } },
      run: { span_id: 'embed:call-embed0001', run_type: 'single_call' },
    });
  });

  it.each([Number.NaN, -3, 2.5])('omits embedding input_tokens %s', async (tokens) => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { operationId: 'ai.embed' }));
    t.onEmbedEnd(embedEvent('call-00000001', 'call-embed0001', tokens));
    const [record] = await h.records();
    expect(record!.usage.llm).toEqual({ requests: 1 });
    expect(record!.timing).not.toHaveProperty('duration_ms');
  });

  it('numbers reranks and measures them from their start', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(15);
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { operationId: 'ai.rerank' }));
    t.onRerankStart(rerankEvent('call-00000001') as unknown as EventOf<'onRerankStart'>);
    t.onRerankEnd(rerankEvent('call-00000001'));
    t.onRerankEnd(rerankEvent('call-00000001'));
    const records = await h.records();
    expect(records.map((r) => r.run.span_id)).toEqual([
      'rerank:call-00000001:0',
      'rerank:call-00000001:1',
    ]);
    expect(records[0]!.timing.duration_ms).toBe(5);
    expect(records[1]!.timing).not.toHaveProperty('duration_ms');
    expect(records[0]!.usage.llm).toEqual({ requests: 1 });
  });

  it('ignores embed and rerank starts for untracked calls', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onEmbedStart(embedEvent('call-unknown01', 'call-embed0001'));
    t.onRerankStart(rerankEvent('call-unknown01') as never);
    t.onEmbedEnd(embedEvent('call-unknown01', 'call-embed0001'));
    t.onRerankEnd(rerankEvent('call-unknown01'));
    expect(await h.records()).toEqual([]);
    expect(h.logger.lines).toEqual([]);
  });
});

describe('run identifiers', () => {
  it('run type follows the root operation', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    const operations = [
      'ai.generateText',
      'ai.streamText',
      'ai.embed',
      'ai.embedMany',
      'ai.rerank',
    ];
    operations.forEach((operationId, i) => {
      const callId = `call-0000000${String(i)}`;
      t.onStart(start(callId, { operationId }));
      t.onLanguageModelCallEnd(modelEnd(callId));
    });
    const records = await h.records();
    expect(records.map((r) => r.run.run_type)).toEqual([
      'agent_run',
      'agent_run',
      'single_call',
      'single_call',
      'single_call',
    ]);
  });

  it('an empty functionId sets no run name', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { functionId: '' }));
    t.onLanguageModelCallEnd(modelEnd('call-00000001'));
    const [record] = await h.records();
    expect(record!.run).not.toHaveProperty('name');
  });
});

describe('attribution at onStart', () => {
  it('skips an operation without environment, logging only the operation id', async () => {
    const h = harness({ attributionDefaults: { account_id: 'acct_42' } });
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { operationId: 'ai.embed' }));
    t.onEmbedEnd(embedEvent('call-00000001', 'call-embed0001'));
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-vercel-ai: ATTRIBUTION_UNRESOLVED (operation=ai.embed)',
    ]);
  });

  it('the snapshot taken at onStart is not changed by later events', async () => {
    const context = { audr: { environment: 'test', account_id: 'first' } };
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { runtimeContext: context }));
    context.audr.account_id = 'second';
    t.onLanguageModelCallEnd(modelEnd('call-00000001'));
    const [record] = await h.records();
    expect(record!.attribution.account_id).toBe('first');
  });
});

describe('state cleanup', () => {
  it('an embed attempt that never ends is released with its run, without a warning', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(130);
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { operationId: 'ai.embed' }));
    t.onEmbedStart(embedEvent('call-00000001', 'call-embed0001'));
    t.onEmbedStart(embedEvent('call-00000001', 'call-embed0002'));
    t.onEmbedEnd(embedEvent('call-00000001', 'call-embed0002'));
    t.onEnd(end('call-00000001'));
    const [record] = await h.records();
    expect(record!.timing.duration_ms).toBe(30);
    expect(h.logger.lines).toEqual([]);
  });

  it('a retried rerank is measured from its last attempt', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(58);
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { operationId: 'ai.rerank' }));
    t.onRerankStart(rerankEvent('call-00000001') as unknown as EventOf<'onRerankStart'>);
    t.onRerankStart(rerankEvent('call-00000001') as unknown as EventOf<'onRerankStart'>);
    t.onRerankEnd(rerankEvent('call-00000001'));
    const [record] = await h.records();
    expect(record!.timing.duration_ms).toBe(8);
  });

  it.each([
    ['onEnd', (t: Hooks) => t.onEnd(end('call-00000001'))],
    ['onAbort', (t: Hooks) => t.onAbort({ callId: 'call-00000001', steps: [] })],
    ['onError', (t: Hooks) => t.onError({ callId: 'call-00000001', error: new Error('x') })],
  ])('%s releases the run', async (_, release) => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    release(t);
    t.onLanguageModelCallEnd(modelEnd('call-00000001'));
    t.onEnd(end('call-00000001'));
    expect(await h.records()).toEqual([]);
    expect(h.logger.lines).toEqual([]);
  });

  it.each([undefined, null, 'error', { callId: 42 }, new Error('x')])(
    'onError ignores a payload without a string callId',
    (payload) => {
      const h = harness();
      const t = hooks(h.telemetry);
      t.onStart(start('call-00000001'));
      t.onError(payload);
      t.onLanguageModelCallEnd(modelEnd('call-00000001'));
      expect(h.client.stats.submitted).toBe(1);
      expect(h.logger.lines).toEqual([]);
    },
  );
});

describe('hooks never break generation', () => {
  it('a throwing client is logged as HOOK_FAILED', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const client = {
      record: () => {
        throw new TypeError('secret');
      },
    } as unknown as Client;
    const t = hooks(
      audrTelemetry({ client, logger, attributionDefaults: { environment: 'test' } }),
    );
    t.onStart(start('call-00000001'));
    expect(() => {
      t.onLanguageModelCallEnd(modelEnd('call-00000001'));
    }).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      '@openaudr/audr-adapter-vercel-ai: HOOK_FAILED (hook=onLanguageModelCallEnd, error=TypeError)',
    );
  });

  it('a throwing mapResource skips the record with MAP_RESOURCE_FAILED', async () => {
    const h = harness({
      mapResource: () => raise('not an error'),
    });
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    t.onLanguageModelCallEnd(modelEnd('call-00000001'));
    expect(await h.records()).toEqual([]);
    expect(h.logger.errors).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-vercel-ai: MAP_RESOURCE_FAILED (operation=ai.generateText, error=string)',
    ]);
  });

  it('a malformed event is logged as HOOK_FAILED in every hook', () => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    const bad = null as never;
    t.onStart(bad);
    t.onLanguageModelCallEnd(bad);
    t.onToolExecutionStart(bad);
    t.onToolExecutionEnd(bad);
    t.onEmbedStart(bad);
    t.onEmbedEnd(bad);
    t.onRerankStart(bad);
    t.onRerankEnd(bad);
    t.onEnd(bad);
    t.onAbort(bad);
    t.onLanguageModelCallEnd({ callId: 'call-00000001' } as never);
    t.onToolExecutionEnd({ callId: 'call-00000001' } as never);
    expect(h.logger.errors.map((line) => /hook=(\w+)/.exec(line)?.[1])).toEqual([
      'onStart',
      'onLanguageModelCallEnd',
      'onToolExecutionStart',
      'onToolExecutionEnd',
      'onEmbedStart',
      'onEmbedEnd',
      'onRerankStart',
      'onRerankEnd',
      'onEnd',
      'onAbort',
      'onLanguageModelCallEnd',
      'onToolExecutionEnd',
    ]);
  });

  it('a throwing logger is ignored', () => {
    const logger = {
      warn: () => {
        throw new Error('logger down');
      },
      error: () => {
        throw new Error('logger down');
      },
    };
    const { client } = harness();
    const t = hooks(audrTelemetry({ client, logger }));
    expect(() => {
      t.onStart(start('call-00000001'));
      t.onStart(null as never);
    }).not.toThrow();
  });

  it('executeTool runs execute when its options cannot be read', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    const options = {
      get callId(): string {
        throw new RangeError('bad');
      },
      toolCallId: 'tc',
      execute: () => Promise.resolve(42),
    };
    await expect(t.executeTool(options)).resolves.toBe(42);
    expect(h.logger.errors).toEqual([
      '@openaudr/audr-adapter-vercel-ai: HOOK_FAILED (hook=executeTool, error=RangeError)',
    ]);
  });

  it('executeTool for an untracked call runs execute as is', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    const error = new Error('x');
    await expect(
      t.executeTool({ callId: 'nope', toolCallId: 'tc', execute: () => Promise.reject(error) }),
    ).rejects.toBe(error);
  });
});

describe('rejected records are reported without values', () => {
  it('production without an account logs the issue path', async () => {
    const h = harness({ attributionDefaults: { environment: 'production' } });
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    t.onLanguageModelCallEnd(modelEnd('call-00000001'));
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-vercel-ai: RECORD_NOT_QUEUED (outcome=rejected_invalid, operation=ai.generateText, issues=REQUIRED@/attribution/account_id)',
    ]);
  });

  it('a client that has shut down reports the outcome without issues', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    await h.client.shutdown();
    t.onToolExecutionEnd(toolEnd('call-00000001', 'tc'));
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-vercel-ai: RECORD_NOT_QUEUED (outcome=dropped_not_running, operation=ai.generateText)',
    ]);
  });
});

describe('provider slug', () => {
  it.each([
    ['ai.generateText', 'onLanguageModelCallEnd'],
    ['ai.embed', 'onEmbedEnd'],
    ['ai.rerank', 'onRerankEnd'],
  ] as const)('skips an unmappable provider in %s', async (operationId, hook) => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { operationId }));
    const events = {
      onLanguageModelCallEnd: { ...modelEnd('call-00000001'), provider: '...' },
      onEmbedEnd: { ...embedEvent('call-00000001', 'e1'), provider: '...' },
      onRerankEnd: { ...rerankEvent('call-00000001'), provider: '...' },
    };
    (t[hook] as (event: unknown) => void)(events[hook]);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      `@openaudr/audr-adapter-vercel-ai: PROVIDER_UNMAPPED (operation=${operationId})`,
    ]);
  });

  it.each(['Open AI', 123])('skips a mapResource provider %s', async (provider) => {
    const h = harness({ mapResource: () => ({ provider: provider as string, name: 'x' }) });
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001'));
    t.onLanguageModelCallEnd(modelEnd('call-00000001'));
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-vercel-ai: PROVIDER_UNMAPPED (operation=ai.generateText)',
    ]);
  });
});

describe('unsupported operations', () => {
  it('an object operation is not tracked and is reported once per operation id', async () => {
    const h = harness();
    const t = hooks(h.telemetry);
    t.onStart(start('call-00000001', { operationId: 'ai.generateObject' }));
    t.onStart(start('call-00000002', { operationId: 'ai.generateObject' }));
    t.onStart(start('call-00000003', { operationId: 'ai.streamObject' }));
    t.onLanguageModelCallEnd(modelEnd('call-00000001'));
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-vercel-ai: OPERATION_UNSUPPORTED (operation=ai.generateObject)',
      '@openaudr/audr-adapter-vercel-ai: OPERATION_UNSUPPORTED (operation=ai.streamObject)',
    ]);
  });
});
