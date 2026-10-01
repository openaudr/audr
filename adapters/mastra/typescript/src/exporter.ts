import type {
  AnyExportedSpan,
  InitExporterOptions,
  ModelGenerationAttributes,
  ObservabilityExporter,
  TracingEvent,
} from '@mastra/core/observability';
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

const METERED_SPAN_TYPES: ReadonlySet<unknown> = new Set([
  'model_generation',
  'tool_call',
  'mcp_tool_call',
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
  /** Default: silent. */
  readonly logger?: Logger | undefined;
}

/**
 * Mastra observability exporter that turns ended `model_generation`, `tool_call` and
 * `mcp_tool_call` spans into AUDR records for the host's `client`.
 */
export class AudrExporter implements ObservabilityExporter {
  readonly name = 'audr';

  readonly #client: Client;
  readonly #defaults: Attribution | undefined;
  readonly #diagnostics: Diagnostics;

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
    this.#diagnostics = new Diagnostics(options.logger ?? SILENT);
  }

  /** Warns when the observability config would keep metered spans from reaching the exporter. */
  init({ config }: InitExporterOptions): void {
    const sampling = config?.sampling?.type as string | undefined;
    if (sampling !== undefined && sampling !== 'always') {
      this.#diagnostics.warn('CONFIG_DROPS_SPANS', { setting: 'sampling' });
    }
    if (config?.excludeSpanTypes?.some((type) => METERED_SPAN_TYPES.has(type))) {
      this.#diagnostics.warn('CONFIG_DROPS_SPANS', { setting: 'excludeSpanTypes' });
    }
  }

  exportTracingEvent(event: TracingEvent): Promise<void> {
    try {
      if ((event.type as string) === 'span_ended') this.#record(event.exportedSpan);
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
    return Promise.resolve();
  }

  #record(span: AnyExportedSpan): void {
    const spanType = span.type as string;
    if (!METERED_SPAN_TYPES.has(spanType)) return;
    const metered = spanType === 'model_generation' ? this.#generation(span) : this.#tool(span);
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

  /** A generation with no reported usage is skipped silently; Mastra had nothing to meter. */
  #generation(span: AnyExportedSpan): Metered | undefined {
    const attributes = span.attributes as ModelGenerationAttributes | undefined;
    const llm = attributes?.usage === undefined ? undefined : toLlmUsage(attributes.usage);
    if (llm === undefined) return undefined;

    const provider = providerSlug(attributes?.provider);
    const name = nonEmpty(attributes?.responseModel) ?? nonEmpty(attributes?.model);
    if (provider === undefined || name === undefined) {
      this.#diagnostics.warn('RESOURCE_UNRESOLVED', { span: 'model_generation' });
      return undefined;
    }
    return {
      resource: { provider, type: 'model', name, operation: 'generation', modality: 'text' },
      usage: { llm },
      errorCode: MODEL_ERROR_CODE,
    };
  }

  #tool(span: AnyExportedSpan): Metered | undefined {
    const name = nonEmpty(span.entityName);
    if (name === undefined) {
      this.#diagnostics.warn('RESOURCE_UNRESOLVED', { span: span.type });
      return undefined;
    }
    return {
      resource: { provider: TOOL_PROVIDER, type: 'tool', name, operation: 'tool_execution' },
      usage: { tool: { type: 'invocation', call_count: 1 } },
      errorCode: TOOL_ERROR_CODE,
    };
  }
}
