/**
 * Test helpers for this package and for third-party sinks. They sit outside the delivery
 * pipeline's stable API, so their shapes may change independently of it.
 */
import { AssertionError } from 'node:assert';

import { errorName } from './errors.js';
import { type AudrRecord, createRecord, type RecordInput } from './record.js';
import { BatchResult, type RejectedRecord, type Sink } from './sink.js';
import { uuidv7 } from './uuid.js';

/** A valid, minimal generation record, with `overrides` applied to the top level. */
export function makeRecord(overrides: Partial<RecordInput> = {}): AudrRecord {
  return createRecord({
    emitter: { component: 'harness', name: 'audr-testing', version: '0' },
    resource: {
      provider: 'anthropic',
      type: 'model',
      name: 'test-model',
      operation: 'generation',
      modality: 'text',
    },
    usage: { llm: { input_tokens: 10, output_tokens: 5, requests: 1 } },
    run: { run_id: uuidv7(), span_id: 'span-1' },
    attribution: { environment: 'test' },
    ...overrides,
  });
}

export interface MemorySinkOptions {
  /** Return a reason to reject a record by name; `undefined` accepts it. */
  readonly reject?: ((record: AudrRecord) => string | undefined) | undefined;
  /** Answer every batch with this whole-batch outcome instead. */
  readonly failWith?: 'retryable_failure' | 'permanent_failure' | 'closed' | undefined;
}

/** An in-memory `Sink` that keeps every record it accepts in `records`. */
export class MemorySink implements Sink {
  readonly records: AudrRecord[] = [];
  /** Batches answered with `accepted`. */
  batches = 0;
  closed = false;
  readonly #options: MemorySinkOptions;

  constructor(options: MemorySinkOptions = {}) {
    this.#options = options;
  }

  deliver(batch: readonly AudrRecord[]): Promise<BatchResult> {
    const { failWith, reject } = this.#options;
    if (this.closed || failWith === 'closed') return Promise.resolve(BatchResult.closed());
    if (failWith !== undefined) {
      return Promise.resolve(BatchResult.failed({ retryable: failWith === 'retryable_failure' }));
    }
    const rejected: RejectedRecord[] = [];
    for (const record of batch) {
      const reason = reject?.(record);
      if (reason === undefined) this.records.push(record);
      else rejected.push({ recordId: record.record_id, detail: reason });
    }
    this.batches += 1;
    return Promise.resolve(BatchResult.accepted({ rejected }));
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/**
 * Assert that `sink` honours the `Sink` contract, throwing `AssertionError` at the first
 * breach. The check closes `sink`, so pass a disposable instance. `records` defaults to
 * three records from `makeRecord`.
 */
export async function assertSinkContract(
  sink: Sink,
  options: { records?: readonly AudrRecord[] } = {},
): Promise<void> {
  const batch = options.records ?? [makeRecord(), makeRecord(), makeRecord()];
  const ids = new Set(batch.map((record) => record.record_id));

  const result = await expectNoThrow('deliver()', () => sink.deliver(batch));
  if (result.outcome === 'accepted') {
    const rejected = (result.rejected ?? []).map((entry) => entry.recordId);
    const unknown = result.unknown ?? [];
    if ([...rejected, ...unknown].some((id) => !ids.has(id))) {
      fail('a result must not name a record_id that is absent from the batch');
    }
    if (rejected.some((id) => unknown.includes(id))) {
      fail('a record_id must not appear in both rejected and unknown');
    }
  }

  await expectNoThrow('close()', () => sink.close());
  await expectNoThrow('a second close()', () => sink.close());

  const afterClose = await expectNoThrow('deliver() after close()', () => sink.deliver(batch));
  if (afterClose.outcome !== 'closed' && afterClose.outcome !== 'accepted') {
    fail(`deliver() after close() must answer closed (or accepted), got ${afterClose.outcome}`);
  }
}

async function expectNoThrow<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    return fail(`${what} must report its outcome, not throw; it threw ${errorName(error)}`);
  }
}

function fail(message: string): never {
  throw new AssertionError({ message });
}
