/**
 * Conversion of AUDR records into Lago event properties.
 *
 * The batch schema permits only string and number property values, so nested AUDR objects
 * are flattened here, in the sink, rather than in the record model. Nested objects become
 * `parent__child` names, each label becomes `attribution__labels__<key>`, and arrays are
 * stored as canonical JSON under a terminal `json` segment, so the destination only ever
 * sees scalars. The separator is fixed: billable metric definitions refer to these names, so
 * a different one would silently detach every metric already defined against them.
 */
import { type AudrRecord } from '@openaudr/audr';

import { InvalidEventError, pointer, type PropertyValue } from './event.js';

const SEPARATOR = '__';
const JSON_SUFFIX = 'json';

/**
 * Flatten every field of an AUDR record into Lago properties.
 *
 * Throws if a field cannot be encoded as a string or a finite number. The message is
 * `unencodable_field:` followed by the JSON pointer of the field, never its value.
 */
export function flattenRecord(record: AudrRecord): Record<string, PropertyValue> {
  return flatten(record);
}

/** Flatten a nested JSON object into Lago properties. */
export function flatten(nested: unknown): Record<string, PropertyValue> {
  if (!isPlainObject(nested)) throw new InvalidEventError('unencodable_record');
  const output: Record<string, PropertyValue> = {};
  flattenInto(nested, [], output);
  return output;
}

function flattenInto(
  value: Readonly<Record<string, unknown>>,
  path: readonly string[],
  output: Record<string, PropertyValue>,
): void {
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const itemPath = [...path, key];
    if (Array.isArray(item)) {
      output[[...itemPath, JSON_SUFFIX].join(SEPARATOR)] = canonicalJson(item, itemPath);
    } else if (isPlainObject(item)) {
      flattenInto(item, itemPath, output);
    } else if (typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) {
      output[itemPath.join(SEPARATOR)] = item;
    } else {
      throw notEncodable(itemPath);
    }
  }
}

/** JSON with sorted keys; refuses what `JSON.stringify` would silently coerce, like `NaN`. */
function canonicalJson(value: unknown, path: readonly string[]): string {
  return JSON.stringify(canonical(value, path));
}

function canonical(value: unknown, path: readonly string[]): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw notEncodable(path);
    return value;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => canonical(item, path));
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = canonical(value[key], path);
    }
    return sorted;
  }
  throw notEncodable(path);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function notEncodable(path: readonly string[]): InvalidEventError {
  return new InvalidEventError(`unencodable_field:${pointer(path)}`);
}
