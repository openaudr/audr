import type { Attribution } from '@openaudr/audr';

/** The call fields attribution is read from when an operation starts. */
export interface AttributionSource {
  /** `ai.generateText`, `ai.streamText`, `ai.embed`, `ai.embedMany`, `ai.rerank`, ... */
  readonly operationId: string;
  /** `telemetry.functionId`, when the call set one. */
  readonly functionId: string | undefined;
  /** The call's `runtimeContext`, already filtered by `telemetry.includeRuntimeContext`. */
  readonly runtimeContext: Readonly<Record<string, unknown>>;
}

export type Resolution =
  | { readonly kind: 'resolved'; readonly attribution: Attribution }
  | { readonly kind: 'unresolved' };

const STRING_FIELDS = [
  'environment',
  'user_id',
  'account_id',
  'subscription_id',
  'feature_id',
] as const;

/**
 * The per-call reader: `runtimeContext.audr`, keeping `environment`, `user_id`,
 * `account_id`, `subscription_id` and `feature_id` when each is a string and `labels` when
 * it is a plain object of strings. Everything else is dropped; the client validates what
 * remains.
 */
export function readRuntimeAttribution(source: AttributionSource): Attribution | undefined {
  const audr = Object.hasOwn(source.runtimeContext, 'audr')
    ? source.runtimeContext.audr
    : undefined;
  if (!isPlainObject(audr)) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of STRING_FIELDS) {
    if (!Object.hasOwn(audr, key)) continue;
    const value = audr[key];
    if (typeof value === 'string') picked[key] = value;
  }
  const labels = Object.hasOwn(audr, 'labels') ? audr.labels : undefined;
  if (isPlainObject(labels) && Object.values(labels).every((v) => typeof v === 'string')) {
    picked.labels = { ...labels };
  }
  return picked;
}

/** `perCall` over `defaults`, field by field, with `labels` merged by key. */
export function mergeAttribution(
  defaults: Attribution | undefined,
  perCall: Attribution | undefined,
): Attribution {
  const merged: Record<string, unknown> = {};
  for (const source of [defaults, perCall]) {
    if (source === undefined) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && key !== 'labels') merged[key] = value;
    }
  }
  const labels = { ...defaults?.labels, ...perCall?.labels };
  if (Object.keys(labels).length > 0) merged.labels = labels;
  return merged;
}

/**
 * Resolve an operation's attribution once, at its start. Unresolved when the merged
 * result has no `environment`.
 */
export function resolveAttribution(
  source: AttributionSource,
  defaults: Attribution | undefined,
): Resolution {
  const attribution = mergeAttribution(defaults, readRuntimeAttribution(source));
  return attribution.environment === undefined
    ? { kind: 'unresolved' }
    : { kind: 'resolved', attribution };
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
