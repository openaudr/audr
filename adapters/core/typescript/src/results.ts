import { type ValidationIssue } from './errors.js';
import { type AudrRecord } from './record.js';

/** What `Client.record()` did with a record, decided before any I/O. */
export type SubmitOutcome =
  'queued' | 'rejected_invalid' | 'dropped_queue_full' | 'dropped_not_running';

export interface SubmitResult {
  readonly outcome: SubmitOutcome;
  /** Whether the record was accepted onto the delivery queue. */
  readonly queued: boolean;
  /** Every rule the record breaks, when `outcome` is `rejected_invalid`. */
  readonly issues: readonly ValidationIssue[];
}

/** A terminal state other than `sent`. `unknown` is terminal and never relabelled. */
export type Disposition = 'dropped' | 'unknown';

/** Stable, value-free reasons a record was not delivered. */
export type FailureReason =
  | 'invalid'
  | 'queue_full'
  | 'shutdown'
  | 'rejected'
  | 'sink_failure'
  | 'sink_closed'
  | 'inconclusive';

/** One record that ended `dropped` or `unknown`, as passed to `onFailure`. */
export interface FailedRecord {
  readonly record: AudrRecord;
  readonly disposition: Disposition;
  readonly reason: FailureReason;
  /** Whether replaying the record could succeed. Replays are safe: sinks de-duplicate on `record_id`. */
  readonly retryable: boolean;
  readonly detail?: string | undefined;
}

/**
 * Called for every record that ends `dropped` or `unknown`. A returned promise is not
 * awaited on the delivery path; `shutdown()` waits for it within its bound. It is never
 * re-entered: a record it submits that fails at once is reported only by the `SubmitResult`
 * that `record()` returns to it.
 */
export type FailureCallback =
  ((failure: FailedRecord) => void) | ((failure: FailedRecord) => Promise<void>);

/**
 * Called once per accepted batch with the records the sink accepted. A returned promise is
 * not awaited on the delivery path; `shutdown()` waits for it within its bound.
 */
export type DeliveredCallback =
  ((records: readonly AudrRecord[]) => void) | ((records: readonly AudrRecord[]) => Promise<void>);

/**
 * A point-in-time snapshot of delivery counters. Every submitted record ends in exactly
 * one of `sent`, `dropped` or `unknown`.
 */
export interface DeliveryStats {
  readonly submitted: number;
  readonly sent: number;
  readonly dropped: number;
  readonly unknown: number;
  readonly batches: number;
  readonly queueDepth: number;
  readonly queueCapacity: number;
}

/** Where the client writes diagnostics, if given one. `console` satisfies it, as do most loggers. */
export interface Logger {
  warn(message: string): void;
  error(message: string): void;
}
