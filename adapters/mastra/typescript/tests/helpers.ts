import type { AnyExportedSpan, TracingEvent } from '@mastra/core/observability';
import { type AudrRecord, Client, type Logger } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';

import { AudrExporter, type AudrExporterOptions } from '../src/index.js';

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

export interface Harness {
  readonly sink: MemorySink;
  readonly client: Client;
  readonly logger: CapturingLogger;
  readonly exporter: AudrExporter;
  /** Flushes the client, then returns everything the sink received. */
  readonly records: () => Promise<AudrRecord[]>;
}

export function harness(options: Partial<AudrExporterOptions> = {}): Harness {
  const sink = new MemorySink();
  const client = new Client(sink, {
    emitter: { component: 'harness', name: 'mastra-tests', version: '0' },
  });
  const logger = new CapturingLogger();
  const exporter = new AudrExporter({
    client,
    logger,
    attributionDefaults: { environment: 'test' },
    ...options,
  });
  return {
    sink,
    client,
    logger,
    exporter,
    records: async () => {
      await client.flush();
      return sink.records;
    },
  };
}

const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);

export function modelSpan(
  overrides: Partial<AnyExportedSpan> & {
    attributes?: Record<string, unknown>;
  } = {},
): AnyExportedSpan {
  const start = new Date('2026-01-15T10:00:00.000Z');
  const end = new Date('2026-01-15T10:00:01.234Z');
  return {
    id: SPAN,
    traceId: TRACE,
    name: 'generation',
    type: 'model_generation',
    startTime: start,
    endTime: end,
    isEvent: false,
    isRootSpan: false,
    attributes: {
      provider: 'openai.chat',
      model: 'gpt-5.4',
      usage: {
        inputTokens: 120,
        outputTokens: 50,
        inputDetails: { text: 100, cacheRead: 20 },
        outputDetails: { text: 40, reasoning: 10 },
      },
    },
    metadata: {},
    ...overrides,
  } as AnyExportedSpan;
}

export function toolSpan(
  overrides: Partial<AnyExportedSpan> = {},
  kind: 'tool_call' | 'mcp_tool_call' = 'tool_call',
): AnyExportedSpan {
  const start = new Date('2026-01-15T10:00:00.000Z');
  const end = new Date('2026-01-15T10:00:00.050Z');
  return {
    id: 'c'.repeat(16),
    traceId: TRACE,
    name: 'lookup',
    type: kind,
    entityType: 'tool',
    entityId: 'lookup',
    entityName: 'lookup',
    startTime: start,
    endTime: end,
    isEvent: false,
    isRootSpan: false,
    metadata: {},
    ...overrides,
  } as AnyExportedSpan;
}

export function ended(span: AnyExportedSpan): TracingEvent {
  return { type: 'span_ended' as never, exportedSpan: span };
}

export const LLM_USAGE = {
  input_tokens: 100,
  output_tokens: 40,
  cache_read_tokens: 20,
  reasoning_tokens: 10,
};

export const TRACE_ID = TRACE;
