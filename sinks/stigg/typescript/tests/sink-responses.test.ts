/**
 * A record may be reported sent only when Stigg said so. Anything else is rejected (Stigg
 * refused it) or unknown (the answer never arrived; a replay is safe because `record_id` is
 * the idempotency key). A failure never relabels a record Stigg already settled.
 */
import { describe, expect, it } from 'vitest';

import {
  EVENT_NAME,
  fakeFetch,
  makeSink,
  record,
  recordingLogger,
  records,
  respond,
} from './helpers.js';

const SECRET_BODY = 'stigg-internal-backtrace-sk-live-12345';

describe('StiggSink responses', () => {
  it.each([
    ['the data envelope', () => respond(202, { data: {} })],
    ['an empty body', () => respond(202)],
    ['a body that is not JSON', () => respond(202, '<html>ok</html>')],
    ['a 200 status', () => respond(200, { data: {} })],
  ])('takes a 202 with %s as full acceptance', async (_name, response) => {
    const batch = records(3);
    const { fetch, calls } = fakeFetch(response);

    expect(await makeSink({ fetch }).deliver(batch)).toEqual({ outcome: 'accepted', rejected: [] });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [413, 'payload_too_large'],
    [404, 'http_404'],
    [422, 'http_422'],
    [301, 'http_301'],
    [302, 'http_302'],
    [307, 'http_307'],
  ])('fails permanently on %i as %s, without a retry', async (status, detail) => {
    const { fetch, calls } = fakeFetch(() =>
      respond(status, SECRET_BODY, { Location: 'https://elsewhere.test' }),
    );

    expect(await makeSink({ fetch }).deliver(records(2))).toEqual({
      outcome: 'permanent_failure',
      detail,
    });
    expect(calls).toHaveLength(1);
  });

  it.each([201, 204])(
    'names every record unknown on %i, without a retry or a later request',
    async (status) => {
      const batch = records(1500);
      // A 204 cannot carry a body.
      const { fetch, calls } = fakeFetch(() =>
        respond(status, status === 204 ? undefined : SECRET_BODY),
      );

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: [],
        unknown: batch.map((entry) => entry.record_id),
      });
      expect(calls).toHaveLength(1);
    },
  );

  it.each([408, 409, 429, 500, 502, 503, 504, 520])(
    'fails retryably on %i once the retry budget is spent',
    async (status) => {
      const { fetch, calls } = fakeFetch(() => respond(status, SECRET_BODY));

      expect(await makeSink({ fetch }).deliver([record()])).toEqual({
        outcome: 'retryable_failure',
        detail: `http_${status}`,
      });
      expect(calls).toHaveLength(3);
    },
  );

  it('follows no redirect, so the key goes to the configured endpoint alone', async () => {
    const { fetch, calls } = fakeFetch(() =>
      respond(307, undefined, { Location: 'https://attacker.example.test/api/v1/events' }),
    );

    await makeSink({ fetch }).deliver([record()]);

    expect(calls.map((call) => call.url)).toEqual(['https://stigg.example.test/api/v1/events']);
  });

  describe('diagnostics', () => {
    it('names the lever for a request that is too large', async () => {
      const logger = recordingLogger();
      const sink = makeSink({ fetch: fakeFetch(() => respond(413)).fetch, logger });

      await sink.deliver(records(7));

      expect(logger.lines).toEqual([
        'warn: audr-sink-stigg: Stigg rejected the request as too large (events=7); lower Client batchMaxSize',
      ]);
    });

    it('logs a rejected key as an error, with the status only', async () => {
      const logger = recordingLogger();
      const sink = makeSink({ fetch: fakeFetch(() => respond(401, SECRET_BODY)).fetch, logger });

      await sink.deliver([record()]);

      expect(logger.lines).toEqual([
        'error: audr-sink-stigg: the API key was rejected (status=401)',
      ]);
    });

    it('logs a forbidden key as an error', async () => {
      const logger = recordingLogger();
      const sink = makeSink({ fetch: fakeFetch(() => respond(403)).fetch, logger });

      await sink.deliver([record()]);

      expect(logger.lines).toEqual([
        'error: audr-sink-stigg: the API key is not permitted to report events (status=403)',
      ]);
    });

    it('logs a success status other than 200 or 202 with the status only', async () => {
      const logger = recordingLogger();
      const sink = makeSink({ fetch: fakeFetch(() => respond(201, SECRET_BODY)).fetch, logger });

      await sink.deliver([record()]);

      expect(logger.lines).toEqual([
        'warn: audr-sink-stigg: Stigg answered without confirming the events; they are unknown (status=201)',
      ]);
    });

    it('logs a permanent rejection and an exhausted retry budget with their status', async () => {
      const logger = recordingLogger();
      await makeSink({ fetch: fakeFetch(() => respond(404)).fetch, logger }).deliver([record()]);
      await makeSink({ fetch: fakeFetch(() => respond(503)).fetch, logger }).deliver([record()]);

      expect(logger.lines).toEqual([
        'warn: audr-sink-stigg: the request was rejected permanently (status=404)',
        'warn: audr-sink-stigg: the request failed after 3 attempt(s) (status=503)',
      ]);
    });

    it('never carries a response body, a record value, an event name or an identifier', async () => {
      const source = record({
        account_id: 'acct_private',
        subscription_id: 'sub_private',
        labels: { note: 'private-label' },
      });
      const logger = recordingLogger();
      const statuses = [400, 401, 403, 413, 422, 500];

      for (const status of statuses) {
        const sink = makeSink({
          fetch: fakeFetch(() => respond(status, { code: 'BadUserInput', message: SECRET_BODY }))
            .fetch,
          logger,
        });
        const result = await sink.deliver([source]);
        logger.lines.push(JSON.stringify(result));
      }

      const output = logger.lines.join('\n');
      for (const forbidden of [
        SECRET_BODY,
        'acct_private',
        'private-label',
        source.record_id,
        'sub_private',
        EVENT_NAME,
      ]) {
        expect(output).not.toContain(forbidden);
      }
    });
  });

  describe('mixed outcomes', () => {
    it('reports records of later requests unknown when one fails after another was accepted', async () => {
      const batch = records(2500);
      const { fetch, calls } = fakeFetch((_call, index) =>
        index === 0 ? respond(202) : respond(503),
      );

      const result = await makeSink({ fetch }).deliver(batch);

      expect(result).toEqual({
        outcome: 'accepted',
        rejected: [],
        unknown: batch.slice(1000).map((entry) => entry.record_id),
      });
      expect(calls).toHaveLength(1 + 3);
    });

    it('does not send later requests once one fails', async () => {
      const { fetch, calls } = fakeFetch((_call, index) =>
        index === 0 ? respond(202) : respond(401),
      );

      await makeSink({ fetch }).deliver(records(3500));

      expect(calls).toHaveLength(2);
    });

    it('fails the whole batch when the first request fails and nothing was settled', async () => {
      const { fetch } = fakeFetch(() => respond(401));

      expect(await makeSink({ fetch }).deliver(records(1500))).toEqual({
        outcome: 'permanent_failure',
        detail: 'auth',
      });
    });

    it('keeps the reason of a refused request when a record was rejected locally', async () => {
      const bad = record({ account_id: undefined });
      const good = records(2);
      const { fetch } = fakeFetch(() => respond(401));

      expect(await makeSink({ fetch }).deliver([bad, ...good])).toEqual({
        outcome: 'accepted',
        rejected: [
          { recordId: bad.record_id, detail: 'missing_customer_id' },
          ...good.map((entry) => ({ recordId: entry.record_id, detail: 'auth' })),
        ],
      });
    });

    it('keeps a local rejection, naming the rest unknown, when the request then fails retryably', async () => {
      const bad = record({ account_id: undefined });
      const good = records(2);
      const { fetch } = fakeFetch(() => respond(503));

      expect(await makeSink({ fetch }).deliver([bad, ...good])).toEqual({
        outcome: 'accepted',
        rejected: [{ recordId: bad.record_id, detail: 'missing_customer_id' }],
        unknown: good.map((entry) => entry.record_id),
      });
    });

    it('never names a record both rejected and unknown', async () => {
      const bad = record({ account_id: undefined });
      const batch = [bad, ...records(1500)];
      const { fetch } = fakeFetch((_call, index) => (index === 0 ? respond(202) : respond(500)));

      const result = await makeSink({ fetch }).deliver(batch);

      expect(result.outcome).toBe('accepted');
      if (result.outcome !== 'accepted') return;
      const rejected = new Set(result.rejected?.map((entry) => entry.recordId));
      expect(result.unknown?.filter((id) => rejected.has(id))).toEqual([]);
      expect(rejected).toEqual(new Set([bad.record_id]));
    });

    it('rejects the records of a refused request without describing confirmed ones as failed', async () => {
      const batch = records(1200);
      const { fetch } = fakeFetch((_call, index) => (index === 0 ? respond(202) : respond(413)));

      const result = await makeSink({ fetch }).deliver(batch);

      expect(result).toEqual({
        outcome: 'accepted',
        rejected: batch.slice(1000).map((entry) => ({
          recordId: entry.record_id,
          detail: 'payload_too_large',
        })),
      });
    });

    it('rejects a refused request and names the requests after it unknown', async () => {
      const batch = records(2500);
      const { fetch } = fakeFetch((_call, index) => (index === 0 ? respond(202) : respond(403)));

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: batch.slice(1000, 2000).map((entry) => ({
          recordId: entry.record_id,
          detail: 'forbidden',
        })),
        unknown: batch.slice(2000).map((entry) => entry.record_id),
      });
    });

    it('names a 2xx request unknown and keeps an earlier accepted one', async () => {
      const batch = records(1500);
      const { fetch } = fakeFetch((_call, index) => (index === 0 ? respond(202) : respond(201)));

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: [],
        unknown: batch.slice(1000).map((entry) => entry.record_id),
      });
    });
  });
});
