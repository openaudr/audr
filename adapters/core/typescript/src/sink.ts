import { type AudrRecord } from './record.js';

/**
 * A destination able to deliver batches of AUDR records.
 *
 * The pipeline guarantees that a batch is never empty, never exceeds the client's
 * `batchMaxSize`, arrives one at a time, and is never re-sent once answered. A sink reports
 * every outcome through `BatchResult`: `deliver()` does not throw for an ordinary delivery
 * failure, and `close()` is idempotent and never throws.
 */
export interface Sink {
  deliver(batch: readonly AudrRecord[]): Promise<BatchResult>;
  close(): Promise<void>;
}

/** A record the destination rejected, identified by its `record_id`. */
export interface RejectedRecord {
  readonly recordId: string;
  readonly detail?: string | undefined;
}

export type BatchOutcome = BatchResult['outcome'];

/**
 * A sink's answer for one batch.
 *
 * On `accepted`, a record named in `rejected` is dropped, a record named in `unknown` could
 * not be confirmed either way, and every other record was delivered. Any other outcome
 * applies to the whole batch. The pipeline never retries; a sink that wants retries makes
 * them inside `deliver()`.
 */
export type BatchResult =
  | {
      readonly outcome: 'accepted';
      readonly rejected?: readonly RejectedRecord[] | undefined;
      readonly unknown?: readonly string[] | undefined;
    }
  | {
      readonly outcome: 'retryable_failure' | 'permanent_failure';
      readonly detail?: string | undefined;
    }
  | { readonly outcome: 'closed' };

export const BatchResult = {
  /** The sink took the batch, optionally naming records it did not accept. */
  accepted(
    options: {
      rejected?: readonly RejectedRecord[] | undefined;
      unknown?: readonly string[] | undefined;
    } = {},
  ): BatchResult {
    return { outcome: 'accepted', ...options };
  },

  /** The whole batch failed, for a reason that may (`retryable`) or will not pass. */
  failed(options: { retryable: boolean; detail?: string | undefined }): BatchResult {
    const outcome = options.retryable ? 'retryable_failure' : 'permanent_failure';
    return options.detail === undefined ? { outcome } : { outcome, detail: options.detail };
  },

  /** The sink is closed and cannot accept the batch. */
  closed(): BatchResult {
    return { outcome: 'closed' };
  },
} as const;
