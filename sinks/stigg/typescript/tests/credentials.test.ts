import { ConfigurationError } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { parseApiUrl, resolveCredentials } from '../src/credentials.js';

const EVENTS = '/api/v1/events';
const MINIMAL = { apiKey: 'key_1' };

describe('resolveCredentials', () => {
  it('defaults to the Stigg API', () => {
    expect(resolveCredentials(MINIMAL, {}).endpoint).toBe(`https://api.stigg.io${EVENTS}`);
  });

  it('keeps the key as given, for the X-API-KEY header', () => {
    expect(resolveCredentials(MINIMAL, {})).toMatchObject({ apiKey: 'key_1' });
  });

  it('reads every setting from the environment', () => {
    const credentials = resolveCredentials(
      {},
      {
        STIGG_API_KEY: 'env_key',
        STIGG_API_URL: 'https://stigg.internal.example.test',
      },
    );

    expect(credentials).toEqual({
      endpoint: `https://stigg.internal.example.test${EVENTS}`,
      apiKey: 'env_key',
    });
  });

  it('prefers explicit options over the environment', () => {
    const credentials = resolveCredentials(
      { apiKey: 'opt_key', apiUrl: 'https://a.example.test' },
      { STIGG_API_KEY: 'env_key', STIGG_API_URL: 'https://b.example.test' },
    );

    expect(credentials).toEqual({
      endpoint: `https://a.example.test${EVENTS}`,
      apiKey: 'opt_key',
    });
  });

  it('returns frozen credentials', () => {
    expect(Object.isFrozen(resolveCredentials(MINIMAL, {}))).toBe(true);
  });

  it('names what is missing without a value', () => {
    expect(() => resolveCredentials({}, {})).toThrow(
      'apiKey is required; provide apiKey or set STIGG_API_KEY',
    );
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

  it('rejects a blank environment value instead of treating it as missing', () => {
    expect(() => resolveCredentials(MINIMAL, { STIGG_API_URL: '' })).toThrow(ConfigurationError);
    expect(() => resolveCredentials({}, { STIGG_API_KEY: '' })).toThrow('apiKey must not be empty');
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
    'https://stigg.example.test',
    'https://stigg.example.test/',
    'https://stigg.example.test/api/v1',
    'https://stigg.example.test/api/v1/',
    `https://stigg.example.test${EVENTS}`,
    `https://stigg.example.test${EVENTS}/`,
    'HTTPS://STIGG.EXAMPLE.TEST',
  ])('normalises %s to the one events endpoint', (apiUrl) => {
    expect(parseApiUrl(apiUrl)).toBe(`https://stigg.example.test${EVENTS}`);
  });

  it('keeps an explicit port', () => {
    expect(parseApiUrl('https://stigg.internal:8443/api/v1')).toBe(
      `https://stigg.internal:8443${EVENTS}`,
    );
  });

  it.each([
    ['http://localhost:3000', `http://localhost:3000${EVENTS}`],
    ['http://stigg-api:3000/api/v1', `http://stigg-api:3000${EVENTS}`],
    ['http://127.0.0.1:3000', `http://127.0.0.1:3000${EVENTS}`],
    ['http://[::1]:3000', `http://[::1]:3000${EVENTS}`],
  ])('accepts %s over http only when opted in', (apiUrl, endpoint) => {
    expect(() => parseApiUrl(apiUrl)).toThrow('allowInsecureHttp');
    expect(parseApiUrl(apiUrl, true)).toBe(endpoint);
  });

  it('still requires https for a remote host unless opted in', () => {
    expect(() => parseApiUrl('http://api.stigg.io')).toThrow(ConfigurationError);
  });

  it.each([
    ['a non-string', 42],
    ['no scheme', 'stigg.example.test'],
    ['a scheme without slashes, which URL reads leniently', 'https:stigg.example.test'],
    ['a scheme with one slash, which URL reads leniently', 'https:/stigg.example.test'],
    ['an empty string', ''],
    ['an unsupported scheme', 'ftp://stigg.example.test'],
    ['userinfo', 'https://user:pass@stigg.example.test'],
    ['a username only', 'https://user@stigg.example.test'],
    ['an empty userinfo', 'https://@stigg.example.test'],
    ['a query string', 'https://stigg.example.test?x=1'],
    ['an empty query string', 'https://stigg.example.test/api/v1?'],
    ['a fragment', 'https://stigg.example.test#frag'],
    ['an unrelated path', 'https://stigg.example.test/events'],
    ['another API version', 'https://stigg.example.test/api/v2'],
    ['a sibling endpoint', 'https://stigg.example.test/api/v2/usage'],
    ['a sub-route of the endpoint', 'https://stigg.example.test/api/v1/events/estimate'],
    ['a dot segment', 'https://stigg.example.test/api/v1/../x'],
    ['a doubled slash', 'https://stigg.example.test/api/v1//'],
    ['an encoded dot segment', 'https://stigg.example.test/api/v1/%2e%2e/x'],
    ['a default port', 'https://stigg.example.test:443'],
    ['a backslash that hides a host', 'https://evil.example.test\\@stigg.example.test'],
    ['a backslash after the host', 'https://stigg.example.test\\.evil.example.test'],
    ['a tab inside the host', 'https://stigg\t.example.test'],
    ['a newline inside the host', 'https://stigg.example.test\n'],
    ['an internationalised host', 'https://b\u00fccher.example.test'],
  ] as const)('rejects %s', (_name, apiUrl) => {
    expect(() => parseApiUrl(apiUrl, true)).toThrow(ConfigurationError);
  });
});
