/** Credential resolution and validation of the single endpoint a request may be sent to. */
import process from 'node:process';

import { type AudrRecord, ConfigurationError } from '@openaudr/audr';

import { isMetricCode } from './event.js';

/** Lago Cloud, US region. */
export const DEFAULT_API_URL = 'https://api.getlago.com';
export const BATCH_PATH = '/api/v1/events/batch';

// A path an operator may reasonably write for the same endpoint. Anything else could point
// the API key at a route the sink never meant to call.
const ACCEPTED_PATHS = new Set(['', '/api/v1', BATCH_PATH]);
// Printable ASCII without whitespace: a value in this range cannot break out of a header.
const API_KEY = /^[\x21-\x7e]+$/;

/**
 * The billable metric `code` of every event, or a function that chooses one per record. The
 * function must depend only on the record: a replay that chose another code would be a
 * second billable event on a ClickHouse event store. `undefined` leaves the record unsent.
 */
export type MetricCode = string | ((record: AudrRecord) => string | undefined);

/** The default: the host names the feature on the record, and the feature is the metric. */
const featureId = (record: AudrRecord): string | undefined => record.attribution.feature_id;

export interface CredentialOptions {
  /** Always required. Env: `LAGO_API_KEY`. */
  readonly apiKey?: string | undefined;
  /**
   * The Lago API origin, `/api/v1` or the full batch path. Default `https://api.getlago.com`.
   * Env: `LAGO_API_URL`.
   */
  readonly apiUrl?: string | undefined;
  /**
   * Default: the record's `attribution.feature_id`. Env: `LAGO_METRIC_CODE`, which can only
   * name one code.
   */
  readonly metricCode?: MetricCode | undefined;
  /** Permit an `http:` URL, for a self-hosted Lago on a trusted network. Default `false`. */
  readonly allowInsecureHttp?: boolean | undefined;
}

export interface Credentials {
  /** The validated batch URL; the only destination the key is ever sent to. */
  readonly endpoint: string;
  /** The HTTP `Authorization` header value. Never log it. */
  readonly authorization: string;
  readonly metricCode: MetricCode;
}

/** Resolve credentials once, preferring explicit options over the environment. */
export function resolveCredentials(
  options: CredentialOptions,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Credentials> {
  const apiKey = options.apiKey ?? env.LAGO_API_KEY;
  if (apiKey === undefined) {
    throw new ConfigurationError('apiKey is required; provide apiKey or set LAGO_API_KEY');
  }
  const metricCode = options.metricCode ?? env.LAGO_METRIC_CODE ?? featureId;
  const allowInsecureHttp = options.allowInsecureHttp ?? false;
  if (typeof allowInsecureHttp !== 'boolean') {
    throw new ConfigurationError('allowInsecureHttp must be a boolean');
  }
  return Object.freeze({
    endpoint: parseApiUrl(options.apiUrl ?? env.LAGO_API_URL ?? DEFAULT_API_URL, allowInsecureHttp),
    authorization: bearerAuthorization(apiKey),
    metricCode: validMetricCode(metricCode),
  });
}

/**
 * Validate `apiUrl` as written and return the batch URL it names.
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
        'apiUrl must use https; set allowInsecureHttp to use http with a self-hosted Lago',
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
      `apiUrl path must be empty, /api/v1 or ${BATCH_PATH}; the sink only calls the batch endpoint`,
    );
  }
  return `${url.origin}${BATCH_PATH}`;
}

function bearerAuthorization(apiKey: unknown): string {
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new ConfigurationError('apiKey must not be empty; set LAGO_API_KEY');
  }
  if (!API_KEY.test(apiKey)) {
    throw new ConfigurationError('apiKey must contain only printable ASCII without spaces');
  }
  return `Bearer ${apiKey}`;
}

function validMetricCode(metricCode: unknown): MetricCode {
  if (typeof metricCode === 'function') return metricCode as MetricCode;
  if (isMetricCode(metricCode)) return metricCode;
  if (typeof metricCode !== 'string' || metricCode.trim() === '') {
    throw new ConfigurationError(
      'metricCode must be a non-empty string or a function; set LAGO_METRIC_CODE',
    );
  }
  throw new ConfigurationError('metricCode must not have leading or trailing whitespace');
}
