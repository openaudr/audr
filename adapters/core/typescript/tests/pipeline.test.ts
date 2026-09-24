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

  it('accounts a batch unknown when the sink returns something that is not a result', async () => {
    const sink = new MemorySink();
    sink.deliver = () => Promise.resolve({ outcome: 'maybe' } as unknown as BatchResult);
    const { client, logger } = setup(sink);
    client.record(makeRecord());
    await client.flush();
    expect(client.stats).toMatchObject({ unknown: 1, batches: 1 });
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
    expect(submitted).toBe(20);
    expect(sent + dropped + unknown).toBe(submitted);
  });
});
