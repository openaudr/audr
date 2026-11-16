/**
 * Interpretation of Stigg's responses: which class an HTTP status belongs to, and which events
 * a `400` names. Stigg validates a request as a whole and answers `400` with one readable
 * message, `{"code": "BadUserInput", "message": "Validation error: … at \"events[3].customerId\""}`,
 * so the events at fault are found by their position in that message. Nothing from a response
 * body is ever surfaced: details are rebuilt from allowlisted names.
 */
import { isTransient } from './retry.js';

export type StatusClass =
  | 'accepted'
  | 'unconfirmed'
  | 'invalid'
  | 'credential'
  | 'forbidden'
  | 'not_found'
  | 'too_large'
  | 'transient'
  | 'permanent';

/**
 * Classify an HTTP status. Stigg answers `202` once the events are queued for ingestion;
 * `200` is read the same way. Another `2xx` neither confirms nor refuses the events.
 */
export function classifyStatus(status: number): StatusClass {
  if (status === 200 || status === 202) return 'accepted';
  if (status > 200 && status < 300) return 'unconfirmed';
  if (status === 400) return 'invalid';
  if (status === 401) return 'credential';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  return isTransient(status) ? 'transient' : 'permanent';
}

export interface InvalidEvent {
  /** The event's position in the request. */
  readonly index: number;
  /** A value-free detail built from allowlisted names. */
  readonly detail: string;
}

const BAD_USER_INPUT = 'BadUserInput';
const FIELDS = new Set(['eventName', 'customerId', 'timestamp', 'idempotencyKey', 'dimensions']);
// `events[3]`, then optionally the field the issue is about: `events[3].customerId`.
const EVENT_PATH = /\bevents\[(0|[1-9]\d*)\](?:\.([A-Za-z]+))?/g;

/**
 * Read a `400` body into the events it refuses, or `undefined` when it cannot be trusted.
 *
 * A body is trusted only when its code is `BadUserInput` and its message names at least one
 * event, every one inside the request. The message is prose, not a contract: anything else is
 * ambiguous, and acting on a guess could drop an event Stigg would have taken. An event named
 * more than once keeps the first field named.
 */
export function parseValidationErrors(
  body: unknown,
  eventCount: number,
): readonly InvalidEvent[] | undefined {
  if (!isObject(body) || body.code !== BAD_USER_INPUT || typeof body.message !== 'string') {
    return undefined;
  }
  const invalid = new Map<number, string>();
  for (const [, position = '', field] of body.message.matchAll(EVENT_PATH)) {
    const index = Number(position);
    if (index >= eventCount) return undefined;
    if (!invalid.has(index)) {
      invalid.set(
        index,
        field !== undefined && FIELDS.has(field) ? `bad_user_input:${field}` : 'bad_user_input',
      );
    }
  }
  if (invalid.size === 0) return undefined;
  return [...invalid]
    .map(([index, detail]) => ({ index, detail }))
    .sort((a, b) => a.index - b.index);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
