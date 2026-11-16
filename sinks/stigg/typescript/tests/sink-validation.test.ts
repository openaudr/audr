/**
 * Stigg validates a request atomically: one invalid event fails the whole request with a
 * `400 BadUserInput` whose message names the offenders by position, and nothing is queued.
 * The sink rejects the events the message names and resends the rest.
 */
import { describe, expect, it } from 'vitest';

import {
  badInput,
  fakeFetch,
  makeSink,
  record,
  recordingLogger,
  records,
  respond,
} from './helpers.js';

const ok = (): Response => respond(202, { data: {} });

const idsOf = (calls: { events: { idempotencyKey: string }[] }[], call: number): string[] =>
  calls[call]?.events.map((event) => event.idempotencyKey) ?? [];

describe('StiggSink 400 handling', () => {
  it('rejects the events the response names and resends the others', async () => {
    const batch = records(5);
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0 ? badInput('events[1].timestamp', 'events[3].customerId') : ok(),
    );

    const result = await makeSink({ fetch }).deliver(batch);

    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [
        { recordId: batch[1]?.record_id, detail: 'bad_user_input:timestamp' },
        { recordId: batch[3]?.record_id, detail: 'bad_user_input:customerId' },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(idsOf(calls, 1)).toEqual([0, 2, 4].map((i) => batch[i]?.record_id));
  });

  it('resends each surviving event exactly as it first went out', async () => {
    const batch = records(4);
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0 ? badInput('events[0].dimensions') : ok(),
    );

    await makeSink({ fetch }).deliver(batch);

    const first = calls[0]?.events.slice(1).map((event) => JSON.stringify(event));
    const second = calls[1]?.events.map((event) => JSON.stringify(event));
    expect(second).toEqual(first);
  });

  it('answers a batch in which every event is invalid without a second request', async () => {
    const batch = records(3);
    const { fetch, calls } = fakeFetch(() =>
      badInput('events[0].eventName', 'events[1].timestamp', 'events[2].eventName'),
    );

    expect(await makeSink({ fetch }).deliver(batch)).toEqual({
      outcome: 'accepted',
      rejected: [
        { recordId: batch[0]?.record_id, detail: 'bad_user_input:eventName' },
        { recordId: batch[1]?.record_id, detail: 'bad_user_input:timestamp' },
        { recordId: batch[2]?.record_id, detail: 'bad_user_input:eventName' },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it('names an unlisted field only by a fixed fallback', async () => {
    const batch = records(2);
    const { fetch } = fakeFetch((_call, index) =>
      index === 0 ? badInput('events[1].sk-live-secret') : ok(),
    );

    expect(await makeSink({ fetch }).deliver(batch)).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: batch[1]?.record_id, detail: 'bad_user_input' }],
    });
  });

  it('logs each salvage pass with counts only', async () => {
    const logger = recordingLogger();
    const { fetch } = fakeFetch((_call, index) =>
      index === 0 ? badInput('events[0].customerId') : ok(),
    );

    await makeSink({ fetch, logger }).deliver(records(3));

    expect(logger.lines).toEqual([
      'warn: audr-sink-stigg: Stigg refused 1 event(s) (events=3, pass=1)',
    ]);
  });

  describe('a body that cannot be matched to the request', () => {
    it.each([
      ['a position beyond the request', () => badInput('events[7].customerId')],
      ['no position at all', () => badInput('events')],
      [
        'a refusal that names no event, such as a reserved name',
        () =>
          respond(400, {
            code: 'InvalidArgument',
            message: 'Event name $usage.reported is reserved and cannot be used',
          }),
      ],
      ['a body that is not JSON', () => respond(400, '<html>nope</html>')],
      ['an empty body', () => respond(400)],
      ['a null body', () => respond(400, 'null')],
    ])('fails the request permanently for %s', async (_name, response) => {
      const { fetch, calls } = fakeFetch(response);

      expect(await makeSink({ fetch }).deliver(records(3))).toEqual({
        outcome: 'permanent_failure',
        detail: 'bad_user_input',
      });
      expect(calls).toHaveLength(1);
    });

    it('fails permanently for a body that errors while it is read', async () => {
      const body = new ReadableStream({
        pull(controller) {
          controller.error(new Error('connection reset'));
        },
      });
      const { fetch } = fakeFetch(() => new Response(body, { status: 400 }));

      expect(await makeSink({ fetch }).deliver([record()])).toEqual({
        outcome: 'permanent_failure',
        detail: 'bad_user_input',
      });
    });

    it('logs the failure without the body', async () => {
      const logger = recordingLogger();
      const sink = makeSink({
        fetch: fakeFetch(() => respond(400, { code: 'BadUserInput', message: 'sk-live-secret' }))
          .fetch,
        logger,
      });

      await sink.deliver(records(2));

      expect(logger.lines).toEqual([
        'warn: audr-sink-stigg: the validation response could not be matched to the request (events=2, passes=0)',
      ]);
    });

    it('keeps an earlier rejection and rejects the rest when a later 400 does not match', async () => {
      const batch = records(3);
      const { fetch } = fakeFetch((_call, index) =>
        index === 0 ? badInput('events[0].timestamp') : badInput('events[9].timestamp'),
      );

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: [
          { recordId: batch[0]?.record_id, detail: 'bad_user_input:timestamp' },
          { recordId: batch[1]?.record_id, detail: 'bad_user_input' },
          { recordId: batch[2]?.record_id, detail: 'bad_user_input' },
        ],
      });
    });
  });

  describe('bounded salvage', () => {
    it('gives up on the fourth 400 for one request, having removed an event each pass', async () => {
      const batch = records(6);
      const logger = recordingLogger();
      const { fetch, calls } = fakeFetch(() => badInput('events[0].customerId'));

      const result = await makeSink({ fetch, logger }).deliver(batch);

      expect(calls.map((call) => call.events.length)).toEqual([6, 5, 4, 3]);
      expect(result).toEqual({
        outcome: 'accepted',
        rejected: [0, 1, 2].map((i) => ({
          recordId: batch[i]?.record_id,
          detail: 'bad_user_input:customerId',
        })),
        unknown: [3, 4, 5].map((i) => batch[i]?.record_id),
      });
      expect(logger.lines.at(-1)).toBe(
        'warn: audr-sink-stigg: Stigg refused the request again after 3 resend(s); ' +
          'its remaining events are unknown (events=3)',
      );
    });

    it('settles a request that needs exactly three passes', async () => {
      const batch = records(5);
      const { fetch, calls } = fakeFetch((_call, index) =>
        index < 3 ? badInput('events[0].customerId') : ok(),
      );

      const result = await makeSink({ fetch }).deliver(batch);

      expect(calls.map((call) => call.events.length)).toEqual([5, 4, 3, 2]);
      expect(result).toMatchObject({ outcome: 'accepted' });
      expect(result).not.toHaveProperty('unknown');
      expect(result).toHaveProperty('rejected.length', 3);
    });

    it("does not carry a request's retry budget into its resend", async () => {
      const batch = records(3);
      const { fetch, calls } = fakeFetch((_call, index) => {
        if (index === 0) return badInput('events[0].timestamp');
        return index < 3 ? respond(503) : ok();
      });

      const result = await makeSink({ fetch }).deliver(batch);

      expect(calls).toHaveLength(4);
      expect(calls[1]?.text).toBe(calls[2]?.text);
      expect(calls[2]?.text).toBe(calls[3]?.text);
      expect(result).toEqual({
        outcome: 'accepted',
        rejected: [{ recordId: batch[0]?.record_id, detail: 'bad_user_input:timestamp' }],
      });
    });

    it('stops with the survivors unknown when a resend then fails', async () => {
      const batch = records(4);
      const { fetch } = fakeFetch((_call, index) =>
        index === 0 ? badInput('events[1].timestamp') : respond(503),
      );

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: [{ recordId: batch[1]?.record_id, detail: 'bad_user_input:timestamp' }],
        unknown: [0, 2, 3].map((i) => batch[i]?.record_id),
      });
    });
  });

  describe('across requests', () => {
    it('salvages the first request and sends the second', async () => {
      const batch = records(1500);
      const { fetch, calls } = fakeFetch((_call, index) =>
        index === 0 ? badInput('events[5].customerId') : ok(),
      );

      const result = await makeSink({ fetch }).deliver(batch);

      expect(calls.map((call) => call.events.length)).toEqual([1000, 999, 500]);
      expect(result).toEqual({
        outcome: 'accepted',
        rejected: [{ recordId: batch[5]?.record_id, detail: 'bad_user_input:customerId' }],
      });
    });

    it('keeps the first request accepted and rejects the second when it cannot be matched', async () => {
      const batch = records(1500);
      const { fetch } = fakeFetch((_call, index) => (index === 0 ? ok() : respond(400, 'junk')));

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: batch.slice(1000).map((entry) => ({
          recordId: entry.record_id,
          detail: 'bad_user_input',
        })),
      });
    });
  });
});
