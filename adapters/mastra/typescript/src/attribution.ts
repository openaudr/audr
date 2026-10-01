import type { Attribution } from '@openaudr/audr';

export type Resolution =
  | { readonly kind: 'resolved'; readonly attribution: Attribution }
  | { readonly kind: 'unresolved' };

const STRING_FIELDS = ['environment', 'user_id', 'account_id', 'subscription_id'] as const;

/**
 * Read `metadata.audr`, keeping string identity fields and string `labels`. Everything else
 * is dropped; only own properties are considered.
 */
export function readMetadataAttribution(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Attribution | undefined {
  if (metadata === undefined) return undefined;
  const audr = Object.hasOwn(metadata, 'audr') ? metadata.audr : undefined;
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

/** `perSpan` over `defaults`, field by field, with `labels` merged by key. */
export function mergeAttribution(
  defaults: Attribution | undefined,
  perSpan: Attribution | undefined,
): Attribution {
  const merged: Record<string, unknown> = {};
  for (const source of [defaults, perSpan]) {
    if (source === undefined) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && key !== 'labels') merged[key] = value;
    }
  }
  const labels = { ...defaults?.labels, ...perSpan?.labels };
  if (Object.keys(labels).length > 0) merged.labels = labels;
  return merged;
}

/** Resolve attribution for a span. Unresolved when the merged result has no `environment`. */
export function resolveAttribution(
  metadata: Readonly<Record<string, unknown>> | undefined,
  defaults: Attribution | undefined,
): Resolution {
  const attribution = mergeAttribution(defaults, readMetadataAttribution(metadata));
  return attribution.environment === undefined
    ? { kind: 'unresolved' }
    : { kind: 'resolved', attribution };
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
