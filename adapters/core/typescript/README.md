# audr

[![npm](https://img.shields.io/npm/v/audr?include_prereleases)](https://www.npmjs.com/package/audr)
[![Node versions](https://img.shields.io/node/v/audr)](https://www.npmjs.com/package/audr)

> **Status: alpha.** The record model tracks AUDR v1.0.0 and is stable; the TypeScript API
> may change in minor releases before 1.0.

Vendor-neutral TypeScript SDK for emitting [AUDR](https://openaudr.dev/spec/v1.0.0/) (Agent
Usage Detail Record) v1.0.0 records: build records, validate them against the published
schema, and deliver them to any `Sink` (a file, a queue, a metering backend) through a
bounded, batching async pipeline. Two small runtime dependencies (`zod` and `uuid`); ESM
with full type declarations.

## Install

```bash
npm install audr
```

Requires Node.js 22.12 or later. The root entry point uses no Node-specific APIs.

## Quickstart

```ts
import { Client, createRecord } from 'audr';
import { FileSink } from 'audr/file';

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

`Client` is `AsyncDisposable`, so on Node.js 24+ or in TypeScript compiled by `tsc`,
`await using client = new Client(...)` shuts it down at the end of the scope.

Records are plain objects in the wire format, typed by `AudrRecord`. `client.record()` is
synchronous and never throws: it copies and validates the record, stamps the client's
`emitter` when the record has none, and returns a `SubmitResult` whose `outcome` says
whether the record was queued. Changing a record after passing it in does not change what
is delivered. Records are delivered in batches of up to `batchMaxSize` (default 50), sent
when a batch fills, after `lingerMs` (default 5000), or on `flush()` and `shutdown()`.

`FileSink` writes one JSON line per record, with one write per batch. When a write fails,
the batch is reported retryable, and any lines already written remain in the file.
Replays from `onFailure` are therefore idempotent when the consumer de-duplicates on
`record_id`.

## Delivery callbacks

```ts
const client = new Client(sink, {
  onDelivered: (records) => metrics.count('audr.sent', records.length),
  onFailure: ({ record, disposition, reason, retryable }) => {
    if (retryable) replayQueue.push(record); // disposition: 'dropped' | 'unknown'
  },
});
```

Every record admitted through `client.record()` ends in exactly one terminal state:
`sent`, `dropped` or `unknown`. See the
[delivery states](https://github.com/openaudr/audr/blob/main/adapters/core/README.md#delivery-states).
`onDelivered` fires once per accepted batch with the records that were sent; records a
sink rejected or could not confirm go to `onFailure`. Both callbacks run synchronously on
the delivery path, so keep them fast. The client catches and logs any error they throw.
`client.stats` returns a `DeliveryStats` snapshot of the counters.

## Parsing JSON input

Records that arrive as JSON are parsed and validated by `decodeRecord()`. For an object
that has already been parsed, use `parseRecord()`, and use `validate()` to get a list of
issues without an exception:

```ts
import { decodeRecord, ValidationError } from 'audr';

try {
  const record = decodeRecord(payload);
} catch (error) {
  if (!(error instanceof ValidationError)) throw error;
  for (const issue of error.issues) console.warn('bad AUDR record', issue.code, issue.path);
}
```

A `ValidationIssue` carries a stable `code` and a JSON-pointer `path`, never a field value.
`encodeRecord()` produces canonical JSON (keys sorted) for a record.

## Writing a sink

A sink is any object with `deliver(batch)` and `close()`. It reports each batch's outcome
rather than throwing:

```ts
import { type AudrRecord, BatchResult, type Sink } from 'audr';

class PrintSink implements Sink {
  #closed = false;

  async deliver(batch: readonly AudrRecord[]): Promise<BatchResult> {
    if (this.#closed) return BatchResult.closed();
    for (const record of batch) console.log(record.record_id);
    return BatchResult.accepted();
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
```

`audr/testing` provides `assertSinkContract()` to check a sink against the
[sink contract](https://github.com/openaudr/audr/blob/main/adapters/core/README.md#the-sink-contract),
together with `MemorySink` and `makeRecord()` for tests.

## Specification

This SDK implements [AUDR v1.0.0](https://openaudr.dev/spec/v1.0.0/). The
[schema, prose rules and conformance fixtures](https://github.com/openaudr/audr/tree/main/spec)
define the standard this package is tested against.

## Contributing

Contributions are welcome — see
[`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).

Licensed under Apache-2.0.
