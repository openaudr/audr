/** Credential resolution and validation of the single endpoint a request may be sent to. */
import process from 'node:process';

import { ConfigurationError } from '@openaudr/audr';

/** Stigg's production API. Every environment shares it; the API key selects the environment. */
export const DEFAULT_API_URL = 'https://api.stigg.io';
export const EVENTS_PATH = '/api/v1/events';

// A path an operator may reasonably write for the same endpoint. Anything else could point
// the API key at a route the sink never meant to call.
const ACCEPTED_PATHS = new Set(['', '/api/v1', EVENTS_PATH]);
// Printable ASCII without whitespace: a value in this range cannot break out of a header.
const API_KEY = /^[\x21-\x7e]+$/;

export interface CredentialOptions {
  /** A Stigg server API key. Always required. Env: `STIGG_API_KEY`. */
  readonly apiKey?: string | undefined;
  /**
   * The Stigg API origin, `/api/v1` or the full events path. Default `https://api.stigg.io`.
   * Env: `STIGG_API_URL`.
   */
  readonly apiUrl?: string | undefined;
  /** Permit an `http:` URL, for a local Stigg API on a trusted network. Default `false`. */
  readonly allowInsecureHttp?: boolean | undefined;
}

export interface Credentials {
  /** The validated events URL; the only destination the key is ever sent to. */
  readonly endpoint: string;
  /** The `X-API-KEY` header value. Never log it. */
  readonly apiKey: string;
}

/** Resolve credentials once, preferring explicit options over the environment. */
export function resolveCredentials(
  options: CredentialOptions,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Credentials> {
  const apiKey = options.apiKey ?? env.STIGG_API_KEY;
  if (apiKey === undefined) {
    throw new ConfigurationError('apiKey is required; provide apiKey or set STIGG_API_KEY');
  }
  const allowInsecureHttp = options.allowInsecureHttp ?? false;
  if (typeof allowInsecureHttp !== 'boolean') {
    throw new ConfigurationError('allowInsecureHttp must be a boolean');
  }
  return Object.freeze({
    endpoint: parseApiUrl(
      options.apiUrl ?? env.STIGG_API_URL ?? DEFAULT_API_URL,
      allowInsecureHttp,
    ),
    apiKey: validateApiKey(apiKey),
  });
}

/**
 * Validate `apiUrl` as written and return the events URL it names.
 *
 * The authority is compared with what `URL` parsed from it, because `URL` silently
 * normalises backslashes, userinfo and default ports; a lenient reading would let a
 * configured value send the API key to a host nobody inspected.
 */
export function parseApiUrl(apiUrl: unknown, allowInsecureHttp = false): string {
  if (typeof apiUrl !== 'string') throw new ConfigurationError('apiUrl must be a string');
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new ConfigurationError('apiUrl must be an absolute URL with a host name');
  }
  if (url.protocol === 'http:') {
    if (!allowInsecureHttp) {
      throw new ConfigurationError(
        'apiUrl must use https; set allowInsecureHttp to use http with a local Stigg API',
      );
    }
  } else if (url.protocol !== 'https:') {
    throw new ConfigurationError('apiUrl scheme must be https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigurationError('apiUrl must not include userinfo');
  }
  if (/[?#]/.test(apiUrl)) {
    throw new ConfigurationError('apiUrl must not include a query string or fragment');
  }

  const [, authority = '', path = ''] = /^[a-z]+:\/\/([^/]*)(.*)$/i.exec(apiUrl) ?? [];
  if (authority.toLowerCase() !== url.host) {
    throw new ConfigurationError(
      'apiUrl must be a plain host name or address with an optional non-default port',
    );
  }
  if (!ACCEPTED_PATHS.has(path.replace(/\/$/, ''))) {
    throw new ConfigurationError(
      `apiUrl path must be empty, /api/v1 or ${EVENTS_PATH}; the sink only calls the events endpoint`,
    );
  }
  return `${url.origin}${EVENTS_PATH}`;
}

function validateApiKey(apiKey: unknown): string {
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new ConfigurationError('apiKey must not be empty; set STIGG_API_KEY');
  }
  if (!API_KEY.test(apiKey)) {
    throw new ConfigurationError('apiKey must contain only printable ASCII without spaces');
  }
  return apiKey;
}
