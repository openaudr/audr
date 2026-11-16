/**
 * The Stigg event and the destination's envelope rules: the identifier patterns, the UTC
 * timestamp and the scalar dimension values that `POST /api/v1/events` accepts. These are
 * Stigg's rules, not AUDR's; a request breaking one is refused whole, so each is checked here.
 */
import { Buffer } from 'node:buffer';

/** A Stigg dimension value. The events endpoint permits strings, numbers and booleans. */
export type DimensionValue = string | number | boolean;

/** One event in the body of an events request. */
export interface StiggEvent {
  readonly eventName: string;
  readonly customerId: string;
  /** A UTC instant with millisecond precision, such as `2026-10-29T12:00:00.000Z`. */
  readonly timestamp: string;
  readonly idempotencyKey: string;
  readonly dimensions: Readonly<Record<string, DimensionValue>>;
}

export interface EventFields {
  readonly eventName: string;
  readonly customerId: string | undefined;
  readonly idempotencyKey: string;
  /** An RFC 3339 instant. */
  readonly eventTime: string;
  readonly dimensions: Readonly<Record<string, DimensionValue>>;
}

/** Stigg's limit on every string field of an event. */
export const MAX_FIELD_LENGTH = 255;
/** Stigg's limit on the JSON size of an event's dimensions. */
export const MAX_DIMENSIONS_BYTES = 1024 * 1024;
/** Names Stigg reserves for events it synthesizes itself. */
export const RESERVED_EVENT_NAMES: ReadonlySet<string> = new Set([
  '$usage.reported',
  '$usage.ingested',
  'usage.credit',
]);

const CUSTOMER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_|.@-]*$/;

/**
 * A record cannot become a valid event. The message is the rejection detail: a stable code,
 * followed by a JSON pointer where a field is at fault, and never a field value.
 */
export class InvalidEventError extends Error {
  override readonly name: string = 'InvalidEventError';
}

/** Build an immutable event from `fields`, throwing `InvalidEventError` on a rule it breaks. */
export function createEvent(fields: EventFields): StiggEvent {
  const { eventName, customerId, idempotencyKey } = fields;
  if (!isEventName(eventName)) throw new InvalidEventError('invalid_event_name');
  if (customerId === undefined) throw new InvalidEventError('missing_customer_id');
  if (!matches(customerId, CUSTOMER_ID)) throw new InvalidEventError('invalid_customer_id');
  if (!isPresent(idempotencyKey) || idempotencyKey.length > MAX_FIELD_LENGTH) {
    throw new InvalidEventError('invalid_field:/record_id');
  }
  const timestamp = formatTimestamp(fields.eventTime);
  validateDimensions(fields.dimensions);
  return Object.freeze({
    eventName,
    customerId,
    timestamp,
    idempotencyKey,
    dimensions: Object.freeze({ ...fields.dimensions }),
  });
}

/**
 * Whether `name` can name a Stigg event. A meter matches the name exactly, so a stray space
 * silently stops metering, and a reserved name is refused by Stigg.
 */
export function isEventName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name === name.trim() &&
    name.length <= MAX_FIELD_LENGTH &&
    !RESERVED_EVENT_NAMES.has(name)
  );
}

/**
 * Convert an RFC 3339 instant to the UTC form Stigg accepts. Stigg refuses an offset such as
 * `+02:00`, which AUDR permits. The conversion is deterministic, so a retry carries the same
 * timestamp, which is part of how Stigg recognises a duplicate event.
 */
export function formatTimestamp(eventTime: string): string {
  const milliseconds = typeof eventTime === 'string' ? Date.parse(eventTime) : Number.NaN;
  if (!Number.isInteger(milliseconds)) throw new InvalidEventError('invalid_timestamp');
  const iso = new Date(milliseconds).toISOString();
  // Years outside 0000-9999 render with a sign, which Stigg's date-time format refuses.
  if (!/^\d{4}-/.test(iso)) throw new InvalidEventError('invalid_timestamp');
  return iso;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && value.length <= MAX_FIELD_LENGTH && pattern.test(value);
}

function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function validateDimensions(dimensions: unknown): void {
  if (typeof dimensions !== 'object' || dimensions === null || Array.isArray(dimensions)) {
    throw new InvalidEventError('unencodable_field:/dimensions');
  }
  for (const [name, value] of Object.entries(dimensions)) {
    const encodable =
      name !== '' &&
      (typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)));
    if (!encodable)
      throw new InvalidEventError(`unencodable_field:${pointer(['dimensions', name])}`);
  }
  if (Buffer.byteLength(JSON.stringify(dimensions)) > MAX_DIMENSIONS_BYTES) {
    throw new InvalidEventError('dimensions_too_large');
  }
}

/** A JSON pointer (RFC 6901) for `segments`. */
export function pointer(segments: readonly string[]): string {
  return segments
    .map((segment) => `/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}
