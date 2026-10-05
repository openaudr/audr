import type { RequestOptions } from '@openrouter/sdk/lib/sdks.js';
import type {
  CreateEmbeddingsRequest,
  CreateResponsesRequest,
  SendChatCompletionRequestRequest,
} from '@openrouter/sdk/models/operations';
import {
  type Attribution,
  type Client,
  ConfigurationError,
  createRecord,
  type Emitter,
  type Logger,
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
  GenerationLookup,
  type GenerationsClient,
  isGenerationId,
  type LookupOptions,
} from './lookup.js';
import {
  chatObservation,
  declaredKinds,
  embeddingsObservation,
  type Facts,
  type Family,
  fitsRunId,
  isRecord,
  isTerminalType,
  type Kind,
  needsLookup,
  type Observation,
  OPENROUTER_PROVIDER,
  providerSlug,
  readRouter,
  resolveCost,
  responsesObservation,
  type Router,
  servedProvider,
  statusErrorCode,
  terminalErrorCode,
} from './mapping.js';
import { forward, isStream, meterStream, type NativeStream, type Verdict } from './proxy.js';
import { VERSION } from './version.js';

const EMITTER: Emitter = {
  component: 'router',
  name: '@openaudr/audr-adapter-openrouter',
  version: VERSION,
};

/** The native client surface the facade meters. An `OpenRouter` satisfies it. */
export interface OpenRouterLike extends GenerationsClient {
  readonly chat: {
    send(request: SendChatCompletionRequestRequest, options?: RequestOptions): Promise<unknown>;
  };
  readonly responses: {
    send(request: CreateResponsesRequest, options?: RequestOptions): Promise<unknown>;
  };
  readonly embeddings: {
    generate(request: CreateEmbeddingsRequest, options?: RequestOptions): Promise<unknown>;
  };
}

export interface InstrumentOpenRouterOptions {
  /** The host's client. The adapter only calls its `record()`; it never flushes or shuts it down. */
  readonly client: Client;
  /** Applied field by field under `withAudr` attribution. Omit `environment` to require it per scope. */
  readonly attributionDefaults?: Attribution | undefined;
  /** Overrides the provider slug and model name. Returning `undefined` or `null` keeps the default. */
  readonly mapResource?:
    ((source: ResourceSource) => ResourceMapping | null | undefined) | undefined;
  /** Bounds on the lookup that names the serving vendor when the result does not. */
  readonly lookup?: LookupOptions | undefined;
  /**
   * Where diagnostics go. Default: none. Pass `console` or another logger to receive them.
   * Messages never carry record values.
   */
  readonly logger?: Logger | undefined;
}

export interface ResourceSource {
  /** The model the response reports, e.g. `anthropic/claude-sonnet-4.5`. */
  readonly model: string | undefined;
  /**
   * The vendor that served the call, as OpenRouter names it (`Amazon Bedrock`), or
   * `openrouter` for a response-cache replay. `undefined` when it could not be resolved, and
   * the record then defaults to `openrouter`.
   */
  readonly vendor: string | undefined;
}

export interface ResourceMapping {
  /** `resource.provider`; it must match `^[a-z0-9-]+$` or the `Client` rejects the record. */
  readonly provider: string;
  readonly name: string;
}

/** What the adapter knows about each metered resource. */
const OPERATIONS = {
  chat: {
    name: 'chat.send',
    span: 'chat',
    operation: 'generation',
    requestBody: 'chatRequest',
  },
  responses: {
    name: 'responses.send',
    span: 'response',
    operation: 'generation',
    requestBody: 'responsesRequest',
  },
  embeddings: {
    name: 'embeddings.generate',
    span: 'embedding',
    operation: 'embedding',
    requestBody: undefined,
  },
} as const satisfies Record<
  Family,
  {
    readonly name: OperationName;
    readonly span: string;
    readonly operation: Operation;
    /** The request property that holds the body, which may declare `modalities`. */
    readonly requestBody: string | undefined;
  }
>;

/** A metered call, resolved once when it starts and never changed afterwards. */
interface Call {
  readonly family: Family;
  readonly declared: ReadonlySet<Kind>;
  readonly attribution: Attribution;
  readonly run: RunContext | undefined;
  readonly startedAt: number;
}

/** When the primary call finished and how long it took, before any lookup. */
interface Timing {
  readonly completedAt: Date;
  readonly durationMs: number;
}

type Inspector = (frame: unknown) => Promise<Verdict>;

const instrumented = new WeakSet<object>();

/**
 * Wrap an `OpenRouter` so that every `chat.send()`, `responses.send()` (streaming or not)
 * and `embeddings.generate()` hands one AUDR record to the host's `client`. The facade has
 * the native client's type; every other resource and method is forwarded untouched, and the
 * native client is never modified.
 *
 * ```ts
 * const openrouter = instrumentOpenRouter(new OpenRouter({ apiKey }), {
 *   client,
 *   attributionDefaults: { environment: 'production' },
 * });
 * ```
 *
 * Reads usage, cost, identifiers, the served model, router metadata's selected vendor and
 * declared output modalities; never input, output, tools, the request's `metadata` or error
 * messages. When the result does not name the serving vendor, the adapter asks
 * `generations.getGeneration()` through the same native client, within the `lookup` bounds.
 * Metering never changes or fails a native call. Throws `ConfigurationError` when `client`
 * has no `record()` or `openrouter` is already a facade, which would record every call twice.
 */
export function instrumentOpenRouter<C extends OpenRouterLike>(
  openrouter: C,
  options: InstrumentOpenRouterOptions,
): C {
  if (instrumented.has(openrouter)) {
    throw new ConfigurationError('openrouter is already instrumented');
  }
  const meter = new Meter(openrouter, options);
  const facade = forward(openrouter, {
    chat: meterMethod(openrouter.chat, 'send', (request, send) =>
      meter.measure('chat', request, send),
    ),
    responses: meterMethod(openrouter.responses, 'send', (request, send) =>
      meter.measure('responses', request, send),
    ),
    embeddings: meterMethod(openrouter.embeddings, 'generate', (request, send) =>
      meter.measure('embeddings', request, send),
    ),
  });
  instrumented.add(facade);
  return facade;
}

class Meter {
  readonly #client: Client;
  readonly #defaults: Attribution;
  readonly #mapResource: InstrumentOpenRouterOptions['mapResource'];
  readonly #lookup: GenerationLookup;
  readonly #diagnostics: Diagnostics;

  constructor(
    native: GenerationsClient,
    { client, attributionDefaults, mapResource, lookup, logger }: InstrumentOpenRouterOptions,
  ) {
    if (typeof (client as Partial<Client> | undefined)?.record !== 'function') {
      throw new ConfigurationError('client must implement record()');
    }
    this.#client = client;
    this.#defaults = mergeAttribution({}, attributionDefaults);
    this.#mapResource = mapResource;
    this.#lookup = new GenerationLookup(native, lookup);
    this.#diagnostics = new Diagnostics(logger ?? SILENT);
  }

  /** Makes the native call and meters what it returns, which reaches the host unchanged. */
  async measure(family: Family, request: unknown, send: () => Promise<unknown>): Promise<unknown> {
    const call = this.#begin(family, request);
    const result = await send();
    if (call === undefined) return result;
    try {
      const inspect = this.#inspector(call);
      if (inspect !== undefined && isStream(result))
        return this.#meterStream(result, call, inspect);
    } catch (error) {
      this.#hookFailed(call, error);
      return result;
    }
    const timing = elapsed(call);
    await this.#guard(call, () => this.#record(call, timing, this.#observe(call, result)));
    return result;
  }

  /** The call's attribution and run, captured where it starts; `undefined` when not metered. */
  #begin(family: Family, request: unknown): Call | undefined {
    const scope = currentScope();
    const attribution = mergeAttribution(this.#defaults, scope.attribution);
    if (attribution.environment === undefined) {
      this.#diagnostics.warn('ATTRIBUTION_UNRESOLVED', { operation: OPERATIONS[family].name });
      return undefined;
    }
    return {
      family,
      declared: requestedKinds(request, OPERATIONS[family].requestBody),
      attribution,
      run: scope.run,
      startedAt: performance.now(),
    };
  }

  #observe(call: Call, result: unknown): Observation | undefined {
    switch (call.family) {
      case 'chat':
        return chatObservation(result, call.declared);
      case 'responses':
        return responsesObservation(
          result,
          call.declared,
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

  /** How to read a stream's frames; `undefined` for a resource that never streams. */
  #inspector(call: Call): Inspector | undefined {
    switch (call.family) {
      case 'chat':
        return this.#inspectChat(call);
      case 'responses':
        return this.#inspectResponses(call);
      case 'embeddings':
        return undefined;
      default: {
        const unreachable: never = call.family;
        return unreachable;
      }
    }
  }

  /** A chat stream is recorded from the chunk that carries `usage`. */
  #inspectChat(call: Call): Inspector {
    let router: Router | undefined;
    return (frame) =>
      this.#inspecting(call, async () => {
        if (!isRecord(frame)) return 'continue';
        router = readRouter(frame.openrouterMetadata) ?? router;
        if (!isRecord(frame.usage)) return frame.error == null ? 'continue' : 'error';
        const timing = elapsed(call);
        await this.#guard(call, () =>
          this.#record(call, timing, chatObservation(frame, call.declared, router)),
        );
        return 'recorded';
      });
  }

  /** A Responses stream is recorded from `response.completed`, `.failed` or `.incomplete`. */
  #inspectResponses(call: Call): Inspector {
    return (frame) =>
      this.#inspecting(call, async () => {
        if (!isRecord(frame)) return 'continue';
        const type = frame.type;
        if (type === 'error') return 'error';
        if (!isTerminalType(type)) return 'continue';
        const timing = elapsed(call);
        const observed = responsesObservation(
          frame.response,
          call.declared,
          terminalErrorCode(type),
        );
        if (observed === undefined) return 'no_usage';
        await this.#guard(call, () => this.#record(call, timing, observed));
        return 'recorded';
      });
  }

  /** Runs one frame's inspection; an exception is logged and the frame is passed on. */
  async #inspecting(call: Call, step: () => Promise<Verdict>): Promise<Verdict> {
    try {
      return await step();
    } catch (error) {
      this.#hookFailed(call, error);
      return 'continue';
    }
  }

  #meterStream(stream: NativeStream, call: Call, inspect: Inspector): NativeStream {
    return meterStream(stream, inspect, (reason: IncompleteReason) => {
      this.#diagnostics.warn('STREAM_INCOMPLETE', {
        operation: OPERATIONS[call.family].name,
        reason,
      });
    });
  }

  async #record(call: Call, timing: Timing, observed: Observation | undefined): Promise<void> {
    const { name: operation, span, operation: kind } = OPERATIONS[call.family];
    if (observed === undefined) {
      this.#diagnostics.warn('USAGE_UNREPORTED', { operation });
      return;
    }
    const facts = needsLookup(observed) ? await this.#find(operation, observed) : undefined;
    const served = servedProvider(observed, facts);
    const mapped = this.#mapResource?.({ model: observed.model, vendor: served });
    const name = mapped?.name ?? observed.model;
    if (!name) {
      this.#diagnostics.warn('MODEL_UNREPORTED', { operation });
      return;
    }
    const slug = mapped?.provider ?? (served === undefined ? undefined : providerSlug(served));
    if (slug === undefined) this.#diagnostics.warn('PROVIDER_UNRESOLVED', { operation });
    const provider = slug ?? OPENROUTER_PROVIDER;
    const { cost, incomplete } = resolveCost(
      observed.charge,
      observed.isByok ?? facts?.isByok,
      observed.upstream ?? facts?.upstream,
    );
    if (incomplete) this.#diagnostics.warn('BYOK_COST_INCOMPLETE', { operation });
    const id = observed.id ?? uuidv7();
    const run = call.run;
    const submitted = this.#client.record(
      createRecord({
        emitter: EMITTER,
        timing: { event_time: timing.completedAt, duration_ms: timing.durationMs },
        resource: { provider, type: 'model', name, operation: kind, modality: observed.modality },
        usage: { llm: observed.usage },
        cost,
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

  /** The lookup's facts, or `undefined` after logging why there are none. */
  async #find(operation: OperationName, observed: Observation): Promise<Facts | undefined> {
    if (observed.id === undefined || !isGenerationId(observed.id)) {
      this.#diagnostics.warn('LOOKUP_FAILED', { operation, reason: 'no_id' });
      return undefined;
    }
    const outcome = await this.#lookup.find(observed.id);
    if (outcome.ok) return outcome.facts;
    this.#diagnostics.warn('LOOKUP_FAILED', { operation, reason: outcome.reason });
    return undefined;
  }

  /** Runs one metering step; an exception is logged by category and never reaches the host. */
  async #guard(call: Call, step: () => Promise<void>): Promise<void> {
    try {
      await step();
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

function elapsed(call: Call): Timing {
  return { completedAt: new Date(), durationMs: Math.round(performance.now() - call.startedAt) };
}

/** The output modalities the request body declared; none when it cannot be read. */
function requestedKinds(request: unknown, body: string | undefined): ReadonlySet<Kind> {
  try {
    const inner = body === undefined || !isRecord(request) ? undefined : request[body];
    return declaredKinds(isRecord(inner) ? inner.modalities : undefined);
  } catch {
    return declaredKinds(undefined);
  }
}

/**
 * `resource` with `method` metered. The native method runs on `resource` with every
 * argument unchanged; `meter` receives the request, the first argument, and the call.
 */
function meterMethod<R extends object>(
  resource: R,
  method: string,
  meter: (request: unknown, send: () => Promise<unknown>) => Promise<unknown>,
): R {
  return forward(resource, {
    [method]: (...args: unknown[]) =>
      meter(args[0], () =>
        (Reflect.get(resource, method) as (...native: unknown[]) => Promise<unknown>).apply(
          resource,
          args,
        ),
      ),
  });
}
