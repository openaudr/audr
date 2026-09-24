import { AssertionError } from 'node:assert';

import { describe, expect, it } from 'vitest';

import { type AudrRecord, BatchResult, type Sink, validate } from '../src/index.js';
import { assertSinkContract, makeRecord, MemorySink } from '../src/testing.js';

/** A sink whose behaviour each test overrides. */
function sink(overrides: Partial<Sink>): Sink {
  return {
    deliver: () => Promise.resolve(BatchResult.accepted()),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

describe('makeRecord', () => {
  it('builds a valid record and applies overrides', () => {
    expect(validate(makeRecord())).toEqual([]);
    expect(makeRecord({ attribution: { environment: 'staging' } }).attribution.environment).toBe(
      'staging',
    );
  });
});

describe('MemorySink', () => {
  it('keeps accepted records and rejects by name', async () => {
    const memory = new MemorySink({
      reject: (record) => (record.run.span_id === 'bad' ? 'no' : undefined),
    });
    const bad = makeRecord({ run: { run_id: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V', span_id: 'bad' } });
    const good = makeRecord();
    expect(await memory.deliver([bad, good])).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: bad.record_id, detail: 'no' }],
    });
    expect(memory.records).toEqual([good]);
    expect(memory.batches).toBe(1);
  });

  it.each(['retryable_failure', 'permanent_failure', 'closed'] as const)(
    'fails every batch with %s',
    async (failWith) => {
      const memory = new MemorySink({ failWith });
      expect((await memory.deliver([makeRecord()])).outcome).toBe(failWith);
      expect(memory.batches).toBe(0);
    },
  );

  it('honours the sink contract', async () => {
    await assertSinkContract(new MemorySink());
  });
});

describe('assertSinkContract', () => {
  const breach = async (candidate: Sink, message: string): Promise<void> => {
    const error: unknown = await assertSinkContract(candidate).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AssertionError);
    expect((error as AssertionError).message).toContain(message);
  };

  it('fails a sink whose deliver() throws', async () => {
    await breach(sink({ deliver: () => Promise.reject(new Error('x')) }), 'deliver() must report');
  });

  it('fails a sink whose close() throws', async () => {
    await breach(sink({ close: () => Promise.reject(new Error('x')) }), 'close() must report');
  });

  it('fails a sink that names a record outside the batch', async () => {
    await breach(
      sink({ deliver: () => Promise.resolve(BatchResult.accepted({ unknown: ['elsewhere'] })) }),
      'absent from the batch',
    );
  });

  it('fails a sink that names a record as both rejected and unknown', async () => {
    const deliver = (batch: readonly AudrRecord[]): Promise<BatchResult> => {
      const id = batch[0]!.record_id;
      return Promise.resolve(BatchResult.accepted({ rejected: [{ recordId: id }], unknown: [id] }));
    };
    await breach(sink({ deliver }), 'both rejected and unknown');
  });

  it('fails a sink that answers a failure after close()', async () => {
    let closed = false;
    await breach(
      sink({
        deliver: () =>
          Promise.resolve(
            closed ? BatchResult.failed({ retryable: true }) : BatchResult.accepted(),
          ),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      }),
      'got retryable_failure',
    );
  });

  it('passes a sink that reports a whole-batch failure, then closed after close()', async () => {
    let closed = false;
    await assertSinkContract(
      sink({
        deliver: () =>
          Promise.resolve(closed ? BatchResult.closed() : BatchResult.failed({ retryable: false })),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      }),
    );
  });
});
