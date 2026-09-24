import { issue, ValidationError } from './errors.js';
import { type AudrRecord } from './record.js';
import { SUPPORTED_SPEC_VERSION } from './schema.js';
import { validate } from './validate.js';

/**
 * Parse an already-decoded record, throwing `ValidationError` with every issue it has.
 *
 * A payload that omits `spec_version`, or declares a release this package does not
 * implement, is rejected on that alone rather than as a cascade of field errors.
 */
export function parseRecord(data: unknown): AudrRecord {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const declared: unknown = (data as Record<string, unknown>).spec_version;
    if (declared === undefined) {
      throw new ValidationError([issue('REQUIRED', '/spec_version')]);
    }
    if (typeof declared === 'string' && !SUPPORTED_SPEC_VERSION.test(declared)) {
      throw new ValidationError([issue('UNSUPPORTED_VERSION', '/spec_version')]);
    }
  }
  const issues = validate(data);
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return structuredClone(data as AudrRecord);
}

/** Parse a JSON record, throwing `ValidationError` with every issue it has. */
export function decodeRecord(json: string): AudrRecord {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ValidationError([issue('NOT_JSON', '/')]);
  }
  return parseRecord(data);
}

/** The record as JSON with keys sorted at every level; compact unless `indent` is given. */
export function encodeRecord(
  record: AudrRecord,
  options: { readonly indent?: number | undefined } = {},
): string {
  return JSON.stringify(sortKeys(record), undefined, options.indent);
}

/** A copy with object keys in sorted order. An AUDR record holds no arrays. */
function sortKeys(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, field]) => field !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : 1));
    return Object.fromEntries(entries.map(([key, field]) => [key, sortKeys(field)]));
  }
  return value;
}
