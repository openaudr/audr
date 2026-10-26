import type { LlmUsage, Modality } from '@openaudr/audr';

/** Written to `run.error_code` for a Responses `status: 'failed'` or a `response.failed` event. */
export const RESPONSE_FAILED_CODE = 'OPENAI_RESPONSE_FAILED';

/** Written to `run.error_code` for a Responses `status: 'incomplete'` or a `response.incomplete` event. */
export const RESPONSE_INCOMPLETE_CODE = 'OPENAI_RESPONSE_INCOMPLETE';

/** The metered resources. */
export type Family = 'chat' | 'responses' | 'embeddings';

/** The terminal events of a Responses stream. */
export type ResponsesTerminalType =
  'response.completed' | 'response.failed' | 'response.incomplete';

type Fields = Readonly<Record<string, unknown>>;

/**
 * Everything the adapter takes from one result: its id, the model that served it and its
 * usage counters. Nothing else a result carries is read.
 */
export interface Observation {
  readonly id: string | undefined;
  readonly model: string | undefined;
  readonly usage: LlmUsage;
  readonly errorCode: string | undefined;
}

/** What a client's `baseURL` says about who served the call. */
export interface ResolvedProvider {
  /** `resource.provider`. */
  readonly provider: string;
  /** `resource.deployment`, set for a local endpoint. */
  readonly deployment?: 'self-hosted' | undefined;
}

/**
 * The API hosts whose provider the adapter knows, by exact hostname or any subdomain of it.
 * Every entry serves the OpenAI wire format. A host absent here needs `mapResource`.
 */
const HOSTS: readonly (readonly [host: string, provider: string])[] = [
  ['api.openai.com', 'openai'],
  ['openai.azure.com', 'azure-openai'],
  ['cognitiveservices.azure.com', 'azure-openai'],
  ['services.ai.azure.com', 'azure-openai'],
  ['api.groq.com', 'groq'],
  ['api.mistral.ai', 'mistral'],
  ['api.together.xyz', 'together'],
  ['api.fireworks.ai', 'fireworks'],
  ['api.deepseek.com', 'deepseek'],
  ['openrouter.ai', 'openrouter'],
];

/** A loopback host serves a local model runtime; Ollama is the one with an OpenAI-compatible default. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null;
}

/** A counter the vendor reported; `null` and anything else mean it did not. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function fields(value: unknown): Fields | undefined {
  return isRecord(value) ? value : undefined;
}

/** `total` less `part`, never below zero; `undefined` when `total` was not reported. */
function exclusive(total: number | undefined, part: number): number | undefined {
  return total === undefined ? undefined : Math.max(total - part, 0);
}

/** The provider behind a client's `baseURL`, or `undefined` for a host the adapter does not know. */
export function providerFor(baseUrl: string | undefined): ResolvedProvider | undefined {
  if (baseUrl === undefined) return undefined;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (LOOPBACK.has(hostname)) return { provider: 'ollama', deployment: 'self-hosted' };
  const match = HOSTS.find(([host]) => hostname === host || hostname.endsWith(`.${host}`));
  return match === undefined ? undefined : { provider: match[1] };
}

/** The output modality a Chat Completions request declares through `modalities`; `text` by default. */
export function chatModality(params: unknown): Modality {
  try {
    const modalities: unknown = isRecord(params) ? params.modalities : undefined;
    if (!Array.isArray(modalities)) return 'text';
    const declared = modalities as unknown[];
    const text = declared.includes('text');
    const audio = declared.includes('audio');
    if (text && audio) return 'multimodal';
    return audio ? 'audio' : 'text';
  } catch {
    return 'text';
  }
}

/**
 * `Observation` for a Chat Completions result, or a streamed chunk that carries `usage`.
 * `prompt_tokens` counts the whole prompt and `completion_tokens` the whole completion, so
 * each is reduced by the detail counter reported alongside it. `total_tokens` is never read.
 */
export function chatObservation(result: unknown): Observation {
  const body = fields(result);
  const usage = fields(body?.usage);
  const cacheRead = num(fields(usage?.prompt_tokens_details)?.cached_tokens);
  const reasoning = num(fields(usage?.completion_tokens_details)?.reasoning_tokens);
  return {
    id: text(body?.id),
    model: text(body?.model),
    usage: {
      input_tokens: exclusive(num(usage?.prompt_tokens), cacheRead ?? 0),
      output_tokens: exclusive(num(usage?.completion_tokens), reasoning ?? 0),
      cache_read_tokens: cacheRead,
      reasoning_tokens: reasoning,
      requests: 1,
    },
    errorCode: undefined,
  };
}

/** `Observation` for a Responses result, or the `response` of a terminal stream event. */
export function responsesObservation(result: unknown, errorCode: string | undefined): Observation {
  const body = fields(result);
  const usage = fields(body?.usage);
  const cacheRead = num(fields(usage?.input_tokens_details)?.cached_tokens);
  const reasoning = num(fields(usage?.output_tokens_details)?.reasoning_tokens);
  return {
    id: text(body?.id),
    model: text(body?.model),
    usage: {
      input_tokens: exclusive(num(usage?.input_tokens), cacheRead ?? 0),
      output_tokens: exclusive(num(usage?.output_tokens), reasoning ?? 0),
      cache_read_tokens: cacheRead,
      reasoning_tokens: reasoning,
      requests: 1,
    },
    errorCode,
  };
}

/** `Observation` for an Embeddings result: `prompt_tokens` is the input. */
export function embeddingsObservation(result: unknown): Observation {
  const body = fields(result);
  return {
    id: undefined,
    model: text(body?.model),
    usage: { input_tokens: num(fields(body?.usage)?.prompt_tokens), requests: 1 },
    errorCode: undefined,
  };
}

/** Whether a response id can serve as `run.run_id`, which AUDR limits to 8 to 64 characters. */
export function fitsRunId(id: string): boolean {
  return id.length >= 8 && id.length <= 64;
}

export function isTerminalType(type: unknown): type is ResponsesTerminalType {
  return (
    type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete'
  );
}

/** The `run.error_code` of a terminal Responses event. */
export function terminalErrorCode(type: ResponsesTerminalType): string | undefined {
  switch (type) {
    case 'response.completed':
      return undefined;
    case 'response.failed':
      return RESPONSE_FAILED_CODE;
    case 'response.incomplete':
      return RESPONSE_INCOMPLETE_CODE;
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}

/** The `run.error_code` of a non-streamed Responses result's `status`. */
export function statusErrorCode(status: unknown): string | undefined {
  switch (status) {
    case 'failed':
      return RESPONSE_FAILED_CODE;
    case 'incomplete':
      return RESPONSE_INCOMPLETE_CODE;
    default:
      return undefined;
  }
}
