import type { Cost, LlmUsage, Modality } from '@openaudr/audr';

/** `resource.provider` for a response-cache replay, and for a call whose vendor is unknown. */
export const OPENROUTER_PROVIDER = 'openrouter';

/** Written to `run.error_code` for a Responses `status: 'failed'` or a `response.failed` event. */
export const RESPONSE_FAILED_CODE = 'OPENROUTER_RESPONSE_FAILED';

/** Written to `run.error_code` for a Responses `status: 'incomplete'` or a `response.incomplete` event. */
export const RESPONSE_INCOMPLETE_CODE = 'OPENROUTER_RESPONSE_INCOMPLETE';

/** The metered resources. */
export type Family = 'chat' | 'responses' | 'embeddings';

/** The terminal events of a Responses stream. */
export type ResponsesTerminalType =
  'response.completed' | 'response.failed' | 'response.incomplete';

/** An output modality a request can declare and AUDR can name. */
export type Kind = 'text' | 'image' | 'audio';

const KINDS: readonly Kind[] = ['text', 'image', 'audio'];

type Fields = Readonly<Record<string, unknown>>;

/**
 * What the adapter takes from one result before the optional lookup: the router metadata's
 * selected vendor and BYOK flag, and everything the usage object says about tokens and cost.
 * Everything else a result carries is never read.
 */
export interface Observation {
  readonly id: string | undefined;
  readonly model: string | undefined;
  /** The vendor router metadata selected, as OpenRouter names it; `undefined` when absent. */
  readonly provider: string | undefined;
  readonly isByok: boolean | undefined;
  /** `usage.cost`: what OpenRouter charged. For a BYOK call that is its fee alone. */
  readonly charge: number | undefined;
  /** `usage.costDetails.upstreamInferenceCost`: what the provider charged a BYOK call. */
  readonly upstream: number | undefined;
  readonly usage: LlmUsage;
  readonly modality: Modality;
  readonly errorCode: string | undefined;
}

/** The router metadata fields the adapter reads. */
export interface Router {
  readonly provider: string | undefined;
  readonly isByok: boolean | undefined;
}

/** The generation fields the adapter reads from a lookup, and nothing else. */
export interface Facts {
  readonly providerName: string | undefined;
  /** `responseCacheSourceId` is set: OpenRouter replayed a cached response. */
  readonly cacheHit: boolean;
  readonly isByok: boolean | undefined;
  readonly upstream: number | undefined;
}

export function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null;
}

/** A counter or amount OpenRouter reported; `null` and anything else mean it did not. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function positive(value: unknown): boolean {
  return typeof value === 'number' && value > 0;
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

/**
 * The vendor router metadata selected: the `available` endpoint with `selected: true`.
 * `undefined` when the result carries no metadata. Reads `endpoints.available[].provider`,
 * `.selected` and `isByok` only.
 */
export function readRouter(value: unknown): Router | undefined {
  const metadata = fields(value);
  if (metadata === undefined) return undefined;
  const available = fields(metadata.endpoints)?.available;
  const entries: readonly unknown[] = Array.isArray(available) ? (available as unknown[]) : [];
  const selected = entries
    .map(fields)
    .find((entry) => entry?.selected === true && text(entry.provider) !== undefined);
  return {
    provider: text(selected?.provider),
    isByok: typeof metadata.isByok === 'boolean' ? metadata.isByok : undefined,
  };
}

/** The AUDR slug for a vendor name: lowercase, each run of other characters becomes `-`. */
export function providerSlug(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? undefined : slug;
}

/** The output modalities a request declared; values AUDR cannot name are ignored. */
export function declaredKinds(modalities: unknown): ReadonlySet<Kind> {
  const declared: readonly unknown[] = Array.isArray(modalities) ? (modalities as unknown[]) : [];
  return new Set(KINDS.filter((kind) => declared.includes(kind)));
}

/**
 * `multimodal` when more than one kind is present or something AUDR has no name for
 * (video, files) is; otherwise that kind, defaulting to `text`.
 */
function modalityOf(kinds: Iterable<Kind>, other: boolean): Modality {
  const present = new Set(kinds);
  if (other || present.size > 1) return 'multimodal';
  return [...present][0] ?? 'text';
}

/**
 * `Observation` for a Chat result, or a streamed chunk that carries `usage`. `fallback` is
 * the router metadata an earlier chunk of the same stream carried. `undefined` when the
 * result has no usage object.
 */
export function chatObservation(
  result: unknown,
  declared: ReadonlySet<Kind>,
  fallback?: Router,
): Observation | undefined {
  const body = fields(result);
  const usage = fields(body?.usage);
  if (body === undefined || usage === undefined) return undefined;
  const prompt = fields(usage.promptTokensDetails);
  const completion = fields(usage.completionTokensDetails);
  const cacheRead = num(prompt?.cachedTokens);
  const cacheWrite = num(prompt?.cacheWriteTokens);
  const reasoning = num(completion?.reasoningTokens);
  const kinds = new Set<Kind>(declared.size > 0 ? declared : ['text']);
  if (positive(prompt?.audioTokens) || positive(completion?.audioTokens)) kinds.add('audio');
  const router = readRouter(body.openrouterMetadata) ?? fallback;
  return {
    id: text(body.id),
    model: text(body.model),
    provider: router?.provider,
    isByok: typeof usage.isByok === 'boolean' ? usage.isByok : router?.isByok,
    ...economics(usage),
    usage: {
      input_tokens: exclusive(num(usage.promptTokens), (cacheRead ?? 0) + (cacheWrite ?? 0)),
      output_tokens: exclusive(num(usage.completionTokens), reasoning ?? 0),
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      reasoning_tokens: reasoning,
      requests: 1,
    },
    modality: modalityOf(kinds, positive(prompt?.videoTokens)),
    errorCode: undefined,
  };
}

/**
 * `Observation` for a Responses result, or the `response` of a terminal stream event.
 * `undefined` when it has no usage object.
 */
export function responsesObservation(
  result: unknown,
  declared: ReadonlySet<Kind>,
  errorCode: string | undefined,
): Observation | undefined {
  const body = fields(result);
  const usage = fields(body?.usage);
  if (body === undefined || usage === undefined) return undefined;
  const input = fields(usage.inputTokensDetails);
  const output = fields(usage.outputTokensDetails);
  const cacheRead = num(input?.cachedTokens);
  const cacheWrite = num(input?.cacheWriteTokens);
  const reasoning = num(output?.reasoningTokens);
  const router = readRouter(body.openrouterMetadata);
  return {
    id: text(body.id),
    model: text(body.model),
    provider: router?.provider,
    isByok: typeof usage.isByok === 'boolean' ? usage.isByok : router?.isByok,
    ...economics(usage),
    usage: {
      input_tokens: exclusive(num(usage.inputTokens), (cacheRead ?? 0) + (cacheWrite ?? 0)),
      output_tokens: exclusive(num(usage.outputTokens), reasoning ?? 0),
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      reasoning_tokens: reasoning,
      requests: 1,
    },
    modality: modalityOf(declared.size > 0 ? declared : ['text'], false),
    errorCode,
  };
}

/**
 * `Observation` for an Embeddings result. Embeddings carry no router metadata, so only the
 * lookup can name the vendor. `undefined` when the result has no usage object.
 */
export function embeddingsObservation(result: unknown): Observation | undefined {
  const body = fields(result);
  const usage = fields(body?.usage);
  if (body === undefined || usage === undefined) return undefined;
  const details = fields(usage.promptTokensDetails);
  const kinds = new Set<Kind>();
  if (positive(details?.textTokens)) kinds.add('text');
  if (positive(details?.imageTokens)) kinds.add('image');
  if (positive(details?.audioTokens)) kinds.add('audio');
  return {
    id: text(body.id),
    model: text(body.model),
    provider: undefined,
    isByok: typeof usage.isByok === 'boolean' ? usage.isByok : undefined,
    ...economics(usage),
    usage: { input_tokens: num(usage.promptTokens), requests: 1 },
    modality: modalityOf(
      kinds.size > 0 ? kinds : ['text'],
      positive(details?.videoTokens) || positive(details?.fileTokens),
    ),
    errorCode: undefined,
  };
}

function economics(usage: Fields): Pick<Observation, 'charge' | 'upstream'> {
  return {
    charge: num(usage.cost),
    upstream: num(fields(usage.costDetails)?.upstreamInferenceCost),
  };
}

/**
 * The facts a `getGeneration` response carries: `data.providerName`,
 * `data.responseCacheSourceId`, `data.isByok` and `data.upstreamInferenceCost`. Nothing else
 * in it is read.
 */
export function readFacts(response: unknown): Facts {
  const data = fields(fields(response)?.data);
  return {
    providerName: text(data?.providerName),
    cacheHit: text(data?.responseCacheSourceId) !== undefined,
    isByok: typeof data?.isByok === 'boolean' ? data.isByok : undefined,
    upstream: num(data?.upstreamInferenceCost),
  };
}

/** Whether the lookup can supply something the result lacks. */
export function needsLookup(observed: Observation): boolean {
  if (observed.provider === undefined || observed.isByok === undefined) return true;
  return observed.isByok && observed.charge !== undefined && observed.upstream === undefined;
}

/**
 * The vendor as OpenRouter names it. A response-cache replay has no upstream vendor, so
 * it is `openrouter`; otherwise router metadata wins over the lookup.
 */
export function servedProvider(
  observed: Observation,
  facts: Facts | undefined,
): string | undefined {
  if (facts?.cacheHit === true) return OPENROUTER_PROVIDER;
  return observed.provider ?? facts?.providerName;
}

export interface CostResult {
  readonly cost: Cost | undefined;
  /** A BYOK component, or whether the call was BYOK at all, is unknown: `cost` is withheld. */
  readonly incomplete: boolean;
}

/**
 * `total_cost` in USD. A call that is not BYOK costs `usage.cost` and any upstream figure
 * is ignored. A BYOK call costs OpenRouter's fee plus the provider's charge; with either
 * missing, or the BYOK status unknown, no cost is written rather than an understated one.
 * `serverToolCost` is already part of OpenRouter's charge and is never added.
 */
export function resolveCost(
  charge: number | undefined,
  isByok: boolean | undefined,
  upstream: number | undefined,
): CostResult {
  if (isByok === undefined) return { cost: undefined, incomplete: true };
  if (!isByok) return { cost: charge === undefined ? undefined : usd(charge), incomplete: false };
  if (charge === undefined || upstream === undefined) return { cost: undefined, incomplete: true };
  return { cost: usd(charge + upstream), incomplete: false };
}

function usd(total: number): Cost {
  return { total_cost: total, currency: 'USD' };
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
