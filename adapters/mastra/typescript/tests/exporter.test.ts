import type { ObservabilityInstanceConfig } from '@mastra/core/observability';
import { ConfigurationError, type Client } from '@openaudr/audr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudrExporter } from '../src/index.js';
import { ended, harness, LLM_USAGE, modelSpan, toolSpan, TRACE_ID } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('constructor', () => {
  it.each([undefined, null, {}, { record: 'no' }])(
    'rejects a client without record()',
    (candidate) => {
      expect(() => new AudrExporter({ client: candidate as unknown as Client })).toThrow(
        ConfigurationError,
      );
    },
  );

  it('rejects a client without flush()', () => {
    expect(
      () =>
        new AudrExporter({
          client: { record: () => ({ outcome: 'queued', queued: true, issues: [] }) } as never,
        }),
    ).toThrow(ConfigurationError);
  });
});

describe('generation records', () => {
  it('builds the expected generation record', async () => {
    const h = harness({ attributionDefaults: { environment: 'staging', account_id: 'a' } });
    await h.exporter.exportTracingEvent(ended(modelSpan()));
    const [record] = await h.records();
    expect(record).toMatchObject({
      spec_version: '1.0.0',
      emitter: { component: 'harness', name: 'mastra-tests', version: '0' },
      timing: { duration_ms: 1234 },
      resource: {
        provider: 'openai',
        type: 'model',
        name: 'gpt-5.4',
        operation: 'generation',
        modality: 'text',
      },
      usage: { llm: LLM_USAGE },
      run: { run_id: TRACE_ID, trace_id: TRACE_ID, span_id: 'bbbbbbbbbbbbbbbb' },
      attribution: { environment: 'staging', account_id: 'a' },
    });
    expect(record!.record_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record!.run).not.toHaveProperty('parent_span_id');
    expect(record!.run).not.toHaveProperty('error_code');
    expect(record).not.toHaveProperty('cost');
  });

  it('prefers responseModel over model', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent(
      ended(
        modelSpan({
          attributes: {
            provider: 'openai.chat',
            model: 'gpt-5.4',
            responseModel: 'gpt-5.4-2026-01-01',
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        }),
      ),
    );
    const [record] = await h.records();
    expect(record!.resource.name).toBe('gpt-5.4-2026-01-01');
  });

  it('skips silently when usage is absent', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent(
      ended(modelSpan({ attributes: { provider: 'openai.chat', model: 'm' } })),
    );
    expect(await h.records()).toHaveLength(0);
    expect(h.logger.lines).toEqual([]);
  });

  it('records failed generations that still have usage', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent(
      ended(
        modelSpan({
          errorInfo: { message: 'secret failure' },
        }),
      ),
    );
    const [record] = await h.records();
    expect(record!.run.error_code).toBe('MASTRA_MODEL_ERROR');
    expect(JSON.stringify(record)).not.toContain('secret');
  });
});

describe('tool records', () => {
  it('records tool_call and mcp_tool_call', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent(ended(toolSpan()));
    await h.exporter.exportTracingEvent(
      ended(toolSpan({ entityName: 'mcp-tool' }, 'mcp_tool_call')),
    );
    const records = await h.records();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      resource: {
        provider: 'self-hosted',
        type: 'tool',
        name: 'lookup',
        operation: 'tool_execution',
      },
      usage: { tool: { type: 'invocation', call_count: 1 } },
    });
    expect(records[1]!.resource.name).toBe('mcp-tool');
  });

  it('warns when entityName is missing', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent(ended(toolSpan({ entityName: '' })));
    expect(h.logger.warnings[0]).toMatch(/RESOURCE_UNRESOLVED.*span=tool_call/);
    expect(await h.records()).toHaveLength(0);
  });

  it('marks failed tools', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent(ended(toolSpan({ errorInfo: { message: 'boom' } })));
    const [record] = await h.records();
    expect(record!.run.error_code).toBe('MASTRA_TOOL_ERROR');
  });
});

describe('ignored events', () => {
  it('ignores non-ended events and other span types', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent({
      type: 'span_started' as never,
      exportedSpan: modelSpan(),
    });
    await h.exporter.exportTracingEvent(ended(modelSpan({ type: 'model_step' as never })));
    expect(await h.records()).toHaveLength(0);
  });
});

describe('warnings', () => {
  it('RESOURCE_UNRESOLVED carries no record values', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent(
      ended(
        modelSpan({
          attributes: { model: 'secret-model-xyz', usage: { inputTokens: 1, outputTokens: 1 } },
        }),
      ),
    );
    expect(h.logger.warnings[0]).toMatch(/RESOURCE_UNRESOLVED/);
    expect(h.logger.warnings[0]).not.toContain('secret-model-xyz');
  });

  it('ATTRIBUTION_UNRESOLVED', async () => {
    const h = harness({ attributionDefaults: undefined });
    await h.exporter.exportTracingEvent(ended(modelSpan()));
    expect(h.logger.warnings[0]).toMatch(/ATTRIBUTION_UNRESOLVED/);
  });

  it('ATTRIBUTION_UNRESOLVED on tools', async () => {
    const h = harness({ attributionDefaults: undefined });
    await h.exporter.exportTracingEvent(ended(toolSpan()));
    expect(h.logger.warnings[0]).toMatch(/ATTRIBUTION_UNRESOLVED.*span=tool_call/);
  });

  it('RECORD_NOT_QUEUED names only the issue codes and paths', async () => {
    const h = harness({ attributionDefaults: { environment: 'production' } });
    await h.exporter.exportTracingEvent(ended(modelSpan()));
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-mastra: RECORD_NOT_QUEUED (outcome=rejected_invalid, issues=REQUIRED@/attribution/account_id)',
    ]);
  });
});

describe('lifecycle', () => {
  it('init warns when excludeSpanTypes drops metered spans', () => {
    const h = harness();
    h.exporter.init({
      config: {
        name: 'x',
        serviceName: 'y',
        excludeSpanTypes: ['model_generation'],
      } as ObservabilityInstanceConfig,
    });
    expect(h.logger.warnings[0]).toMatch(/CONFIG_DROPS_SPANS.*setting=excludeSpanTypes/);
  });

  it('init warns when sampling drops spans', () => {
    const h = harness();
    h.exporter.init({
      config: {
        name: 'x',
        serviceName: 'y',
        sampling: { type: 'never' },
      } as ObservabilityInstanceConfig,
    });
    expect(h.logger.warnings[0]).toMatch(/CONFIG_DROPS_SPANS.*setting=sampling/);
  });

  it('keeps a short caller-supplied traceId as run_id but not as trace_id', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent(ended(modelSpan({ traceId: 'abcdef12' })));
    const [record] = await h.records();
    expect(record!.run.run_id).toBe('abcdef12');
    expect(record!.run).not.toHaveProperty('trace_id');
  });

  it('includes parent_span_id when set', async () => {
    const h = harness();
    await h.exporter.exportTracingEvent(ended(modelSpan({ parentSpanId: 'd'.repeat(16) })));
    const [record] = await h.records();
    expect(record!.run.parent_span_id).toBe('d'.repeat(16));
  });

  it('flush delegates to the client', async () => {
    const h = harness();
    const flush = vi.spyOn(h.client, 'flush');
    await h.exporter.flush();
    expect(flush).toHaveBeenCalled();
  });

  it('flush logs EXPORT_FAILED when client.flush throws', async () => {
    const h = harness({
      client: {
        record: () => ({ outcome: 'queued', queued: true, issues: [] }),
        flush: () => Promise.reject(new TypeError('fail')),
      } as unknown as Client,
    });
    await h.exporter.flush();
    expect(h.logger.errors[0]).toMatch(/EXPORT_FAILED.*error=TypeError/);
  });

  it('shutdown leaves the client running', async () => {
    const h = harness();
    await h.exporter.shutdown();
    expect(h.sink.closed).toBe(false);
  });

  it('a throwing client.record yields EXPORT_FAILED and does not throw', async () => {
    const h = harness({
      client: {
        record: () => {
          throw new TypeError('fail');
        },
        flush: () => Promise.resolve(true),
      } as unknown as Client,
    });
    await expect(h.exporter.exportTracingEvent(ended(modelSpan()))).resolves.toBeUndefined();
    expect(h.logger.errors[0]).toMatch(/EXPORT_FAILED.*error=TypeError/);
  });
});
