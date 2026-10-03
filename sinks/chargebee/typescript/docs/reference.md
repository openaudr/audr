# Reference

Complete behaviour of `@openaudr/audr-sink-chargebee`. The
[README](https://github.com/openaudr/audr/blob/main/sinks/chargebee/typescript/README.md)
covers setup and usage.

## Options

`new ChargebeeSink(options?)` takes one options object.

| Option | Default | Purpose |
| --- | --- | --- |
| `site` | `CHARGEBEE_SITE` | Chargebee site name, the `{site}` subdomain of the ingest domain |
| `apiKey` | `CHARGEBEE_API_KEY` | Site API key; always required |
| `ingestDomain` | `CHARGEBEE_INGEST_DOMAIN`, then `ingest.chargebee.com` | Domain the site subdomain is joined to |
| `ingestUrl` | `CHARGEBEE_INGEST_URL` | Full ingest origin; `https`, without credentials, query or fragment; mutually exclusive with `site` and `ingestDomain` |
| `retry` | see [Retries](#retries) | Retry budget and backoff |
| `timeoutMs` | `10000` | Deadline for each HTTP request, in milliseconds |
| `fetch` | `globalThis.fetch` | Replaces `fetch`, for example with one backed by an undici `Agent` for connection-pool tuning |
| `separator` | `'__'` | Joins flattened path segments; one or more underscores |
| `logger` | none | Receives diagnostics; any object with `warn` and `error`, such as `console` |

Explicit options take precedence over environment variables. An invalid combination or
value throws `ConfigurationError` from the constructor.

```ts
import { ChargebeeSink } from '@openaudr/audr-sink-chargebee';

const sink = new ChargebeeSink({
  site: 'acme',
  apiKey: process.env.CHARGEBEE_API_KEY,
  retry: { maxAttempts: 5, initialBackoffMs: 1_000 },
  timeoutMs: 20_000,
  separator: '__',
  logger: console,
});
```

## Flattening

`flattenRecord(record, { separator })` produces the `properties` of each usage event.

- A nested object becomes one property per leaf, its path joined by the separator:
  `usage.llm.input_tokens` becomes `usage__llm__input_tokens`.
- An array, and the caller-keyed `attribution.labels` map, become one canonical JSON
  string under a terminal `json` segment: `attribution__labels__json`.
- Every field is forwarded, including `x_*` extensions.

The default `__` keeps path boundaries distinct from the underscores inside AUDR field
names, so every property name maps back to exactly one field. Chargebee property names may
contain only letters, digits and underscores, so the separator must be one or more
underscores. The Python sink emits the same names, so both can deliver to one site.

## Responses

Each HTTP response becomes one `BatchResult`.

| Response | Outcome | `detail` |
| --- | --- | --- |
| `202`, `207` | `accepted`; `rejected` and `unknown` name individual records | |
| `401` | permanent failure | `auth` |
| `413` | permanent failure | `payload_too_large` |
| `408`, `429`, `500`, `502`, `503`, `504` | retryable failure, once `retry` is exhausted | `http_<status>` |
| Network error or timeout | retryable failure, once `retry` is exhausted | the error code or name |
| Any other status | permanent failure | `http_<status>` |

- A `413` fails the whole batch and drops every record in it. Lower the client's
  `batchMaxSize` to send fewer records per request. That bounds the record count, not the
  byte size; a single record too large on its own cannot be delivered.
- When a `207` body names a failed event that cannot be matched to a record in the batch,
  an unrecognised or duplicated `deduplication_id`, every non-rejected record in the batch
  is reported `unknown` rather than assumed accepted.
- A record without `attribution.subscription_id` is returned rejected with detail
  `missing_subscription_id` and never sent.
- Redirects are never followed. `close()` aborts any request in flight, is idempotent and
  never throws.

## Retries

| `retry` field | Default | Purpose |
| --- | --- | --- |
| `maxAttempts` | `3` | Attempts per batch, including the first |
| `initialBackoffMs` | `500` | Delay before the first retry |
| `maxBackoffMs` | `30000` | Upper bound on any delay |
| `multiplier` | `2` | Exponential growth factor |

Delays use full-jitter exponential backoff and honour a `Retry-After` header, capped at
`maxBackoffMs`.

## Diagnostics

The sink logs nothing unless `logger` is set. Messages are prefixed
`audr-sink-chargebee:` and carry status codes, batch sizes and the ingest origin; they
never contain a record value or a credential.

| Level | When |
| --- | --- |
| `error` | The API key was rejected (`401`) |
| `warn` | A batch was refused as too large, rejected permanently, or sent after `close()` |
| `warn` | A `207` body was unparseable or named events that could not be matched to the batch |

## Runtime support

Node.js 22.12 or later. ESM only, with type declarations.
