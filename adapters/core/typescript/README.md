# @openaudr/audr

[![npm](https://img.shields.io/npm/v/@openaudr/audr?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr)](https://www.npmjs.com/package/@openaudr/audr)

The **core TypeScript SDK** for [AUDR](https://openaudr.dev/spec/v1.0.0/) (Agent Usage
Detail Record) builds records, validates them against the published schema, and delivers
them to any `Sink`, such as a file, a queue or a metering backend, through a bounded,
batching async pipeline. Adapters and sinks build on it, and an application can emit
records with this package alone. ESM with full type declarations and one small runtime
dependency, `uuid`.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
npm install @openaudr/audr
```

Requires Node.js 22.12 or later. The root entry point uses no Node-specific APIs.

## Usage

```ts
import { Client, createRecord } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';

const record = createRecord({
  timing: { duration_ms: 812 }, // event_time defaults to now
  resource: {
    provider: 'anthropic',
    type: 'model',
    name: 'claude-sonnet-5',
    operation: 'generation',
    modality: 'text',
  },
  usage: { llm: { input_tokens: 1200, output_tokens: 340, requests: 1 } },
  run: { run_id: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V', span_id: 'turn-3', run_type: 'agent_run' },
  attribution: { environment: 'production', account_id: 'acct_42' },
}); // record_id and spec_version are filled in

const client = new Client(new FileSink('audr.jsonl'), {
  emitter: { component: 'harness', name: 'my-harness', version: '1.4.0' },
});
const result = client.record(record);
if (!result.queued) console.warn('record rejected', result.issues);

await client.shutdown(); // drains the queue, then closes the sink
console.log(client.stats);
```

Records are plain objects in the wire format, typed by `AudrRecord`. `client.record()` is
synchronous: it copies and validates the record, stamps the client's `emitter` when the
record has none, and queues it for a background worker that batches records for the sink.
`Client` is `AsyncDisposable`, so `await using client = new Client(...)` shuts it down at
the end of the scope. Runnable versions, including a custom sink, are in
[`examples/`](https://github.com/openaudr/audr/tree/main/adapters/core/typescript/examples).

> [!IMPORTANT]
> `client.record()` never throws for a delivery problem. Check the returned `SubmitResult`,
> pass `onFailure` to `Client` to receive every record that was not delivered, and read
> `client.stats` for totals.

## Validation

Records arriving as JSON are parsed and validated by `decodeRecord()`, which throws
`ValidationError` carrying one issue per problem:

```ts
import { decodeRecord, ValidationError } from '@openaudr/audr';

const payload = '{"spec_version": "1.0.0", "resource": {"type": "model"}}';
try {
  decodeRecord(payload);
} catch (error) {
  if (!(error instanceof ValidationError)) throw error;
  for (const issue of error.issues) console.warn(issue.code, issue.path); // REQUIRED /record_id, ...
}
```

Each issue carries a stable `code` and a JSON-pointer `path`, never the offending value, so
issues are safe to log. `parseRecord()` validates an already parsed object, and
`validate()` returns the issues without throwing.

## Delivery

| `BatchResult` from the sink | Each record becomes |
| --- | --- |
| `accepted` | `sent`, except records the sink names as `rejected` (`dropped`) or `unknown` |
| `retryable_failure`, `permanent_failure`, `closed` | `dropped` |

Every record admitted through `client.record()` ends in exactly one of `sent`, `dropped`
or `unknown`. An `unknown` record may or may not have arrived, so a consumer that
de-duplicates on `record_id` can replay it safely. The pipeline never retries; retrying is
the sink's responsibility. A sink is any object with `deliver(batch)` and `close()` that
reports each batch's outcome rather than throwing.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/core/typescript/docs/reference.md): client options, submission outcomes, callbacks, the sink contract, `FileSink`, validation codes, testing helpers
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/core/typescript/examples): runnable offline, against the local filesystem
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/core/typescript/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
