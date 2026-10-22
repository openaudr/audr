# @openaudr/audr-sink-lago

[![npm](https://img.shields.io/npm/v/@openaudr/audr-sink-lago?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-sink-lago)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-sink-lago)](https://www.npmjs.com/package/@openaudr/audr-sink-lago)

The **Lago sink** for [AUDR](https://openaudr.dev/spec/v1.0.0/) delivers record batches from
an [`@openaudr/audr`](https://www.npmjs.com/package/@openaudr/audr) `Client` to
[Lago's](https://www.getlago.com/) batch event endpoint, for usage-based billing. Each record
becomes one Lago event, routed on `attribution.subscription_id` and de-duplicated on
`record_id`. ESM with full type declarations; no runtime dependencies beyond
`@openaudr/audr`.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
npm install @openaudr/audr @openaudr/audr-sink-lago
```

Requires Node.js 22.12 or later.

## Usage

```ts
import { Client, createRecord } from '@openaudr/audr';
import { LagoSink } from '@openaudr/audr-sink-lago';

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
  attribution: {
    environment: 'production',
    account_id: 'acct_42',
    subscription_id: 'sub_42',
    feature_id: 'support-chat', // the billable metric code
  },
});

const sink = new LagoSink(); // reads LAGO_API_KEY
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'my-harness', version: '1.4.0' },
});
const result = client.record(record);
if (!result.queued) console.warn('record rejected', result.issues);

await client.shutdown(); // drains the queue, then closes the sink
```

The `Client` stamps its `emitter` onto every record that arrives without one; a record that
reaches validation with no emitter is rejected with an `/emitter` issue and never sent.
Record construction is documented in the
[core SDK README](https://github.com/openaudr/audr/blob/main/adapters/core/typescript/README.md).
A runnable version against a stand-in endpoint, which
[chooses the metric code per record](#billable-metric), is
[`examples/deliver.ts`](https://github.com/openaudr/audr/blob/main/sinks/lago/typescript/examples/deliver.ts).

> [!IMPORTANT]
> Lago routes on `attribution.subscription_id`. A record without one is never sent:
> `deliver()` returns it rejected with detail `missing_subscription_id`. A record that
> corrects another (`corrects`) is never sent either: it is rejected with detail
> `unsupported_correction`, because Lago cannot restate an event.

## Configuration

Configure the sink with `apiKey`, explicitly or as `LAGO_API_KEY`; the explicit value takes
precedence. Credentials belong to the sink and never appear in logs, errors, `String(sink)` or
`util.inspect(sink)`. An invalid configuration throws `ConfigurationError` from the
constructor.

An event's `code` names the Lago billable metric it is billed against, and it is the record's
`attribution.feature_id`, which the host sets on every record. A record without one is
rejected with detail `missing_metric_code` and never sent. Lago accepts an event whose code
matches no active metric and then skips it without an error, so define a metric for every
feature the host emits.

`apiUrl`, or `LAGO_API_URL`, selects the Lago instance. It defaults to Lago Cloud in the US
region, `https://api.getlago.com`. Use `https://api.eu.getlago.com` for the EU region, or the
address of a [self-hosted](#self-hosted-lago) instance. The value is an origin, an origin
followed by `/api/v1`, or the full `/api/v1/events/batch` URL; all three name one endpoint.

## Delivery

| AUDR field | Lago event |
| --- | --- |
| `attribution.subscription_id` | `external_subscription_id` |
| `record_id` | `transaction_id` |
| `timing.event_time` | `timestamp`, in Unix seconds with millisecond precision |
| `attribution.feature_id` | `code` |
| Every field, flattened | `properties`, such as `usage__llm__input_tokens` |

Lago accepts only string and number property values, so every field is flattened to a
reversible name joined by `__`. Each label becomes its own property, such as
`attribution__labels__team`, and arrays are sent as canonical JSON under a `__json` suffix.
The separator is fixed, because billable metric definitions refer to these names. `flattenRecord(record)` returns the
properties a record becomes before it is sent.

### Billable metric

Create one Lago billable metric per `attribution.feature_id` the host emits, with that
feature as its code, and choose its aggregation field from the flattened names. A metric
that sums `usage__llm__input_tokens`, for example, bills the input tokens of every record
of its feature.

A Lago metric aggregates one field, so records that meter different things, such as model
tokens and tool calls, belong to different features. The host sets `feature_id` where it
builds the record, through the attribution hook of its AUDR adapter, so the split is made
where the operation is known.

One sink serves every metric. Each event carries its own code, so records with different
features are delivered in the same batch, and even the same request. A separate sink is
needed only for another Lago instance or API key.

A record without `attribution.feature_id` is rejected with detail `missing_metric_code`,
and one whose `feature_id` has leading or trailing whitespace with `invalid_metric_code`.
Neither is sent. Keep `feature_id` stable across replays: on a ClickHouse event store the
code is part of the de-duplication key, and the same record under another code is billed
again.

One record becomes one event under one metric code. Lago de-duplicates on `transaction_id`,
so the same record sent under a second code is dropped as a duplicate on a Postgres event
store.

### Results

A batch is sent as sequential requests of at most 100 events, and the responses combine into
one `BatchResult`. Lago validates a request as a unit: one invalid event fails the whole
request with a `422` that names the offending events. The sink rejects the named records and
resends the remainder. A record that Lago already holds counts as delivered. The
[reference](https://github.com/openaudr/audr/blob/main/sinks/lago/typescript/docs/reference.md#responses)
maps each response status to an outcome.

Transient failures are retried inside `deliver()`, a bounded number of times, with the
identical request body. A retry therefore carries the same `transaction_id` and `timestamp`
as the first attempt, which keeps it idempotent on both Lago event stores.

A Lago `200` confirms that the event was ingested, not that it was billed. Lago ingests and
then skips an event whose subscription does not exist or has terminated, whose metric code
matches no active metric, or whose timestamp precedes the subscription start. Check the
metric code and the subscription identifiers against Lago when usage does not appear on an
invoice.

This sink forwards **every field of the record**, including `attribution.labels` and any
`x_*` extension, to your Lago instance verbatim. `attribution.labels` MUST NOT contain PII and
`resource.key_name` is a label, never key material; the
[security policy](https://github.com/openaudr/audr/blob/main/SECURITY.md) holds the full
rules. Enforce them where the record is built, the last point at which they can be enforced.

## Self-hosted Lago

Set `apiUrl` to the origin of the instance, for example `https://lago.internal:8443`. The
sink requires HTTPS. An instance on a trusted network that serves plain HTTP is reachable
only with `allowInsecureHttp: true`, which sends the API key unencrypted. The sink rejects
a URL that carries userinfo, a query string, a fragment or an unrelated path, and it never
follows a redirect.

An instance that sets `LAGO_EVENTS_BATCH_MAX_LENGTH` below 100 refuses larger requests with
detail `too_many_events`. Set the client's `batchMaxSize` to that limit or lower.

## Shutdown

`client.shutdown()` drains the queue and closes the sink. `sink.close()` is idempotent and
aborts any request in flight, and later deliveries answer `closed`. A batch that closing
interrupts answers `closed`; when earlier requests of that batch had already settled
records, it answers `accepted` and lists the remaining records as `unknown`. Delivering an
unknown record again is safe, because Lago de-duplicates on `record_id`.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/sinks/lago/typescript/docs/reference.md): options, event mapping, responses, validation handling, idempotency, retries, diagnostics
- [Examples](https://github.com/openaudr/audr/tree/main/sinks/lago/typescript/examples): runnable against a stand-in endpoint, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/sinks/lago/typescript/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field
- [Lago batch endpoint](https://getlago.com/docs/api-reference/events/batch), which this sink calls

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
