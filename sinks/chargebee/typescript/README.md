# audr-sink-chargebee

[![npm](https://img.shields.io/npm/v/@openaudr/audr-sink-chargebee?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-sink-chargebee)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-sink-chargebee)](https://www.npmjs.com/package/@openaudr/audr-sink-chargebee)

> **Status: alpha.** The record model tracks AUDR v1.0.0 and is stable; the TypeScript API
> may change in minor releases before 1.0.

The Chargebee sink for [AUDR](https://openaudr.dev). Delivers record batches from the
[`@openaudr/audr`](https://www.npmjs.com/package/@openaudr/audr) core SDK to a site's
usage-ingest batch endpoint. ESM with full type declarations; no runtime dependencies
beyond `@openaudr/audr`.

## Install

```bash
npm install @openaudr/audr @openaudr/audr-sink-chargebee
```

Requires Node.js 22.12 or later.

## Quickstart

```ts
import { Client, createRecord } from '@openaudr/audr';
import { ChargebeeSink } from '@openaudr/audr-sink-chargebee';

// Record construction is documented in the core SDK README:
// https://github.com/openaudr/audr/blob/main/adapters/core/typescript/README.md
// Chargebee additionally requires attribution.subscription_id.
const record = createRecord({
  resource: {
    provider: 'anthropic',
    type: 'model',
    name: 'claude-sonnet-5',
    operation: 'generation',
    modality: 'text',
  },
  usage: { llm: { input_tokens: 1200, output_tokens: 340, requests: 1 } },
  run: { run_id: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V', span_id: 'turn-3', run_type: 'agent_run' },
  attribution: { environment: 'production', account_id: 'acct_42', subscription_id: 'sub_42' },
});

const sink = new ChargebeeSink({ site: 'acme', apiKey: process.env.CHARGEBEE_API_KEY });
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'my-harness', version: '1.4.0' },
});
const result = client.record(record);
if (!result.queued) console.warn('record rejected', result.issues);

await client.shutdown(); // drains the queue, then closes the sink
```

Every record requires an emitter. Pass `emitter` to the `Client` as above and it is
stamped onto any record that arrives without one; a record that reaches validation with no
emitter is rejected with an `/emitter` issue and never sent.

## Configuration

Configure the sink with `site` and `apiKey`. Pass them explicitly or set `CHARGEBEE_SITE`
and `CHARGEBEE_API_KEY`; explicit values take precedence, and `apiKey` is always required.
Credentials belong to the sink and never appear in logs, errors, `String(sink)` or
`util.inspect(sink)`. An invalid configuration throws `ConfigurationError` from the
constructor.

The sink sends each batch to `https://{site}.{ingestDomain}/api/v2/batch/usage_events`.

- `ingestDomain` defaults to `ingest.chargebee.com`, the Chargebee batch ingest domain.
- Override the domain with `ingestDomain` or `CHARGEBEE_INGEST_DOMAIN`, for example to
  target a test environment.
- For a host that is not a `{site}` subdomain of the ingest domain, set the full origin
  with `ingestUrl` or `CHARGEBEE_INGEST_URL`. It must be `https`, carry no credentials,
  query or fragment, and is mutually exclusive with `site` and `ingestDomain`.

## Routing and delivery

- Chargebee routes on `attribution.subscription_id`. A record with no `subscription_id`
  is never sent; `deliver()` returns it rejected with detail `missing_subscription_id`.
- `record_id` is used as Chargebee's `deduplication_id` and `timing.event_time` (as
  milliseconds) becomes `usage_timestamp`.
- AUDR records are nested; Chargebee's ingest API accepts scalar properties only, so the
  sink flattens every field to reversible names such as `usage__llm__input_tokens`.
  Arrays and `attribution.labels` are sent as canonical JSON under a `__json` suffix, for
  example `attribution__labels__json`. The default separator is `__`, which keeps path
  boundaries distinct from the underscores inside AUDR field names; it is configurable
  with `separator` and must be one or more underscores, since Chargebee property names
  may only contain letters, digits, and underscores.
- A batch is sent as one request. If Chargebee refuses it as too large it answers `413`
  and `deliver()` fails the whole batch with detail `payload_too_large`, dropping every
  record in it; send fewer records per request with `new Client(sink, { batchMaxSize })`.
  That bounds the record count, not the byte size — a single record too large on its own
  cannot be delivered.
- When a `207` response body contains a failed event that cannot be matched back to a
  record in the batch (an unrecognised or duplicated `deduplication_id`), every
  non-rejected record in that batch is conservatively reported as `unknown` rather than
  assumed accepted; `record_id` makes a replay idempotent.
- Redirects are never followed. `close()` aborts any request in flight, is idempotent,
  and never throws.

Each HTTP response becomes one `BatchResult`:

| Response | Outcome | `detail` |
| --- | --- | --- |
| `202`, `207` | `accepted`; `rejected` and `unknown` name individual records | |
| `401` | permanent failure | `auth` |
| `413` | permanent failure | `payload_too_large` |
| `408`, `429`, `500`, `502`, `503`, `504` | retryable failure, once `retry` is exhausted | `http_<status>` |
| network error or timeout | retryable failure, once `retry` is exhausted | the error code or name |
| any other status | permanent failure | `http_<status>` |

## Data handling

This sink flattens and forwards **every field of the record**, including
`attribution.labels` and any `x_*` extension, to your Chargebee site. Delivery is
verbatim, and no downstream component re-checks the record. `attribution.labels` MUST NOT
contain PII and `resource.key_name` is a label, never key material — see the
[security policy](https://github.com/openaudr/audr/blob/main/SECURITY.md) for the full
rules. Enforce them where the record is built — that is the last point at which they can
be enforced.

## Retry, transport and flattening

Delivery behaviour is tuned on the constructor, alongside the `site` and `apiKey`
described above:

```ts
import { ChargebeeSink } from '@openaudr/audr-sink-chargebee';

const sink = new ChargebeeSink({
  site: 'acme',
  apiKey: process.env.CHARGEBEE_API_KEY,
  retry: { maxAttempts: 3, initialBackoffMs: 500, maxBackoffMs: 30_000, multiplier: 2 },
  timeoutMs: 10_000, // deadline for each HTTP request
  separator: '__',
});
```

Retries use full-jitter exponential backoff and honour a `Retry-After` header, capped at
`maxBackoffMs`. Pass `fetch` to replace the global `fetch`, for example with one backed by
an undici `Agent` for connection-pool tuning. The sink logs nothing by default; pass
`logger: console`, or any logger with `warn` and `error`, to receive its diagnostics, which
never contain a record value or a credential.

`flattenRecord(record, { separator })` is exported, so you can inspect the properties a
record becomes before sending it.

## Contributing

Contributions are welcome — see
[`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).

Licensed under Apache-2.0.
