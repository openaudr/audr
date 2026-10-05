import type {
  AnyExportedSpan,
  InitExporterOptions,
  ModelInferenceAttributes,
  ObservabilityExporter,
  RagEmbeddingAttributes,
  TracingEvent,
} from '@mastra/core/observability';
import type { IMastraLogger } from '@mastra/core/logger';
import {
  type Attribution,
  type Client,
  ConfigurationError,
  createRecord,
  type Logger,
  type Resource,
  type Usage,
} from '@openaudr/audr';

import { resolveAttribution } from './attribution.js';
import { Diagnostics, errorName, formatIssues, SILENT } from './diagnostics.js';
import {
  MODEL_ERROR_CODE,
  nonEmpty,
  providerSlug,
  spanTiming,
  TOOL_ERROR_CODE,
  TOOL_PROVIDER,
  toLlmUsage,
} from './mapping.js';

type MeteredSpanType = 'model_inference' | 'rag_embedding' | 'tool_call' | 'mcp_tool_call';

const METERED_SPAN_TYPES: ReadonlySet<string> = new Set<MeteredSpanType>([
  'model_inference',
  'rag_embedding',
  'tool_call',
  'mcp_tool_call',
]);
const DELEGATION_SPAN_TYPES: ReadonlySet<string> = new Set(['agent_run', 'workflow_run']);
const REQUIRED_SPAN_TYPES: ReadonlySet<string> = new Set([
  ...METERED_SPAN_TYPES,
  ...DELEGATION_SPAN_TYPES,
]);

/** Mastra accepts a caller-supplied `traceId` of 1 to 32 hex digits; AUDR needs exactly 32. */
const W3C_TRACE_ID = /^[0-9a-f]{32}$/;

/** What a metered span contributes to its record. */
interface Metered {
  readonly resource: Resource;
  readonly usage: Usage;
  readonly errorCode: string;
}

/** Options for {@link AudrExporter}. */
export interface AudrExporterOptions {
  /** Host-owned client; the exporter never shuts it down. */
  readonly client: Client;
  readonly attributionDefaults?: Attribution | undefined;
  /** Default: Mastra's logger after registration; silent beforehand. */
  readonly logger?: Logger | undefined;
}

/**
 * Mastra observability exporter that turns ended `model_inference`, `rag_embedding`,
 * `tool_call` and `mcp_tool_call` spans into AUDR records for the host's `client`.
 */
export class AudrExporter implements ObservabilityExporter {
  readonly name = 'audr';

  readonly #client: Client;
  readonly #defaults: Attribution | undefined;
  readonly #hasExplicitLogger: boolean;
  readonly #openToolSpans = new Set<string>();
  readonly #delegationToolSpans = new Set<string>();
  #diagnostics: Diagnostics;

  constructor(options: AudrExporterOptions) {
    const client = options.client as Partial<Client> | undefined;
    if (typeof client?.record !== 'function') {
      throw new ConfigurationError('client must implement record()');
    }
    if (typeof client.flush !== 'function') {
      throw new ConfigurationError('client must implement flush()');
    }
    this.#client = options.client;
    this.#defaults = options.attributionDefaults;
    this.#hasExplicitLogger = options.logger !== undefined;
    this.#diagnostics = new Diagnostics(options.logger ?? SILENT);
  }

  /** Uses Mastra's logger unless the host supplied the adapter-specific `logger` option. */
  __setLogger(logger: IMastraLogger): void {
    if (!this.#hasExplicitLogger) this.#diagnostics = new Diagnostics(logger);
  }

  /** Warns when the observability config omits metered spans or delegation markers. */
  init({ config }: InitExporterOptions): void {
    const sampling = config?.sampling?.type as string | undefined;
    if (sampling !== undefined && sampling !== 'always') {
      this.#diagnostics.warn('CONFIG_DROPS_SPANS', { setting: 'sampling' });
    }
    if (config?.excludeSpanTypes?.some((type) => REQUIRED_SPAN_TYPES.has(type))) {
      this.#diagnostics.warn('CONFIG_DROPS_SPANS', { setting: 'excludeSpanTypes' });
    }
    if (config?.includeInternalSpans !== true) {
      this.#diagnostics.warn('CONFIG_DROPS_SPANS', { setting: 'includeInternalSpans' });
    }
  }

  exportTracingEvent(event: TracingEvent): Promise<void> {
    try {
      const eventType = event.type as string;
      const span = event.exportedSpan;
      if (eventType === 'span_started') {
        this.#trackStarted(span);
      } else if (eventType === 'span_ended') {
        this.#trackDelegationChild(span);
        try {
          this.#record(span);
        } finally {
          if ((span.type as string) === 'tool_call') this.#finishTool(span.id);
        }
      }
    } catch (error) {
      this.#diagnostics.error('EXPORT_FAILED', { error: errorName(error) });
    }
    return Promise.resolve();
  }

  async flush(): Promise<void> {
    try {
      await this.#client.flush();
    } catch (error) {
      this.#diagnostics.error('EXPORT_FAILED', { error: errorName(error) });
    }
  }

  shutdown(): Promise<void> {
    this.#openToolSpans.clear();
    this.#delegationToolSpans.clear();
    return Promise.resolve();
  }

  #record(span: AnyExportedSpan): void {
    const spanType = span.type as string;
    if (!isMeteredSpanType(spanType)) return;
    const metered = this.#meter(span, spanType);
    if (metered === undefined) return;

    const resolution = resolveAttribution(span.metadata, this.#defaults);
    if (resolution.kind === 'unresolved') {
      this.#diagnostics.warn('ATTRIBUTION_UNRESOLVED', { span: spanType });
      return;
    }

    const timing = spanTiming(span.startTime, span.endTime);
    const result = this.#client.record(
      createRecord({
        timing: { event_time: timing.eventTime, duration_ms: timing.durationMs },
        resource: metered.resource,
        usage: metered.usage,
        run: {
          run_id: span.traceId,
          trace_id: W3C_TRACE_ID.test(span.traceId) ? span.traceId : undefined,
          span_id: span.id,
          parent_span_id: nonEmpty(span.parentSpanId),
          error_code: span.errorInfo === undefined ? undefined : metered.errorCode,
        },
        attribution: resolution.attribution,
      }),
    );
    if (!result.queued) {
      this.#diagnostics.warn('RECORD_NOT_QUEUED', {
        outcome: result.outcome,
        issues: formatIssues(result),
      });
    }
  }

  #meter(span: AnyExportedSpan, spanType: MeteredSpanType): Metered | undefined {
    switch (spanType) {
      case 'model_inference':
        return this.#model(span);
      case 'rag_embedding':
        return this.#embedding(span);
      case 'tool_call':
      case 'mcp_tool_call':
        return this.#tool(span, spanType);
      default: {
        const exhaustive: never = spanType;
        return exhaustive;
      }
    }
  }

  #model(span: AnyExportedSpan): Metered | undefined {
    const attributes = span.attributes as ModelInferenceAttributes | undefined;
    const provider = providerSlug(attributes?.provider);
    const name = nonEmpty(attributes?.responseModel) ?? nonEmpty(attributes?.model);
    if (provider === undefined || name === undefined) {
      this.#diagnostics.warn('RESOURCE_UNRESOLVED', { span: 'model_inference' });
      return undefined;
    }
    return {
      resource: { provider, type: 'model', name, operation: 'generation', modality: 'text' },
      usage: { llm: toLlmUsage(attributes?.usage ?? {}) },
      errorCode: MODEL_ERROR_CODE,
    };
  }

  #embedding(span: AnyExportedSpan): Metered | undefined {
    const attributes = span.attributes as RagEmbeddingAttributes | undefined;
    const provider = providerSlug(attributes?.provider);
    const name = nonEmpty(attributes?.model);
    if (provider === undefined || name === undefined) {
      this.#diagnostics.warn('RESOURCE_UNRESOLVED', { span: 'rag_embedding' });
      return undefined;
    }
    return {
      resource: { provider, type: 'model', name, operation: 'embedding', modality: 'text' },
      usage: { llm: toLlmUsage(attributes?.usage ?? {}) },
      errorCode: MODEL_ERROR_CODE,
    };
  }

  #tool(
    span: AnyExportedSpan,
    spanType: Extract<MeteredSpanType, 'tool_call' | 'mcp_tool_call'>,
  ): Metered | undefined {
    const name = nonEmpty(span.entityName);
    if (name === undefined) {
      this.#diagnostics.warn('RESOURCE_UNRESOLVED', { span: span.type });
      return undefined;
    }
    if (spanType === 'tool_call' && this.#delegationToolSpans.has(span.id)) return undefined;
    return {
      resource: { provider: TOOL_PROVIDER, type: 'tool', name, operation: 'tool_execution' },
      usage: { tool: { type: 'invocation', call_count: 1 } },
      errorCode: TOOL_ERROR_CODE,
    };
  }

  #trackStarted(span: AnyExportedSpan): void {
    const spanType = span.type as string;
    if (spanType === 'tool_call') this.#openToolSpans.add(span.id);
    this.#trackDelegationChild(span);
  }

  #trackDelegationChild(span: AnyExportedSpan): void {
    if (!DELEGATION_SPAN_TYPES.has(span.type)) return;
    const parentSpanId = nonEmpty(span.parentSpanId);
    if (parentSpanId !== undefined && this.#openToolSpans.has(parentSpanId)) {
      this.#delegationToolSpans.add(parentSpanId);
    }
  }

  #finishTool(spanId: string): void {
    this.#openToolSpans.delete(spanId);
    this.#delegationToolSpans.delete(spanId);
  }
}

function isMeteredSpanType(spanType: string): spanType is MeteredSpanType {
  return METERED_SPAN_TYPES.has(spanType);
}
