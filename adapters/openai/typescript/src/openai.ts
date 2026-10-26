import {
  type Attribution,
  type Client,
  ConfigurationError,
  createRecord,
  type Emitter,
  type Logger,
  type Modality,
  type Operation,
  uuidv7,
} from '@openaudr/audr';

import { currentScope, mergeAttribution, type RunContext } from './attribution.js';
import {
  Diagnostics,
  errorKind,
  formatIssues,
  type IncompleteReason,
  type OperationName,
  SILENT,
} from './diagnostics.js';
import {
  chatModality,
  chatObservation,
  embeddingsObservation,
  type Family,
  fitsRunId,
  isRecord,
  isTerminalType,
  type Observation,
  providerFor,
  responsesObservation,
  statusErrorCode,
  terminalErrorCode,
} from './mapping.js';
import { VERSION } from './version.js';

const EMITTER: Emitter = {
  component: 'harness',
  name: '@openaudr/audr-adapter-openai',
  version: VERSION,
};

/**
 * The native client surface the facade meters. An `OpenAI` or `AzureOpenAI` satisfies it, as
 * does any client of the same shape pointed at an OpenAI-compatible endpoint.
 */
export interface OpenAILike {
  /** Names the provider; see `providerFor`. */
  readonly baseURL?: string | undefined;
  readonly chat: { readonly completions: Creates };
  readonly responses: Creates;
  readonly embeddings: Creates;
}

/** A resource with a `create()` method; the SDK's overloads all satisfy it. */
export interface Creates {
  create(params: unknown, options?: unknown): Promise<unknown>;
}

export interface InstrumentOpenAIOptions {
  /** The host's client. The adapter only calls its `record()`; it never flushes or shuts it down. */
  readonly client: Client;
  /** Applied field by field under `withAudr` attribution. Omit `environment` to require it per scope. */
  readonly attributionDefaults?: Attribution | undefined;
  /**
   * Overrides the provider slug and model name, and names the provider for a `baseURL` the
   * adapter does not know. Returning `undefined` or `null` keeps the default.
   */
  readonly mapResource?:
    ((source: ResourceSource) => ResourceMapping | null | undefined) | undefined;
  /**
   * Where diagnostics go. Default: none. Pass `console` or another logger to receive them.
   * Messages never carry record values.
   */
  readonly logger?: Logger | undefined;
}

export interface ResourceSource {
  /** The client's `baseURL` when the call was made. */
  readonly baseUrl: string | undefined;
  /** The model that served the call, as the response reports it. */
  readonly model: string | undefined;
}

export interface ResourceMapping {
  /** `resource.provider`; it must match `^[a-z0-9-]+$` or the `Client` rejects the record. */
  readonly provider: string;
  readonly name: string;
}

/** A metered call, resolved once when it starts and never changed afterwards. */
interface Call {
  readonly family: Family;
  readonly modality: Modality;
  readonly attribution: Attribution;
  readonly run: RunContext | undefined;
  readonly startedAt: number;
}

const OPERATIONS: Record<
  Family,
  { readonly name: OperationName; readonly span: string; readonly operation: Operation }
> = {
  chat: { name: 'chat.completions.create', span: 'chat', operation: 'generation' },
  responses: { name: 'responses.create', span: 'response', operation: 'generation' },
  embeddings: { name: 'embeddings.create', span: 'embedding', operation: 'embedding' },
};

type NativeStream = AsyncIterable<unknown>;

const instrumented = new WeakSet<object>();

/**
 * Wrap an OpenAI SDK client so that every `chat.completions.create()`, `responses.create()`
 * (both streaming or not) and `embeddings.create()` hands one AUDR record to the host's
 * `client`. The facade has the native client's type; every other resource and method is
 * forwarded untouched, and the native client is never modified.
 *
 * ```ts
 * const openai = instrumentOpenAI(new OpenAI(), {
 *   client,
 *   attributionDefaults: { environment: 'production' },
 * });
 * ```
 *
 * Reads the requested `modalities`, usage, identifiers, the served model and the client's
 * `baseURL` only; never messages, input, output, tools or errors. Metering never changes or
 * fails a native call. Throws `ConfigurationError` when `client` has no `record()` or
 * `openai` is already a facade, which would record every call twice.
 */
export function instrumentOpenAI<C extends OpenAILike>(
  openai: C,
  options: InstrumentOpenAIOptions,
): C {
  if (instrumented.has(openai)) {
    throw new ConfigurationError('openai is already instrumented');
  }
  const meter = new Meter(openai, options);
  const facade = forward(openai, {
    chat: forward(openai.chat, {
      completions: meterCreate(openai.chat.completions, (args, create) =>
        meter.measure('chat', chatModality(args[0]), create),
      ),
    }),
    responses: meterCreate(openai.responses, (_args, create) =>
      meter.measure('responses', 'text', create),
    ),
    embeddings: meterCreate(openai.embeddings, (_args, create) =>
      meter.measure('embeddings', 'text', create),
    ),
  });
  instrumented.add(facade);
  return facade;
}

class Meter {
  readonly #native: OpenAILike;
  readonly #client: Client;
  readonly #defaults: Attribution;
  readonly #mapResource: InstrumentOpenAIOptions['mapResource'];
  readonly #diagnostics: Diagnostics;

  constructor(
    native: OpenAILike,
    { client, attributionDefaults, mapResource, logger }: InstrumentOpenAIOptions,
  ) {
    if (typeof (client as Partial<Client> | undefined)?.record !== 'function') {
      throw new ConfigurationError('client must implement record()');
    }
    this.#native = native;
    this.#client = client;
    this.#defaults = mergeAttribution({}, attributionDefaults);
    this.#mapResource = mapResource;
    this.#diagnostics = new Diagnostics(logger ?? SILENT);
  }

  /** Makes the native call and meters what it returns, which reaches the host unchanged. */
  async measure(
    family: Family,
    modality: Modality,
    create: () => Promise<unknown>,
  ): Promise<unknown> {
    const call = this.#begin(family, modality);
    const result = await create();
    if (call === undefined) return result;
    try {
      if (family !== 'embeddings' && isStream(result)) return this.#meterStream(result, call);
    } catch (error) {
      this.#hookFailed(call, error);
      return result;
    }
    this.#guard(call, () => {
      this.#record(call, this.#observe(call, result));
    });
    return result;
  }

  /** The call's attribution and run, captured where it starts; `undefined` when not metered. */
  #begin(family: Family, modality: Modality): Call | undefined {
    const scope = currentScope();
    const attribution = mergeAttribution(this.#defaults, scope.attribution);
    if (attribution.environment === undefined) {
      this.#diagnostics.warn('ATTRIBUTION_UNRESOLVED', { operation: OPERATIONS[family].name });
      return undefined;
    }
    return { family, modality, attribution, run: scope.run, startedAt: performance.now() };
  }

  #observe(call: Call, result: unknown): Observation {
    switch (call.family) {
      case 'chat':
        return chatObservation(result);
      case 'responses':
        return responsesObservation(
          result,
          statusErrorCode(isRecord(result) ? result.status : undefined),
        );
      case 'embeddings':
        return embeddingsObservation(result);
      default: {
        const unreachable: never = call.family;
        return unreachable;
      }
    }
  }

  /**
   * What a stream frame means: the `Observation` to record, `'error'` for a frame that
   * reports a failure, or `undefined` for a frame that needs no attention. A Chat stream is
   * recorded from the chunk carrying `usage`, which OpenAI sends only when the request sets
   * `stream_options.include_usage`; a Responses stream from its terminal event.
   */
  #inspect(call: Call, frame: unknown): Observation | 'error' | undefined {
    if (!isRecord(frame)) return undefined;
    if (call.family === 'chat') {
      return isRecord(frame.usage) ? chatObservation(frame) : undefined;
    }
    const type = frame.type;
    if (type === 'error') return 'error';
    if (!isTerminalType(type)) return undefined;
    return responsesObservation(frame.response, terminalErrorCode(type));
  }

  /**
   * The native stream behind a proxy that records the frame that completes the call before
   * yielding it. Every frame is yielded unchanged; a stream that ends any other way is
   * reported once as `STREAM_INCOMPLETE`.
   */
  #meterStream(stream: NativeStream, call: Call): NativeStream {
    let open = true;
    const incomplete = (reason: IncompleteReason): void => {
      if (!open) return;
      open = false;
      this.#diagnostics.warn('STREAM_INCOMPLETE', {
        operation: OPERATIONS[call.family].name,
        reason,
      });
    };
    const observe = (frame: unknown): void => {
      if (!open) return;
      this.#guard(call, () => {
        const observed = this.#inspect(call, frame);
        if (observed === undefined) return;
        if (observed === 'error') {
          incomplete('error_frame');
          return;
        }
        open = false;
        this.#record(call, observed);
      });
    };
    async function* iterate(): AsyncGenerator<unknown, void, undefined> {
      try {
        for await (const frame of stream) {
          observe(frame);
          yield frame;
        }
        incomplete('ended');
      } catch (error) {
        incomplete('failed');
        throw error;
      } finally {
        incomplete('abandoned');
      }
    }
    return forward(stream, { [Symbol.asyncIterator]: iterate });
  }

  #record(call: Call, observed: Observation): void {
    const { name: operation, span, operation: kind } = OPERATIONS[call.family];
    const baseUrl = this.#baseUrl();
    const resolved = providerFor(baseUrl);
    const mapped = this.#mapResource?.({ baseUrl, model: observed.model });
    const name = mapped?.name ?? observed.model;
    if (!name) {
      this.#diagnostics.warn('MODEL_UNREPORTED', { operation });
      return;
    }
    const provider = mapped?.provider ?? resolved?.provider;
    if (provider === undefined) {
      this.#diagnostics.warn('PROVIDER_UNRESOLVED', { operation });
      return;
    }
    const id = observed.id ?? uuidv7();
    const run = call.run;
    const submitted = this.#client.record(
      createRecord({
        emitter: EMITTER,
        timing: { duration_ms: Math.round(performance.now() - call.startedAt) },
        resource: {
          provider,
          type: 'model',
          name,
          operation: kind,
          modality: call.modality,
          deployment: resolved?.deployment,
        },
        usage: { llm: observed.usage },
        run: {
          run_id: run?.run_id ?? (fitsRunId(id) ? id : uuidv7()),
          span_id: `${span}:${id}`,
          parent_span_id: run?.parent_span_id,
          name: run?.name,
          run_type: run === undefined ? 'single_call' : 'agent_run',
          error_code: observed.errorCode,
        },
        attribution: call.attribution,
      }),
    );
    if (!submitted.queued) {
      this.#diagnostics.warn('RECORD_NOT_QUEUED', {
        operation,
        outcome: submitted.outcome,
        issues: formatIssues(submitted),
      });
    }
  }

  /** The native client's `baseURL`, read at record time so a client reconfigured later is still right. */
  #baseUrl(): string | undefined {
    const value: unknown = Reflect.get(this.#native, 'baseURL');
    return typeof value === 'string' ? value : undefined;
  }

  /** Runs one metering step; an exception is logged by category and never reaches the host. */
  #guard(call: Call, step: () => void): void {
    try {
      step();
    } catch (error) {
      this.#hookFailed(call, error);
    }
  }

  #hookFailed(call: Call, error: unknown): void {
    this.#diagnostics.error('HOOK_FAILED', {
      operation: OPERATIONS[call.family].name,
      error: errorKind(error),
    });
  }
}

/** `resource` with `create()` metered; every argument is passed to the native method unchanged. */
function meterCreate<R extends { create(...args: never[]): Promise<unknown> }>(
  resource: R,
  meter: (args: readonly unknown[], create: () => Promise<unknown>) => Promise<unknown>,
): R {
  return forward(resource, {
    create: (...args: unknown[]) => meter(args, () => resource.create(...(args as never[]))),
  });
}

function isStream(value: unknown): value is NativeStream {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * A proxy over `target` that answers `overrides` itself and forwards everything else, with
 * methods bound to `target` so that they run exactly as on the native object.
 */
function forward<T extends object>(
  target: T,
  overrides: Readonly<Record<PropertyKey, unknown>>,
): T {
  return new Proxy(target, {
    get(object, key): unknown {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === 'function' ? (value as () => unknown).bind(object) : value;
    },
  });
}
