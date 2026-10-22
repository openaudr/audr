import { type Attribution, type AudrRecord, type RecordInput } from '@openaudr/audr';
import { makeRecord } from '@openaudr/audr/testing';

import { LagoSink, type LagoSinkOptions } from '../src/index.js';

export const API_URL = 'https://lago.example.test';
export const BATCH_URL = `${API_URL}/api/v1/events/batch`;
export const FEATURE_ID = 'ai_usage';
export const API_KEY = 'test_key';

/** A valid record Lago can route, with `attribution` fields merged in. */
export function record(
  attribution: Partial<Attribution> = {},
  overrides: Partial<RecordInput> = {},
): AudrRecord {
  return makeRecord({
    attribution: {
      environment: 'test',
      subscription_id: 'sub_test',
      feature_id: FEATURE_ID,
      ...attribution,
    },
    ...overrides,
  });
}

/** `count` distinct routable records. */
export function records(count: number): AudrRecord[] {
  return Array.from({ length: count }, () => record());
}

export interface SentEvent {
  readonly transaction_id: string;
  readonly external_subscription_id: string;
  readonly code: string;
  readonly timestamp: string;
  readonly properties: Record<string, string | number>;
}

export interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Readonly<Record<string, string>>;
  /** The exact request body, as sent. */
  readonly text: string;
  readonly events: SentEvent[];
}

/** A `fetch` that records every call and answers through `handler`. */
export function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  // The transport always passes a string URL and a string body.
  const fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const text = init.body as string;
    const call: Call = {
      url: input as string,
      init,
      headers: init.headers as Record<string, string>,
      text,
      events: (JSON.parse(text) as { events: SentEvent[] }).events,
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  };
  return { fetch, calls };
}

/** A `fetch` that never answers and rejects with the abort reason once its signal fires. */
export function hangingFetch(): typeof globalThis.fetch {
  return (_input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason as Error);
      });
    });
}

export function respond(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers });
}

/**
 * A Lago `422` that refuses the events at `errors`' positions, keyed as Lago keys them. An
 * entry is the field codes, or the message Lago gives for a failed metric expression.
 */
export function validation(errors: Record<number, Record<string, string[]> | string>): Response {
  return respond(422, {
    status: 422,
    error: 'Unprocessable Entity',
    code: 'validation_errors',
    error_details: errors,
  });
}

/** The `422` Lago gives a Postgres event store for a `transaction_id` it already holds. */
export function alreadyHeld(...indices: number[]): Response {
  return validation(
    Object.fromEntries(
      indices.map((index) => [index, { transaction_id: ['value_already_exist'] }]),
    ),
  );
}

export function recordingLogger(): {
  warn(m: string): void;
  error(m: string): void;
  lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
  };
}

/** Let pending promise chains run until they block on I/O or a timer. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A sink against `API_URL` that retries without waiting. A `retry` option adds to the
 * zero backoff, so a test that sets only `maxAttempts` still runs instantly.
 */
export function makeSink({ retry, ...options }: LagoSinkOptions = {}): LagoSink {
  return new LagoSink({
    apiUrl: API_URL,
    apiKey: API_KEY,
    logger: recordingLogger(),
    ...options,
    retry: { initialBackoffMs: 0, maxBackoffMs: 0, ...retry },
  });
}
