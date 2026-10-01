import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BatchResult,
  Client,
  type ClientOptions,
  ConfigurationError,
  type FailedRecord,
  type Sink,
} from '../src/index.js';
import { makeRecord, MemorySink } from '../src/testing.js';
import { ControlledSink, EMITTER, recordingLogger, settle } from './helpers.js';

function client(sink: Sink, options: ClientOptions = {}): Client {
  return new Client(sink, { logger: recordingLogger(), ...options });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Client construction', () => {
  it.each([
    [{ maxQueueSize: 0 }, 'maxQueueSize'],
    [{ maxQueueSize: 1.5 }, 'maxQueueSize'],
    [{ batchMaxSize: 0 }, 'batchMaxSize'],
    [{ batchMaxSize: 501 }, 'batchMaxSize'],
    [{ lingerMs: -1 }, 'lingerMs'],
    [{ lingerMs: Infinity }, 'lingerMs'],
    [{ lingerMs: 2 ** 31 }, 'lingerMs'],
  ] as const)('rejects %o', (options, field) => {
    expect(() => new Client(new MemorySink(), options)).toThrow(ConfigurationError);
    expect(() => new Client(new MemorySink(), options)).toThrow(field);
  });

  it.each([
    [{ ...EMITTER, component: 'nope' }, 'INVALID_ENUM at /emitter/component'],
    [{ ...EMITTER, name: '' }, 'INVALID_STRING at /emitter/name'],
    ['emitter', 'INVALID_TYPE at /emitter'],
  ])('rejects the invalid emitter %o', (emitter, summary) => {
    const construct = () => new Client(new MemorySink(), { emitter: emitter as never });
    expect(construct).toThrow(ConfigurationError);
    expect(construct).toThrow(`emitter is invalid: ${summary}`);
  });

  it('rejects a sink without deliver() and close()', () => {
    expect(() => new Client({} as Sink)).toThrow('sink must implement deliver() and close()');
    expect(() => new Client(null as unknown as Sink)).toThrow(ConfigurationError);
  });
});

describe('Client.record', () => {
  it('queues a valid record and delivers it on flush', async () => {
    const sink = new MemorySink();
    const audr = client(sink);
    const record = makeRecord();
    expect(audr.record(record)).toEqual({ outcome: 'queued', queued: true, issues: [] });
    expect(await audr.flush()).toBe(true);
    expect(sink.records).toEqual([record]);
    expect(audr.stats).toMatchObject({ submitted: 1, sent: 1, batches: 1, queueDepth: 0 });
  });

  it('stamps its emitter on a record that has none', async () => {
    const sink = new MemorySink();
    const audr = client(sink, { emitter: EMITTER });
    const { emitter: _omitted, ...bare } = makeRecord();
    audr.record(bare);
    audr.record(makeRecord());
    await audr.flush();
    expect(sink.records.map((record) => record.emitter?.name)).toEqual([
      'test-harness',
      'audr-testing',
    ]);
  });

  it('rejects an invalid record, reporting it to onFailure', () => {
    const failures: FailedRecord[] = [];
    const logger = recordingLogger();
    const audr = client(new MemorySink(), {
      logger,
      onFailure: (failure) => failures.push(failure),
    });
    const result = audr.record(makeRecord({ attribution: {} }));
    expect(result.outcome).toBe('rejected_invalid');
    expect(result.queued).toBe(false);
    expect(result.issues.map((found) => found.path)).toEqual(['/attribution/environment']);
    expect(failures).toMatchObject([
      { disposition: 'dropped', reason: 'invalid', retryable: false },
    ]);
    expect(audr.stats.submitted).toBe(0);
    expect(logger.lines).toEqual(['audr: record rejected, 1 validation issue(s)']);
  });

  it('reports every invalid object to onFailure, however malformed', () => {
    const failures: FailedRecord[] = [];
    const audr = client(new MemorySink(), { onFailure: (failure) => failures.push(failure) });
    const { emitter: _omitted, ...bare } = makeRecord();
    const results = [
      audr.record(bare),
      audr.record({ ...makeRecord(), record_id: 'nope' }),
      audr.record({ nope: true } as never),
    ];
    expect(results.map(({ outcome }) => outcome)).toEqual(Array(3).fill('rejected_invalid'));
    expect(results[0]?.issues.map(({ code, path }) => `${code} ${path}`)).toEqual([
      'REQUIRED /emitter',
    ]);
    expect(failures.map(({ reason }) => reason)).toEqual(['invalid', 'invalid', 'invalid']);
  });

  it.each([['abc'], [null], [42]])(
    'reports %o as INVALID_TYPE at / without stamping its emitter',
    (value) => {
      const onFailure = vi.fn();
      const audr = client(new MemorySink(), { emitter: EMITTER, onFailure });
      const result = audr.record(value as never);
      expect(result.outcome).toBe('rejected_invalid');
      expect(result.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: 'INVALID_TYPE', path: '/' },
      ]);
      expect(onFailure).not.toHaveBeenCalled();
    },
  );

  it('checks event_time against the configured clock', () => {
    const audr = client(new MemorySink(), { clock: () => new Date('2020-01-01T00:00:00Z') });
    expect(audr.record(makeRecord()).issues.map((found) => found.code)).toEqual([
      'FUTURE_EVENT_TIME',
    ]);
  });

  it.each([
    [
      'throws',
      () => {
        throw new RangeError('clock');
      },
      'audr: clock threw (RangeError), using the system clock',
    ],
    [
      'returns an invalid Date',
      () => new Date(Number.NaN),
      'audr: clock returned an invalid Date, using the system clock',
    ],
  ])('falls back to the system clock when the clock %s', (_what, clock, line) => {
    const logger = recordingLogger();
    const audr = client(new MemorySink(), { clock, logger });
    expect(audr.record(makeRecord()).outcome).toBe('queued');
    expect(logger.lines).toEqual([line]);
  });

  it('delivers its own copy, unaffected by later changes to the record', async () => {
    const sink = new MemorySink();
    const audr = client(sink);
    const record = structuredClone(makeRecord());
    const original = structuredClone(record);
    audr.record(record);
    (record.usage as { llm: { input_tokens: number } }).llm.input_tokens = -5;
    await audr.flush();
    expect(sink.records).toEqual([original]);
  });

  it('delivers and reports the record without properties set to undefined', async () => {
    const sink = new MemorySink();
    const failures: FailedRecord[] = [];
    const audr = client(sink, { onFailure: (failure) => failures.push(failure) });
    audr.record({ ...makeRecord(), corrects: undefined });
    audr.record({ ...makeRecord({ attribution: {} }), corrects: undefined });
    await audr.flush();
    expect(sink.records).toHaveLength(1);
    expect('corrects' in sink.records[0]!).toBe(false);
    expect('corrects' in failures[0]!.record).toBe(false);
  });

  it('rejects a value that is not plain data without throwing', () => {
    const onFailure = vi.fn();
    const logger = recordingLogger();
    const audr = client(new MemorySink(), { emitter: EMITTER, logger, onFailure });
    const record = { ...makeRecord(), run: { run_id: 'run-1234', span_id: () => 's' } };
    const { emitter: _omitted, ...bare } = makeRecord();
    const hostile = new Proxy(bare, {
      ownKeys: () => {
        throw new TypeError('trap');
      },
    });
    for (const value of [record, hostile]) {
      expect(audr.record(value as never)).toMatchObject({
        outcome: 'rejected_invalid',
        issues: [{ code: 'INVALID_TYPE', path: '/' }],
      });
    }
    expect(onFailure).not.toHaveBeenCalled();
    expect(logger.lines).toEqual([
      'audr: record rejected, it is not plain data (DataCloneError)',
      'audr: record rejected, it is not plain data (TypeError)',
    ]);
  });

  it('logs nothing unless given a logger', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const audr = new Client(new MemorySink(), { maxQueueSize: 1 });
    audr.record(makeRecord({ attribution: {} }));
    audr.record(makeRecord());
    audr.record(makeRecord());
    await audr.shutdown();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps working when the logger throws', async () => {
    const sink = new MemorySink();
    const throwing = () => {
      throw new Error('logger');
    };
    const audr = client(sink, { maxQueueSize: 1, logger: { warn: throwing, error: throwing } });
    expect(audr.record(makeRecord({ attribution: {} })).outcome).toBe('rejected_invalid');
    expect(audr.record(makeRecord()).outcome).toBe('queued');
    expect(audr.record(makeRecord()).outcome).toBe('dropped_queue_full');
    await audr.shutdown();
    expect(sink.records).toHaveLength(1);
  });

  it('survives an onFailure callback that throws', () => {
    const logger = recordingLogger();
    const audr = client(new MemorySink(), {
      logger,
      onFailure: () => {
        throw new TypeError('boom');
      },
    });
    expect(audr.record(makeRecord({ attribution: {} })).outcome).toBe('rejected_invalid');
    expect(logger.lines).toContain('audr: onFailure callback threw (TypeError)');
  });

  it('survives an onFailure callback whose promise rejects', async () => {
    vi.useFakeTimers();
    const logger = recordingLogger();
    const audr = client(new MemorySink(), {
      logger,
      onFailure: () => Promise.reject(new TypeError('boom')),
    });
    expect(audr.record(makeRecord({ attribution: {} })).outcome).toBe('rejected_invalid');
    await settle();
    expect(logger.lines).toContain('audr: onFailure callback threw (TypeError)');
  });

  describe('when onFailure resubmits the record', () => {
    function resubmitting(sink: Sink, options: ClientOptions = {}) {
      const failures: FailedRecord[] = [];
      const nested: string[] = [];
      const audr: Client = client(sink, {
        ...options,
        onFailure: (failure) => {
          failures.push(failure);
          nested.push(audr.record(failure.record).outcome);
        },
      });
      return { audr, failures, nested };
    }

    it('does not recurse for a record that is still invalid', () => {
      const { audr, failures, nested } = resubmitting(new MemorySink());
      expect(audr.record(makeRecord({ attribution: {} })).outcome).toBe('rejected_invalid');
      expect(failures.map(({ reason }) => reason)).toEqual(['invalid']);
      expect(nested).toEqual(['rejected_invalid']);
    });

    it('does not recurse while the queue is full', () => {
      const { audr, failures, nested } = resubmitting(new MemorySink(), { maxQueueSize: 1 });
      audr.record(makeRecord());
      expect(audr.record(makeRecord()).outcome).toBe('dropped_queue_full');
      expect(failures.map(({ reason }) => reason)).toEqual(['queue_full']);
      expect(nested).toEqual(['dropped_queue_full']);
      expect(audr.stats).toMatchObject({ submitted: 3, dropped: 2, queueDepth: 1 });
    });

    it('does not recurse when a replay from a failed batch finds the queue full', async () => {
      const sink = new MemorySink({ failWith: 'permanent_failure' });
      const { audr, failures, nested } = resubmitting(sink, { maxQueueSize: 1 });
      audr.record(makeRecord());
      await audr.flush();
      expect(failures.map(({ reason }) => reason)).toEqual(['sink_failure']);
      expect(nested).toEqual(['dropped_queue_full']);
    });

    it('queues a corrected record', async () => {
      const sink = new MemorySink();
      const nested: string[] = [];
      const audr: Client = client(sink, {
        onFailure: ({ record }) => {
          const attribution = { ...record.attribution, environment: 'test' } as const;
          nested.push(audr.record({ ...record, attribution }).outcome);
        },
      });
      expect(audr.record(makeRecord({ attribution: {} })).outcome).toBe('rejected_invalid');
      await audr.flush();
      expect(nested).toEqual(['queued']);
      expect(sink.records.map((record) => record.attribution.environment)).toEqual(['test']);
    });
  });

  it('drops records after shutdown without counting them', async () => {
    const audr = client(new MemorySink());
    await audr.shutdown();
    expect(audr.record(makeRecord()).outcome).toBe('dropped_not_running');
    expect(audr.stats.submitted).toBe(0);
  });
});

describe('Client lifecycle', () => {
  it('delivers queued records and closes the sink on shutdown', async () => {
    const sink = new MemorySink();
    const audr = client(sink);
    audr.record(makeRecord());
    await audr.shutdown();
    expect(sink.records).toHaveLength(1);
    expect(sink.closed).toBe(true);
  });

  it('leaves the sink open when ownsSink is false', async () => {
    const sink = new MemorySink();
    await client(sink, { ownsSink: false }).shutdown();
    expect(sink.closed).toBe(false);
  });

  it('shuts down once, however often it is asked', async () => {
    const sink = new ControlledSink();
    const audr = client(sink);
    await Promise.all([audr.shutdown(), audr.shutdown()]);
    await audr.shutdown();
    expect(sink.closed).toBe(1);
  });

  it('shuts down at the end of an `await using` block', async () => {
    const sink = new MemorySink();
    {
      await using audr = client(sink);
      audr.record(makeRecord());
    }
    expect(sink.records).toHaveLength(1);
    expect(sink.closed).toBe(true);
  });

  it.each([-1, Number.NaN, '100'])('rejects a timeout of %o', async (timeoutMs) => {
    const audr = client(new MemorySink());
    await expect(audr.flush(timeoutMs as number)).rejects.toThrow(ConfigurationError);
    await expect(audr.shutdown(timeoutMs as number)).rejects.toThrow('timeoutMs');
    await audr.shutdown();
  });

  it('waits without limit when the timeout is too long for a timer', async () => {
    vi.useFakeTimers();
    const sink = new ControlledSink();
    const audr = client(sink);
    audr.record(makeRecord());
    let flushed: boolean | undefined;
    void audr.flush(Infinity).then((result) => (flushed = result));
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(flushed).toBeUndefined();
    sink.answer();
    await settle();
    expect(flushed).toBe(true);
  });

  it('flush after shutdown resolves true at once', async () => {
    const audr = client(new MemorySink());
    await audr.shutdown();
    expect(await audr.flush()).toBe(true);
  });

  it('flush during shutdown waits for shutdown to finish', async () => {
    vi.useFakeTimers();
    const sink = new ControlledSink();
    const audr = client(sink);
    audr.record(makeRecord());
    void audr.shutdown();
    let settled = false;
    const flushed = audr.flush().finally(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    sink.answer();
    expect(await flushed).toBe(true);
    expect(sink.closed).toBe(1);
  });

  it('flush during shutdown gives up at its own bound', async () => {
    vi.useFakeTimers();
    const audr = client(new ControlledSink());
    audr.record(makeRecord());
    const stopped = audr.shutdown(1000);
    const flushed = audr.flush(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(900);
    await stopped;
  });

  it('logs, rather than throws, when the sink fails to close', async () => {
    const logger = recordingLogger();
    const sink = new MemorySink();
    sink.close = () => Promise.reject(new RangeError('bad'));
    await client(sink, { logger }).shutdown();
    expect(logger.lines).toEqual(['audr: sink close failed (RangeError)']);
  });

  it('flush gives up at its bound but keeps the records queued', async () => {
    vi.useFakeTimers();
    const sink = new ControlledSink();
    const audr = client(sink);
    audr.record(makeRecord());
    const flushed = audr.flush(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await flushed).toBe(false);
    expect(audr.stats.queueDepth).toBe(1);
    sink.answer();
    await settle();
    expect(audr.stats).toMatchObject({ sent: 1, queueDepth: 0 });
  });

  it('shutdown accounts for what is still outstanding at its bound', async () => {
    vi.useFakeTimers();
    const sink = new ControlledSink();
    const failures: FailedRecord[] = [];
    const logger = recordingLogger();
    const audr = client(sink, {
      batchMaxSize: 1,
      logger,
      onFailure: (failure) => failures.push(failure),
    });
    audr.record(makeRecord());
    audr.record(makeRecord());
    const stopped = audr.shutdown(500);
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    expect(audr.stats).toMatchObject({ submitted: 2, sent: 0, dropped: 1, unknown: 1 });
    expect(failures.map((failure) => [failure.disposition, failure.reason])).toEqual([
      ['dropped', 'shutdown'],
      ['unknown', 'shutdown'],
    ]);
    expect(logger.lines).toContain('audr: shutdown left 1 record(s) dropped and 1 unknown');

    // The abandoned batch answering late changes nothing: `unknown` is terminal.
    sink.answer(BatchResult.accepted());
    await settle();
    expect(audr.stats).toMatchObject({ sent: 0, unknown: 1, batches: 0 });
  });
});
