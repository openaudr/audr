import { assertSinkContract } from '@openaudr/audr/testing';
import { describe, expect, it, vi } from 'vitest';

import { LagoSink } from '../src/index.js';
import {
  API_KEY,
  API_URL,
  fakeFetch,
  hangingFetch,
  makeSink,
  record,
  recordingLogger,
  records,
  respond,
  settle,
  validation,
} from './helpers.js';

const ok = (): Response => respond(200);

/** A response that fails when the sink reads its status, as a defect in the sink would. */
function brokenResponse(): Response {
  return Object.defineProperty(respond(200), 'status', {
    get: (): number => {
      throw new TypeError('unexpected');
    },
  });
}

describe('LagoSink lifecycle', () => {
  it('satisfies the sink contract', async () => {
    // Records carry a subscription_id, so they are really sent.
    const sink = makeSink({ fetch: fakeFetch(ok).fetch });

    await assertSinkContract(sink, { records: [record(), record(), record()] });
  });

  it('satisfies the sink contract with the default records, which have no subscription', async () => {
    await assertSinkContract(makeSink({ fetch: fakeFetch(ok).fetch }));
  });

  it('is terminal and idempotent once closed', async () => {
    const { fetch, calls } = fakeFetch(ok);
    const sink = makeSink({ fetch });
    await sink.deliver([record()]);

    await sink.close();
    await sink.close();

    expect(await sink.deliver([record()])).toEqual({ outcome: 'closed' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a batch of unusable records once closed', async () => {
    const sink = makeSink({ fetch: fakeFetch(ok).fetch });
    await sink.close();

    expect(await sink.deliver([record({ subscription_id: undefined })])).toEqual({
      outcome: 'closed',
    });
  });

  it('reports closed, not a transport failure, when closed mid-request', async () => {
    const logger = recordingLogger();
    const sink = makeSink({ fetch: hangingFetch(), logger });
    const pending = sink.deliver([record()]);
    await settle();

    await sink.close();

    expect(await pending).toEqual({ outcome: 'closed' });
    expect(logger.lines).toEqual(['warn: audr-sink-lago: the sink is closed; batch not delivered']);
  });

  it('stops waiting for a retry when closed during the backoff', async () => {
    const { fetch, calls } = fakeFetch(() => respond(503, undefined, { 'Retry-After': '60' }));
    const sink = makeSink({ fetch, retry: { maxBackoffMs: 60_000 } });
    const pending = sink.deliver([record()]);
    await settle();

    await sink.close();

    expect(await pending).toEqual({ outcome: 'closed' });
    expect(calls).toHaveLength(1);
  });

  it('keeps what an earlier request settled when closed during a later one', async () => {
    const batch = records(150);
    const answering = fakeFetch(ok).fetch;
    const hanging = hangingFetch();
    let requests = 0;
    const sink = makeSink({
      fetch: (input, init) => (requests++ === 0 ? answering(input, init) : hanging(input, init)),
    });
    const pending = sink.deliver(batch);
    await settle();

    await sink.close();

    expect(await pending).toEqual({
      outcome: 'accepted',
      rejected: [],
      unknown: batch.slice(100).map((entry) => entry.record_id),
    });
  });

  it('refuses to start another request once closed between requests', async () => {
    const batch = records(250);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetch, calls } = fakeFetch(async (_call, index) => {
      if (index === 0) await gate;
      return ok();
    });
    const sink = makeSink({ fetch });
    const pending = sink.deliver(batch);
    await settle();

    const closing = sink.close();
    release();
    await closing;

    expect(await pending).toEqual({
      outcome: 'accepted',
      rejected: [],
      unknown: batch.slice(100).map((entry) => entry.record_id),
    });
    expect(calls).toHaveLength(1);
  });

  it('reports closed when the sink closes while a validation body is being read', async () => {
    let fail!: (reason: Error) => void;
    const body = new ReadableStream({
      start(controller) {
        fail = (reason) => {
          controller.error(reason);
        };
      },
    });
    const sink = makeSink({ fetch: fakeFetch(() => new Response(body, { status: 422 })).fetch });
    const pending = sink.deliver([record()]);
    await settle();

    await sink.close();
    fail(new Error('aborted'));

    expect(await pending).toEqual({ outcome: 'closed' });
  });

  describe('caller abort', () => {
    it('stops promptly, names the records unknown and leaves the sink open', async () => {
      const batch = records(3);
      let hang = true;
      const hanging = hangingFetch();
      const sink = makeSink({
        fetch: (input, init) => (hang ? hanging(input, init) : Promise.resolve(ok())),
      });
      const abort = new AbortController();
      const pending = sink.deliver(batch, { signal: abort.signal });
      await settle();

      abort.abort();

      expect(await pending).toEqual({
        outcome: 'accepted',
        rejected: [],
        unknown: batch.map((entry) => entry.record_id),
      });
      hang = false;
      expect(await sink.deliver([record()])).toEqual({ outcome: 'accepted', rejected: [] });
    });

    it('sends nothing for a signal that has already aborted', async () => {
      const batch = records(2);
      const { fetch, calls } = fakeFetch(ok);

      const result = await makeSink({ fetch }).deliver(batch, { signal: AbortSignal.abort() });

      expect(calls).toHaveLength(0);
      expect(result).toEqual({
        outcome: 'accepted',
        rejected: [],
        unknown: batch.map((entry) => entry.record_id),
      });
    });

    it('stops waiting for a retry', async () => {
      const batch = records(2);
      const { fetch, calls } = fakeFetch(() => respond(503, undefined, { 'Retry-After': '60' }));
      const sink = makeSink({ fetch, retry: { maxBackoffMs: 60_000 } });
      const abort = new AbortController();
      const pending = sink.deliver(batch, { signal: abort.signal });
      await settle();

      abort.abort();

      expect(await pending).toEqual({
        outcome: 'accepted',
        rejected: [],
        unknown: batch.map((entry) => entry.record_id),
      });
      expect(calls).toHaveLength(1);
    });

    it('keeps local rejections and confirmed requests, naming only the rest unknown', async () => {
      const bad = record({ subscription_id: undefined });
      const batch = records(150);
      const abort = new AbortController();
      const { fetch, calls } = fakeFetch((_call, index) => {
        if (index === 0) abort.abort();
        return ok();
      });

      const result = await makeSink({ fetch }).deliver([bad, ...batch], { signal: abort.signal });

      expect(calls).toHaveLength(1);
      expect(result).toEqual({
        outcome: 'accepted',
        rejected: [{ recordId: bad.record_id, detail: 'missing_subscription_id' }],
        unknown: batch.slice(100).map((entry) => entry.record_id),
      });
    });

    it('logs the abort without a record value', async () => {
      const logger = recordingLogger();
      const sink = makeSink({ fetch: fakeFetch(ok).fetch, logger });

      await sink.deliver(records(2), { signal: AbortSignal.abort() });

      expect(logger.lines).toEqual(['warn: audr-sink-lago: delivery was aborted by the caller']);
    });
  });

  describe('failures', () => {
    it('reports an unexpected error as a permanent failure and names only its class', async () => {
      const logger = recordingLogger();
      const sink = makeSink({ logger });

      const result = await sink.deliver(null as never);

      expect(result).toEqual({ outcome: 'permanent_failure', detail: 'internal_error' });
      expect(logger.lines).toEqual([
        'error: audr-sink-lago: delivery failed unexpectedly (TypeError)',
      ]);
    });

    describe('when an unexpected error occurs while sending', () => {
      const UNEXPECTED = 'error: audr-sink-lago: delivery failed unexpectedly (TypeError)';

      it('keeps what earlier requests confirmed and reports the rest unknown', async () => {
        const batch = records(250);
        const logger = recordingLogger();
        const { fetch, calls } = fakeFetch((_call, index) =>
          index === 0 ? ok() : brokenResponse(),
        );

        const result = await makeSink({ fetch, logger }).deliver(batch);

        expect(calls).toHaveLength(2);
        expect(result).toEqual({
          outcome: 'accepted',
          rejected: [],
          unknown: batch.slice(100).map((entry) => entry.record_id),
        });
        expect(logger.lines).toEqual([UNEXPECTED]);
      });

      it('keeps the outcomes a 422 settled and reports only the resend unknown', async () => {
        const batch = records(4);
        const logger = recordingLogger();
        const { fetch } = fakeFetch((_call, index) =>
          index === 0
            ? validation({
                0: { timestamp: ['invalid_format'] },
                1: { transaction_id: ['value_already_exist'] },
              })
            : brokenResponse(),
        );

        const result = await makeSink({ fetch, logger }).deliver(batch);

        expect(result).toEqual({
          outcome: 'accepted',
          rejected: [{ recordId: batch[0]?.record_id, detail: 'timestamp:invalid_format' }],
          unknown: [batch[2]?.record_id, batch[3]?.record_id],
        });
        expect(logger.lines).toContain(UNEXPECTED);
      });

      it('keeps a record rejected locally and reports the rest unknown', async () => {
        const bad = record({ subscription_id: undefined });
        const batch = records(2);
        const { fetch } = fakeFetch(brokenResponse);

        const result = await makeSink({ fetch }).deliver([bad, ...batch]);

        expect(result).toEqual({
          outcome: 'accepted',
          rejected: [{ recordId: bad.record_id, detail: 'missing_subscription_id' }],
          unknown: batch.map((entry) => entry.record_id),
        });
      });

      it('is a permanent failure when no record had an outcome yet', async () => {
        const logger = recordingLogger();
        const { fetch } = fakeFetch(brokenResponse);

        const result = await makeSink({ fetch, logger }).deliver(records(3));

        expect(result).toEqual({ outcome: 'permanent_failure', detail: 'internal_error' });
        expect(logger.lines).toEqual([UNEXPECTED]);
      });
    });

    it('is not disturbed by a logger that throws', async () => {
      const logger = {
        warn: vi.fn(() => {
          throw new Error('warn failed');
        }),
        error: vi.fn(() => {
          throw new Error('error failed');
        }),
      };

      const rejected = makeSink({ fetch: fakeFetch(() => respond(401)).fetch, logger });
      const tooLarge = makeSink({ fetch: fakeFetch(() => respond(413)).fetch, logger });

      expect(await rejected.deliver([record()])).toEqual({
        outcome: 'permanent_failure',
        detail: 'auth',
      });
      expect(await tooLarge.deliver([record()])).toEqual({
        outcome: 'permanent_failure',
        detail: 'payload_too_large',
      });
      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('logs nothing without a logger', async () => {
      const spies = [vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
      const sink = new LagoSink({
        apiUrl: API_URL,
        apiKey: API_KEY,
        fetch: fakeFetch(() => respond(401)).fetch,
      });

      await sink.deliver([record()]);
      await sink.close();

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('sends through the global fetch by default, which tests block', async () => {
      const sink = new LagoSink({
        apiUrl: API_URL,
        apiKey: API_KEY,
        retry: { maxAttempts: 1 },
      });

      expect(await sink.deliver([record()])).toEqual({
        outcome: 'retryable_failure',
        detail: 'LiveNetworkBlocked',
      });
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
  });
});
