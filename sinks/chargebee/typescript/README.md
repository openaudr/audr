# @openaudr/audr-sink-chargebee

[![npm](https://img.shields.io/npm/v/@openaudr/audr-sink-chargebee?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-sink-chargebee)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-sink-chargebee)](https://www.npmjs.com/package/@openaudr/audr-sink-chargebee)

The **Chargebee sink** for [AUDR](https://openaudr.dev/spec/v1.0.0/) delivers record batches
from an [`@openaudr/audr`](https://www.npmjs.com/package/@openaudr/audr) `Client` to a
Chargebee site's usage-ingest batch endpoint, for Chargebee Usage-Based Billing. Each
record becomes one usage event, routed on `attribution.subscription_id` and de-duplicated
on `record_id`. ESM with full type declarations; no runtime dependencies beyond
`@openaudr/audr`.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
npm install @openaudr/audr @openaudr/audr-sink-chargebee
```

Requires Node.js 22.12 or later.

## Usage

```ts
import { Client, createRecord } from '@openaudr/audr';
import { ChargebeeSink } from '@openaudr/audr-sink-chargebee';

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

const sink = new ChargebeeSink(); // reads CHARGEBEE_SITE and CHARGEBEE_API_KEY
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'my-harness', version: '1.4.0' },
});
const result = client.record(record);
if (!result.queued) console.warn('record rejected', result.issues);

await client.shutdown(); // drains the queue, then closes the sink
```

The `Client` stamps its `emitter` onto every record that arrives without one; a record
that reaches validation with no emitter is rejected with an `/emitter` issue and never
sent. Record construction is documented in the
[core SDK README](https://github.com/openaudr/audr/blob/main/adapters/core/typescript/README.md).
A runnable version against a stand-in endpoint is
[`examples/deliver.ts`](https://github.com/openaudr/audr/blob/main/sinks/chargebee/typescript/examples/deliver.ts).

> [!IMPORTANT]
> Chargebee routes on `attribution.subscription_id`. A record without one is never sent:
> `deliver()` returns it rejected with detail `missing_subscription_id`.

## Configuration

Configure the sink with `site` and `apiKey`. Pass them explicitly or set `CHARGEBEE_SITE`
and `CHARGEBEE_API_KEY`; explicit values take precedence, and `apiKey` is always required.
Credentials belong to the sink and never appear in logs, errors, `String(sink)` or
`util.inspect(sink)`. An invalid configuration throws `ConfigurationError` from the
constructor.

The sink sends each batch to `https://{site}.{ingestDomain}/api/v2/batch/usage_events`.
`ingestDomain` defaults to `ingest.chargebee.com`; override it with `ingestDomain` or
`CHARGEBEE_INGEST_DOMAIN`. For a host that is not a `{site}` subdomain of the ingest
domain, set the full origin with `ingestUrl` or `CHARGEBEE_INGEST_URL`, which is mutually
exclusive with `site` and `ingestDomain`.

## Delivery

| AUDR field | Chargebee usage event |
| --- | --- |
| `attribution.subscription_id` | `subscription_id` |
| `record_id` | `deduplication_id` |
| `timing.event_time` | `usage_timestamp`, in milliseconds |
| Every field, flattened | `properties`, such as `usage__llm__input_tokens` |

Chargebee accepts scalar properties only, so every field is flattened to a reversible name
joined by `__`. Arrays and `attribution.labels` are sent as canonical JSON under a `__json`
suffix, such as `attribution__labels__json`. Create metered features against these names.
`flattenRecord(record)` returns the properties a record becomes before it is sent.

A batch is sent as one request, and each response becomes one `BatchResult`. A replay
keyed on `record_id` is idempotent. The
[reference](https://github.com/openaudr/audr/blob/main/sinks/chargebee/typescript/docs/reference.md#responses)
maps each response status to an outcome.

This sink forwards **every field of the record**, including `attribution.labels` and any
`x_*` extension, to your Chargebee site verbatim. `attribution.labels` MUST NOT contain
PII and `resource.key_name` is a label, never key material; the
[security policy](https://github.com/openaudr/audr/blob/main/SECURITY.md) holds the full
rules. Enforce them where the record is built, the last point at which they can be
enforced.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/sinks/chargebee/typescript/docs/reference.md): options, flattening, responses, retries, diagnostics
- [Examples](https://github.com/openaudr/audr/tree/main/sinks/chargebee/typescript/examples): runnable against a stand-in ingest endpoint, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/sinks/chargebee/typescript/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
