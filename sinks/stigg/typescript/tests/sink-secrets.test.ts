import { inspect } from 'node:util';

import { ConfigurationError } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { StiggSink } from '../src/index.js';
import {
  API_KEY,
  API_URL,
  EVENT_NAME,
  fakeFetch,
  makeSink,
  record,
  recordingLogger,
  respond,
} from './helpers.js';

/** Fragments that would reveal the credential if any output carried them. */
const SECRETS = [API_KEY, 'X-API-KEY'];

function expectNoSecret(output: string): void {
  for (const secret of SECRETS) expect(output).not.toContain(secret);
}

describe('StiggSink credentials', () => {
  const sink = makeSink();

  it.each([
    ['String()', () => String(sink)],
    ['util.inspect', () => inspect(sink)],
    ['a deep, hidden util.inspect', () => inspect(sink, { depth: 10, showHidden: true })],
    ['JSON.stringify', () => JSON.stringify(sink)],
    ['JSON.stringify of a wrapper', () => JSON.stringify({ sink })],
    ['own property names', () => JSON.stringify(Object.getOwnPropertyNames(sink))],
    ['own symbols', () => JSON.stringify(Object.getOwnPropertySymbols(sink).map(String))],
    ['own property values', () => JSON.stringify(Object.values(sink))],
  ])('does not appear in %s', (_name, render) => {
    expectNoSecret(render());
  });

  it('renders as its endpoint alone', () => {
    expect(String(sink)).toBe(`StiggSink(endpoint=${API_URL}/api/v1/events)`);
    expect(inspect(sink)).toBe(String(sink));
  });

  it('does not appear in a configuration error', () => {
    for (const options of [
      { apiKey: `${API_KEY} with a space` },
      { apiKey: API_KEY, apiUrl: `https://${API_KEY}@host.test` },
      { apiKey: API_KEY, apiUrl: 'ftp://host.test' },
      { apiKey: API_KEY, retry: { maxAttempts: 0 } },
      { apiKey: API_KEY, timeoutMs: -1 },
      { apiKey: API_KEY, eventName: '' },
    ]) {
      let message = '';
      try {
        new StiggSink({ eventName: EVENT_NAME, ...options });
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expectNoSecret(message);
    }
  });

  it('does not appear in a result or a log line, whatever Stigg or the network answers', async () => {
    const logger = recordingLogger();
    const answers: (() => Response)[] = [
      ...[400, 401, 403, 413, 422, 429, 500, 503].map((status) => () => respond(status, API_KEY)),
      () => {
        throw new TypeError(`fetch failed for X-API-KEY: ${API_KEY}`, {
          cause: { code: `X-API-KEY ${API_KEY}`, message: API_KEY },
        });
      },
    ];

    for (const answer of answers) {
      const result = await makeSink({ fetch: fakeFetch(answer).fetch, logger }).deliver([record()]);
      logger.lines.push(JSON.stringify(result));
    }

    expect(logger.lines.length).toBeGreaterThan(answers.length);
    expectNoSecret(logger.lines.join('\n'));
  });

  it('sends the key only in the X-API-KEY header of a request to the endpoint', async () => {
    const { fetch, calls } = fakeFetch(() => respond(202));

    await makeSink({ fetch }).deliver([record()]);

    const [call] = calls;
    expect(call?.url).not.toContain(API_KEY);
    expect(call?.text).not.toContain(API_KEY);
    expect(call?.headers['X-API-KEY']).toBe(API_KEY);
    expect(
      Object.entries(call?.headers ?? {}).filter(([, value]) => value.includes(API_KEY)),
    ).toEqual([['X-API-KEY', API_KEY]]);
  });
});
