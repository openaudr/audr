# @openaudr/audr-sink-stigg

[![npm](https://img.shields.io/npm/v/@openaudr/audr-sink-stigg?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-sink-stigg)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-sink-stigg)](https://www.npmjs.com/package/@openaudr/audr-sink-stigg)

The **Stigg sink** for [AUDR](https://openaudr.dev/spec/v1.1.0/) delivers record batches from
an [`@openaudr/audr`](https://www.npmjs.com/package/@openaudr/audr) `Client` to
[Stigg's](https://www.stigg.io/) raw events endpoint, for metering, entitlements and credits.
Each record becomes one Stigg event for the customer `attribution.account_id` names,
de-duplicated on `record_id`. ESM with full type declarations; no runtime dependencies beyond
`@openaudr/audr`.

> **Status: alpha.** Until 1.0.0, a minor release may change the public API.

## Setup

```bash
npm install @openaudr/audr @openaudr/audr-sink-stigg
```

Requires Node.js 22.12 or later, and a Stigg **server** API key for the environment the
usage belongs to.

## Usage

```ts
import { Client, createRecord } from '@openaudr/audr';
import { StiggSink } from '@openaudr/audr-sink-stigg';

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
    account_id: 'acct_42', // the Stigg customer
    subscription_id: 'sub_42', // optional: the Stigg resource
    feature_id: 'support-chat',
  },
});

const sink = new StiggSink({ eventName: 'ai.usage' }); // reads STIGG_API_KEY
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'my-harness', version: '1.4.0' },
});
const result = client.record(record);
if (!result.queued) console.warn('record rejected', result.issues);

await client.shutdown(); // drains the queue, then closes the sink
```

The `Client` stamps its `emitter` onto every record that arrives without one. Record
construction is documented in the
[core SDK README](https://github.com/openaudr/audr/blob/main/adapters/core/typescript/README.md).
A runnable version against a stand-in endpoint is
[`examples/deliver.ts`](https://github.com/openaudr/audr/blob/main/sinks/stigg/typescript/examples/deliver.ts).

> [!IMPORTANT]
> Stigg routes on `attribution.account_id`. A record without one is never sent: `deliver()`
> returns it rejected with detail `missing_customer_id`. A record that corrects another
> (`corrects`) is never sent either: it is rejected with detail `unsupported_correction`,
> because Stigg usage is append-only.

## Configuration

| Option | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `apiKey` | `STIGG_API_KEY` | required | A Stigg server API key. It selects the Stigg environment. |
| `eventName` | none | required | The event name, or `(record) => string` to name each record's event. |
| `apiUrl` | `STIGG_API_URL` | `https://api.stigg.io` | An origin, the origin with `/api/v1`, or the full `/api/v1/events` URL. |
| `allowInsecureHttp` | none | `false` | Permit an `http:` URL, for a local Stigg API on a trusted network. |
| `retry`, `timeoutMs`, `fetch`, `logger` | none | see the reference | Retry budget, request deadline, `fetch` replacement and diagnostics. |

Explicit options take precedence over the environment. Credentials belong to the sink and
never appear in logs, errors, `String(sink)` or `util.inspect(sink)`. An invalid configuration
throws `ConfigurationError` from the constructor.

One sink serves one Stigg environment, because the API key selects it. To send records of
several environments, construct one sink per key and route records to the matching client.
`attribution.environment` is forwarded as a dimension and never filtered on.

## Delivery

| AUDR field | Stigg event |
| --- | --- |
| the `eventName` option | `eventName` |
| `attribution.account_id` | `customerId` |
| `attribution.subscription_id`, when present | `resourceId` |
| `record_id` | `idempotencyKey` |
| `timing.event_time` | `timestamp`, converted to UTC |
| Every field, flattened | `dimensions`, such as `usage__llm__input_tokens` |

Stigg accepts only string, number and boolean dimension values, so every field is flattened
to a reversible name joined by `__`. Each label becomes its own dimension, such as
`attribution__labels__team`, and arrays are sent as canonical JSON under a `__json` suffix.
The separator is fixed, because meters and credit formulas refer to these names.
`flattenRecord(record)` returns the dimensions a record becomes before it is sent.

### Meters

An event never names a Stigg feature. Each metered feature's meter selects events with
conditions on `eventName` and on dimensions, then aggregates one dimension, and every meter
whose conditions an event matches counts it. A feature whose meter sums
`usage__llm__input_tokens` over events named `ai.usage`, for example, counts the input tokens
of every record the sink sends under that name, while another feature counts the same events'
output tokens. Add a condition on `attribution__feature_id` to split one event name into
several features, or name events per record with a function, such as
`eventName: (record) => \`ai.${record.attribution.feature_id}\``.

An event with `resourceId` counts only toward that resource's subscription, and an event
without one only toward the customer-level subscription. When a customer's subscription is
scoped to a resource, set `attribution.subscription_id` on every record.

For credits, a custom formula can read any dimension, such as
`dimensions.cost__total_cost` when the emitter asserts a cost. The sink never computes a
price: `cost` is forwarded as ordinary dimensions, as the emitter asserted it.

### Results

A batch is sent as sequential requests of at most 1,000 events, and the responses combine
into one `BatchResult`. Stigg validates a request as a unit: one invalid event fails the whole
request with a `400`. The sink checks Stigg's rules on every record first and rejects, by
name, the ones Stigg would refuse. If Stigg still refuses a request and its message names the
events at fault, the sink rejects those and resends the remainder. The
[reference](https://github.com/openaudr/audr/blob/main/sinks/stigg/typescript/docs/reference.md#responses)
maps each response status to an outcome.

Transient failures are retried inside `deliver()`, a bounded number of times, with the
identical request body. A retry therefore carries the same `idempotencyKey` and
`timestamp`, which together with the customer, resource and event name let Stigg recognise
it as the same event.

A Stigg `202` confirms that the events were queued, not that a meter counted them. Stigg
accepts an event for a customer or resource it does not know, and a meter counts it only
when the customer has a subscription or credit grant whose feature selects it. Check the
customer, the event name and the meter's filters in Stigg when usage does not appear.

This sink forwards **every field of the record**, including `attribution.labels` and any
`x_*` extension, to Stigg verbatim. `attribution.labels` MUST NOT contain PII and
`resource.key_name` is a label, never key material; the
[security policy](https://github.com/openaudr/audr/blob/main/SECURITY.md) holds the full
rules. Enforce them where the record is built, the last point at which they can be enforced.

The sink does not merge records that share `(run.run_id, run.span_id)`. When more than one
layer emits a record for the same call, such as a harness and a router, each becomes its own
event, so emit usage for Stigg from one layer.

## Shutdown

`client.shutdown()` drains the queue and closes the sink. `sink.close()` is idempotent and
aborts any request in flight, and later deliveries answer `closed`. A batch that closing
interrupts answers `closed`; when earlier requests of that batch had already settled
records, it answers `accepted` and lists the remaining records as `unknown`. Delivering an
unknown record again is safe, because Stigg de-duplicates on `record_id` with the same
timestamp.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/sinks/stigg/typescript/docs/reference.md): options, event mapping, responses, validation handling, idempotency, retries, diagnostics
- [Examples](https://github.com/openaudr/audr/tree/main/sinks/stigg/typescript/examples): runnable against a stand-in endpoint, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/sinks/stigg/typescript/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.1.0/), which defines every record field
- [Stigg raw events endpoint](https://docs.stigg.io/api-reference/usage/report-usage-events), which this sink calls

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
