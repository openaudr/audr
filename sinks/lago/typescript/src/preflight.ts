/**
 * Local processing of a batch before anything is sent: each record becomes one Lago event or
 * a rejection that names its cause. Every record is judged on its own, so one unusable record
 * never keeps the rest from being delivered.
 */
import { type AudrRecord, type RejectedRecord } from '@openaudr/audr';

import { createEvent, InvalidEventError, type LagoEvent } from './event.js';
import { flattenRecord } from './flatten.js';

export interface Preflight {
  /** One event per distinct `record_id`, in batch order. */
  readonly events: readonly LagoEvent[];
  /** One entry per rejected `record_id`. */
  readonly rejected: readonly RejectedRecord[];
}

/**
 * Encode `batch`.
 *
 * A record that repeats an earlier one byte for byte shares that record's event, so one
 * outcome answers both. Records that share a `record_id` but differ in content are all
 * rejected: Lago keeps one event per `transaction_id`, and sending either would silently
 * discard the other.
 */
export function preflight(batch: readonly AudrRecord[]): Preflight {
  const events = new Map<string, { readonly event: LagoEvent; readonly body: string }>();
  const rejected = new Map<string, string>();
  const reject = (id: string, detail: string): void => {
    events.delete(id);
    if (!rejected.has(id)) rejected.set(id, detail);
  };

  for (const record of batch) {
    const id = record.record_id;
    let event: LagoEvent;
    try {
      event = encode(record);
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

function encode(record: AudrRecord): LagoEvent {
  // Lago can neither replace an event without its original timestamp nor accept a second
  // event under one transaction_id on a Postgres event store, so a restatement has no home.
  if (record.corrects !== undefined) throw new InvalidEventError('unsupported_correction');
  return createEvent({
    transactionId: record.record_id,
    subscriptionId: record.attribution.subscription_id,
    // The host names the feature on the record, and the feature is the billable metric.
    code: record.attribution.feature_id,
    eventTime: record.timing.event_time,
    properties: flattenRecord(record),
  });
}
