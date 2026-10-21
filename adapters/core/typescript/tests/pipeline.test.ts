import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AudrRecord,
  BatchResult,
  Client,
  type ClientOptions,
  type FailedRecord,
  type Sink,
} from '../src/index.js';
import { makeRecord, MemorySink } from '../src/testing.js';
import { ControlledSink, recordingLogger, settle } from './helpers.js';

function setup<S extends Sink>(sink: S, options: ClientOptions = {}) {
  const failures: FailedRecord[] = [];
  const delivered: (readonly AudrRecord[])[] = [];
  const logger = recordingLogger();
  const client = new Client(sink, {
    logger,
    onFailure: (failure) => failures.push(failure),
    onDelivered: (records) => delivered.push(records),
    ...options,
  });
  return { sink, client, failures, delivered, logger };
}

/** An `Error` whose `name` throws when read. */
function unreadableError(): Error {
  return Object.create(Error.prototype, {
    name: {
      get() {
        throw new TypeError('name');
      },
    },
  }) as Error;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('batching', () => {
  it('holds a partial batch for lingerMs, then delivers it', async () => {
    const { sink, client } = setup(new MemorySink(), { lingerMs: 1000 });
    client.record(makeRecord());
    client.record(makeRecord());
    await vi.advanceTimersByTimeAsync(999);
    expect(sink.batches).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.batches).toBe(1);
    expect(sink.records).toHaveLength(2);
  });

  it('delivers a full batch at once', async () => {
    const { sink, client } = setup(new MemorySink(), { batchMaxSize: 2, lingerMs: 60_000 });
    client.record(makeRecord());
    client.record(makeRecord());
    await settle();
    expect(sink.batches).toBe(1);
  });

  it('never exceeds batchMaxSize and keeps one batch in flight', async () => {
    const { sink, client } = setup(new ControlledSink(), { batchMaxSize: 2 });
    for (let index = 0; index < 5; index += 1) client.record(makeRecord());
    const flushed = client.flush();
    await settle();
    expect(sink.batches.map((batch) => batch.length)).toEqual([2]);
    sink.answer();
    await settle();
    sink.answer();
    await settle();
    sink.answer();
    expect(await flushed).toBe(true);
    expect(sink.batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(client.stats).toMatchObject({ submitted: 5, sent: 5, batches: 3 });
  });

  it('starts a new linger window for records that arrive during a delivery', async () => {
    const { sink, client } = setup(new ControlledSink(), { lingerMs: 100 });
    client.record(makeRecord());
    await vi.advanceTimersByTimeAsync(100);
    client.record(makeRecord());
    sink.answer();
    await vi.advanceTimersByTimeAsync(99);
    expect(sink.batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.batches).toHaveLength(2);
  });

  it('drops a record when the queue is full', async () => {
    const { client, failures, logger } = setup(new ControlledSink(), {
      maxQueueSize: 1,
      batchMaxSize: 1,
    });
    expect(client.record(makeRecord()).outcome).toBe('queued');
    await settle();
    expect(client.record(makeRecord())).toEqual({
      outcome: 'dropped_queue_full',
      queued: false,
      issues: [],
    });
    expect(client.stats).toMatchObject({
      submitted: 2,
      dropped: 1,
      queueDepth: 1,
      queueCapacity: 1,
    });
    expect(failures).toMatchObject([{ reason: 'queue_full', retryable: true }]);
    expect(logger.lines).toEqual(['audr: record dropped, queue full (depth=1)']);
  });
});

describe('sink outcomes', () => {
  it('reports rejected and unknown records on an accepted batch', async () => {
    const records = [makeRecord(), makeRecord(), makeRecord()];
    const { sink, client, failures, delivered } = setup(new ControlledSink());
    for (const record of records) client.record(record);
    const flushed = client.flush();
    await settle();
    sink.answer({
      outcome: 'accepted',
      rejected: [{ recordId: records[0]!.record_id, detail: 'duplicate' }],
      unknown: [records[1]!.record_id],
    });
    await flushed;
    expect(client.stats).toMatchObject({ sent: 1, dropped: 1, unknown: 1, batches: 1 });
    expect(failures).toMatchObject([
      { disposition: 'dropped', reason: 'rejected', retryable: false, detail: 'duplicate' },
      { disposition: 'unknown', reason: 'inconclusive', retryable: true },
    ]);
    expect(delivered).toEqual([[records[2]]]);
  });

  it.each([
    ['retryable_failure', 'sink_failure', true],
    ['permanent_failure', 'sink_failure', false],
    ['closed', 'sink_closed', true],
  ] as const)('drops the whole batch on %s', async (outcome, reason, retryable) => {
    const { sink, client, failures, delivered, logger } = setup(new ControlledSink());
    client.record(makeRecord());
    client.record(makeRecord());
    const flushed = client.flush();
    await settle();
    sink.answer(outcome === 'closed' ? { outcome } : { outcome, detail: 'HTTP 503' });
    await flushed;
    expect(client.stats).toMatchObject({ dropped: 2, sent: 0, batches: 1 });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ disposition: 'dropped', reason, retryable });
    expect(delivered).toEqual([]);
    expect(logger.lines).toHaveLength(1);
  });

  it('accounts a batch unknown when the sink throws', async () => {
    const sink = new MemorySink();
    sink.deliver = () => Promise.reject(new TypeError('socket hang up: secret-value'));
    const { client, failures, logger } = setup(sink);
    client.record(makeRecord());
    await client.flush();
    expect(client.stats).toMatchObject({ unknown: 1, batches: 0 });
    expect(failures).toMatchObject([{ disposition: 'unknown', reason: 'inconclusive' }]);
    expect(logger.lines).toEqual(['audr: 1 record(s) unknown, the sink threw TypeError']);
  });

  it('names an error it cannot read as unknown', async () => {
    const sink = new MemorySink();
    sink.deliver = () => Promise.reject(unreadableError());
    const { client, failures, logger } = setup(sink);
    client.record(makeRecord());
    await client.flush();
    expect(client.stats).toMatchObject({ unknown: 1, queueDepth: 0 });
    expect(failures).toMatchObject([{ disposition: 'unknown', reason: 'inconclusive' }]);
    expect(logger.lines).toEqual(['audr: 1 record(s) unknown, the sink threw unknown']);
  });

  it('accounts a batch unknown when the sink returns something that is not a result', async () => {
    const sink = new MemorySink();
    sink.deliver = () => Promise.resolve({ outcome: 'maybe' } as unknown as BatchResult);
    const { client, logger } = setup(sink);
    client.record(makeRecord());
    await client.flush();
    expect(client.stats).toMatchObject({ unknown: 1, batches: 1 });
    expect(logger.lines).toEqual(['audr: 1 record(s) unknown, the sink returned no valid result']);
  });

  it('accounts a batch unknown without counting it when the sink resolves a non-object', async () => {
    const sink = new MemorySink();
    sink.deliver = () => Promise.resolve(undefined as unknown as BatchResult);
    const { client, logger } = setup(sink);
    client.record(makeRecord());
    await client.flush();
    expect(client.stats).toMatchObject({ unknown: 1, batches: 0 });
    expect(logger.lines).toEqual(['audr: 1 record(s) unknown, the sink returned no valid result']);
  });

  it('survives callbacks that throw', async () => {
    const { client, logger } = setup(new MemorySink({ reject: () => 'no' }), {
      onFailure: () => {
        throw new Error('x');
      },
      onDelivered: () => {
        throw new Error('y');
      },
    });
    client.record(makeRecord());
    await client.flush();
    expect(logger.lines).toEqual(['audr: onFailure callback threw (Error)']);

    const accepting = setup(new MemorySink(), {
      onDelivered: () => {
        throw new SyntaxError('y');
      },
    });
    accepting.client.record(makeRecord());
    await accepting.client.flush();
    expect(accepting.logger.lines).toEqual(['audr: onDelivered callback threw (SyntaxError)']);
  });

  it('survives callbacks whose promises reject', async () => {
    const { client, logger } = setup(new MemorySink({ reject: () => 'no' }), {
      onFailure: () => Promise.reject(new RangeError('x')),
    });
    client.record(makeRecord());
    await client.flush();
    await settle();
    expect(logger.lines).toEqual(['audr: onFailure callback threw (RangeError)']);

    const accepting = setup(new MemorySink(), {
      onDelivered: async () => {
        await Promise.resolve();
        throw new SyntaxError('y');
      },
    });
    accepting.client.record(makeRecord());
    await accepting.client.flush();
    await settle();
    expect(accepting.logger.lines).toEqual(['audr: onDelivered callback threw (SyntaxError)']);
  });

  it('survives callbacks that throw or reject with an error it cannot read', async () => {
    const throwing = setup(new MemorySink({ reject: () => 'no' }), {
      onFailure: () => {
        throw unreadableError();
      },
    });
    expect(throwing.client.record(makeRecord({ attribution: {} })).outcome).toBe(
      'rejected_invalid',
    );
    throwing.client.record(makeRecord());
    await throwing.client.flush();
    expect(throwing.logger.lines).toEqual([
      'audr: record rejected, 1 validation issue(s)',
      'audr: onFailure callback threw (unknown)',
      'audr: onFailure callback threw (unknown)',
    ]);

    const rejecting = setup(new MemorySink(), {
      onDelivered: () => Promise.reject(unreadableError()),
    });
    rejecting.client.record(makeRecord());
    await rejecting.client.flush();
    await settle();
    expect(rejecting.logger.lines).toEqual(['audr: onDelivered callback threw (unknown)']);
  });

  it('keeps every submitted record in exactly one terminal state', async () => {
    let call = 0;
    const sink = new MemorySink();
    sink.deliver = (batch) => {
      call += 1;
      switch (call % 4) {
        case 0:
          return Promise.resolve(BatchResult.accepted({ unknown: [batch[0]!.record_id] }));
        case 1:
          return Promise.resolve(BatchResult.failed({ retryable: true }));
        case 2:
          return Promise.resolve(BatchResult.closed());
        default:
          return Promise.resolve(BatchResult.accepted());
      }
    };
    const { client } = setup(sink, { batchMaxSize: 3 });
    for (let index = 0; index < 20; index += 1) client.record(makeRecord());
    await client.shutdown();
    const { submitted, sent, dropped, unknown } = client.stats;
    expect(sent + dropped + unknown).toBe(submitted);
    expect(client.stats).toMatchObject({ submitted: 20, sent: 7, dropped: 12, unknown: 1 });
  });
});

describe('shutdown', () => {
  it('waits for promises the callbacks return', async () => {
    const replayed: string[] = [];
    const { client } = setup(new MemorySink({ reject: () => 'no' }), {
      onFailure: async ({ record }) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        replayed.push(record.record_id);
      },
    });
    const record = makeRecord();
    client.record(record);
    let stopped = false;
    void client.shutdown(1000).then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    expect(replayed).toEqual([record.record_id]);
  });

  it('stops waiting for callbacks at its bound', async () => {
    const { client, logger } = setup(new MemorySink(), {
      onDelivered: () => new Promise<void>(() => undefined),
    });
    client.record(makeRecord());
    const stopped = client.shutdown(500);
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    expect(logger.lines).toEqual(['audr: shutdown left 1 callback(s) unsettled']);
  });

  it('aborts the delivery still in flight at its bound', async () => {
    const sink = new ControlledSink();
    const { client } = setup(sink);
    client.record(makeRecord());
    const stopped = client.shutdown(500);
    await settle();
    const [signal] = sink.signals;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    expect(signal?.aborted).toBe(true);
    expect(client.stats).toMatchObject({ unknown: 1 });
  });

  it('stops waiting for the sink to close at its bound', async () => {
    const sink = new MemorySink();
    sink.close = () => new Promise<void>(() => undefined);
    const { client, logger } = setup(sink);
    let stopped = false;
    void client.shutdown(500).then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    expect(logger.lines).toEqual(['audr: sink close did not settle within the shutdown bound']);
  });

  it('logs a sink close that fails after the bound', async () => {
    const sink = new MemorySink();
    sink.close = () =>
      new Promise<void>((_, reject) => setTimeout(reject, 1000, new Error('secret-value')));
    const { client, logger } = setup(sink);
    await Promise.all([client.shutdown(500), vi.advanceTimersByTimeAsync(1000)]);
    expect(logger.lines).toEqual([
      'audr: sink close did not settle within the shutdown bound',
      'audr: sink close failed (Error)',
    ]);
  });
});
