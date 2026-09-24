import { type AudrRecord, BatchResult, type Logger, type Sink } from '../src/index.js';

export const EMITTER = { component: 'harness', name: 'test-harness', version: '1.0.0' } as const;

/** A logger that keeps every line so tests can assert on what was said. */
export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}

/** A sink whose every `deliver()` stays pending until the test answers it. */
export class ControlledSink implements Sink {
  readonly batches: (readonly AudrRecord[])[] = [];
  readonly #pending: ((result: BatchResult) => void)[] = [];
  closed = 0;

  deliver(batch: readonly AudrRecord[]): Promise<BatchResult> {
    this.batches.push(batch);
    return new Promise((resolve) => this.#pending.push(resolve));
  }

  /** Answer the oldest outstanding `deliver()`. */
  answer(result: BatchResult = BatchResult.accepted()): void {
    const resolve = this.#pending.shift();
    if (resolve === undefined) throw new Error('no deliver() is pending');
    resolve(result);
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

/** Let every queued promise callback run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}
