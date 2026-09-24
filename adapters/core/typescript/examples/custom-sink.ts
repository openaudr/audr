/**
 * A minimal custom `Sink` that prints each record's `record_id`, checked against the same
 * contract every sink in the repository passes.
 */
import { type AudrRecord, BatchResult, type Sink } from 'audr';
import { assertSinkContract } from 'audr/testing';

class PrintSink implements Sink {
  #closed = false;

  deliver(batch: readonly AudrRecord[]): Promise<BatchResult> {
    if (this.#closed) return Promise.resolve(BatchResult.closed());
    for (const record of batch) console.log(`delivered ${record.record_id}`);
    return Promise.resolve(BatchResult.accepted());
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}

await assertSinkContract(new PrintSink());
console.log('PrintSink satisfies the Sink contract');
