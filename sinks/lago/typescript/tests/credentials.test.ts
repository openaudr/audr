import { ConfigurationError } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { parseApiUrl, resolveCredentials } from '../src/credentials.js';
import { preflight } from '../src/preflight.js';
import { record } from './helpers.js';

const BATCH = '/api/v1/events/batch';
const MINIMAL = { apiKey: 'key_1', metricCode: 'tokens' };

describe('resolveCredentials', () => {
  it('defaults to Lago Cloud in the US region', () => {
    expect(resolveCredentials(MINIMAL, {}).endpoint).toBe(`https://api.getlago.com${BATCH}`);
  });

  it('sends the key as a Bearer token and keeps the metric code verbatim', () => {
    expect(resolveCredentials(MINIMAL, {})).toMatchObject({
      authorization: 'Bearer key_1',
      metricCode: 'tokens',
    });
  });

  it('reads every setting from the environment', () => {
    const credentials = resolveCredentials(
      {},
      {
        LAGO_API_KEY: 'env_key',
        LAGO_API_URL: 'https://api.eu.getlago.com',
        LAGO_METRIC_CODE: 'env_metric',
      },
    );

    expect(credentials).toEqual({
      endpoint: `https://api.eu.getlago.com${BATCH}`,
      authorization: 'Bearer env_key',
      metricCode: 'env_metric',
    });
  });

  it('prefers explicit options over the environment', () => {
    const credentials = resolveCredentials(
      { apiKey: 'opt_key', apiUrl: 'https://a.example.test', metricCode: 'opt_metric' },
      {
        LAGO_API_KEY: 'env_key',
        LAGO_API_URL: 'https://b.example.test',
        LAGO_METRIC_CODE: 'env_metric',
      },
    );

    expect(credentials).toEqual({
      endpoint: `https://a.example.test${BATCH}`,
      authorization: 'Bearer opt_key',
      metricCode: 'opt_metric',
    });
  });

  it('returns frozen credentials', () => {
    expect(Object.isFrozen(resolveCredentials(MINIMAL, {}))).toBe(true);
  });

  it('names what is missing without a value', () => {
    expect(() => resolveCredentials({ metricCode: 'm' }, {})).toThrow(
      'apiKey is required; provide apiKey or set LAGO_API_KEY',
    );
  });

  it('bills each event against the record feature_id when no metricCode is set', () => {
    const { metricCode } = resolveCredentials({ apiKey: 'k' }, {});
    const named = record({ feature_id: 'support-chat' });
    const unnamed = record({});

    const { events, rejected } = preflight([named, unnamed], metricCode);

    expect(events.map((event) => event.code)).toEqual(['support-chat']);
    expect(rejected).toEqual([{ recordId: unnamed.record_id, detail: 'missing_metric_code' }]);
  });

  it.each(['', ' ', 'two words', 'tab\tkey', 'new\nline', 'caf\u00e9'])(
    'rejects the apiKey %j',
    (apiKey) => {
      expect(() => resolveCredentials({ ...MINIMAL, apiKey }, {})).toThrow(ConfigurationError);
    },
  );

  it('rejects an apiKey of the wrong type', () => {
    expect(() => resolveCredentials({ ...MINIMAL, apiKey: 42 as unknown as string }, {})).toThrow(
      ConfigurationError,
    );
  });

  it.each(['', '   ', ' tokens', 'tokens ', 'tokens\n'])(
    'rejects the metricCode %j',
    (metricCode) => {
      expect(() => resolveCredentials({ ...MINIMAL, metricCode }, {})).toThrow(ConfigurationError);
    },
  );

  it('keeps a function that chooses the metric code per record', () => {
    const choose = (): string => 'tokens';

    expect(resolveCredentials({ ...MINIMAL, metricCode: choose }, {}).metricCode).toBe(choose);
  });

  it('prefers a metric code function over LAGO_METRIC_CODE', () => {
    const choose = (): string => 'tokens';

    expect(
      resolveCredentials({ ...MINIMAL, metricCode: choose }, { LAGO_METRIC_CODE: 'env_metric' })
        .metricCode,
    ).toBe(choose);
  });

  it.each([42, true, {}])(
    'rejects the metricCode %j, which is neither a string nor a function',
    (metricCode) => {
      expect(() =>
        resolveCredentials({ ...MINIMAL, metricCode: metricCode as unknown as string }, {}),
      ).toThrow('metricCode must be a non-empty string or a function; set LAGO_METRIC_CODE');
    },
  );

  it('rejects a blank environment value instead of treating it as missing', () => {
    expect(() => resolveCredentials(MINIMAL, { LAGO_API_URL: '' })).toThrow(ConfigurationError);
    expect(() => resolveCredentials({ metricCode: 'm' }, { LAGO_API_KEY: '' })).toThrow(
      'apiKey must not be empty',
    );
  });

  it('requires allowInsecureHttp to be a boolean', () => {
    expect(() =>
      resolveCredentials({ ...MINIMAL, allowInsecureHttp: 'yes' as unknown as boolean }, {}),
    ).toThrow('allowInsecureHttp must be a boolean');
  });

  it('never puts the key in an error message', () => {
    const apiKey = 'secret key with spaces';
    let message = '';
    try {
      resolveCredentials({ ...MINIMAL, apiKey }, {});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('apiKey');
    expect(message).not.toContain('secret');
  });
});

describe('parseApiUrl', () => {
  it.each([
    'https://lago.example.test',
    'https://lago.example.test/',
    'https://lago.example.test/api/v1',
    'https://lago.example.test/api/v1/',
    `https://lago.example.test${BATCH}`,
    `https://lago.example.test${BATCH}/`,
    'HTTPS://LAGO.EXAMPLE.TEST',
  ])('normalises %s to the one batch endpoint', (apiUrl) => {
    expect(parseApiUrl(apiUrl)).toBe(`https://lago.example.test${BATCH}`);
  });

  it('keeps an explicit port', () => {
    expect(parseApiUrl('https://lago.internal:8443/api/v1')).toBe(
      `https://lago.internal:8443${BATCH}`,
    );
  });

  it.each([
    ['http://localhost:3000', `http://localhost:3000${BATCH}`],
    ['http://lago-api:3000/api/v1', `http://lago-api:3000${BATCH}`],
    ['http://127.0.0.1:3000', `http://127.0.0.1:3000${BATCH}`],
    ['http://[::1]:3000', `http://[::1]:3000${BATCH}`],
  ])('accepts %s over http only when opted in', (apiUrl, endpoint) => {
    expect(() => parseApiUrl(apiUrl)).toThrow('allowInsecureHttp');
    expect(parseApiUrl(apiUrl, true)).toBe(endpoint);
  });

  it('still requires https for a remote host unless opted in', () => {
    expect(() => parseApiUrl('http://api.getlago.com')).toThrow(ConfigurationError);
  });

  it.each([
    ['a non-string', 42],
    ['no scheme', 'lago.example.test'],
    ['a scheme without slashes, which URL reads leniently', 'https:lago.example.test'],
    ['a scheme with one slash, which URL reads leniently', 'https:/lago.example.test'],
    ['an empty string', ''],
    ['an unsupported scheme', 'ftp://lago.example.test'],
    ['userinfo', 'https://user:pass@lago.example.test'],
    ['a username only', 'https://user@lago.example.test'],
    ['an empty userinfo', 'https://@lago.example.test'],
    ['a query string', 'https://lago.example.test?x=1'],
    ['an empty query string', 'https://lago.example.test/api/v1?'],
    ['a fragment', 'https://lago.example.test#frag'],
    ['an unrelated path', 'https://lago.example.test/events'],
    ['another API version', 'https://lago.example.test/api/v2'],
    ['a sibling endpoint', 'https://lago.example.test/api/v1/events'],
    ['a dot segment', 'https://lago.example.test/api/v1/../x'],
    ['a doubled slash', 'https://lago.example.test/api/v1//'],
    ['an encoded dot segment', 'https://lago.example.test/api/v1/%2e%2e/x'],
    ['a default port', 'https://lago.example.test:443'],
    ['a backslash that hides a host', 'https://evil.example.test\\@lago.example.test'],
    ['a backslash after the host', 'https://lago.example.test\\.evil.example.test'],
    ['a tab inside the host', 'https://lago\t.example.test'],
    ['a newline inside the host', 'https://lago.example.test\n'],
    ['an internationalised host', 'https://b\u00fccher.example.test'],
  ] as const)('rejects %s', (_name, apiUrl) => {
    expect(() => parseApiUrl(apiUrl, true)).toThrow(ConfigurationError);
  });
});
