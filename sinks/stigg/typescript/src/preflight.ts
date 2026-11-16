/**
 * Local processing of a batch before anything is sent: each record becomes one Stigg event or
 * a rejection that names its cause. Every record is judged on its own, so one unusable record
 * never keeps the rest from being delivered; Stigg refuses a request whole when any of its
 * events breaks a rule, so the rules are applied here first.
 */
import { type AudrRecord, type RejectedRecord } from '@openaudr/audr';

import { createEvent, InvalidEventError, type StiggEvent } from './event.js';
import { flattenRecord } from './flatten.js';

/** Names the Stigg event of a record. */
export type EventNamer = (record: AudrRecord) => string;

export interface Preflight {
  /** One event per distinct `record_id`, in batch order. */
  readonly events: readonly StiggEvent[];
  /** One entry per rejected `record_id`. */
  readonly rejected: readonly RejectedRecord[];
}

/**
 * Encode `batch`.
 *
 * A record that repeats an earlier one byte for byte shares that record's event, so one
 * outcome answers both. Records that share a `record_id` but differ in content are all
 * rejected: Stigg accepts both and keeps the first under one idempotency key, so sending
 * either would silently discard the other.
 */
export function preflight(batch: readonly AudrRecord[], eventName: EventNamer): Preflight {
  const events = new Map<string, { readonly event: StiggEvent; readonly body: string }>();
  const rejected = new Map<string, string>();
  const reject = (id: string, detail: string): void => {
    events.delete(id);
    if (!rejected.has(id)) rejected.set(id, detail);
  };

  for (const record of batch) {
    const id = record.record_id;
    let event: StiggEvent;
    try {
      event = encode(record, eventName);
    } catch (error) {
      // Any other error means the record lacks the structure the encoder reads.
      reject(id, error instanceof InvalidEventError ? error.message : 'unencodable_record');
      continue;
    }
    if (rejected.has(id)) continue;
    const body = JSON.stringify(event);
    const earlier = events.get(id);
    if (earlier === undefined) events.set(id, { event, body });
    else if (earlier.body !== body) reject(id, 'duplicate_record_id');
  }

  return {
    events: [...events.values()].map(({ event }) => event),
    rejected: [...rejected].map(([recordId, detail]) => ({ recordId, detail })),
  };
}

function encode(record: AudrRecord, eventName: EventNamer): StiggEvent {
  // Stigg usage is append-only: an event can be neither replaced nor voided once accepted,
  // so a restatement has no home.
  if (record.corrects !== undefined) throw new InvalidEventError('unsupported_correction');
  return createEvent({
    eventName: nameOf(record, eventName),
    // The paying account is the Stigg customer. `subscription_id` stays a dimension: a Stigg
    // resource is not a subscription, and an unknown one leaves the usage uncounted.
    customerId: record.attribution.account_id,
    idempotencyKey: record.record_id,
    eventTime: record.timing.event_time,
    dimensions: flattenRecord(record),
  });
}

function nameOf(record: AudrRecord, eventName: EventNamer): string {
  try {
    return eventName(record);
  } catch {
    // The host's function failed for this record; its error is never surfaced.
    throw new InvalidEventError('invalid_event_name');
  }
}
