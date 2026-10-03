# Reference

Complete behaviour of `@openaudr/audr`. The
[README](https://github.com/openaudr/audr/blob/main/adapters/core/typescript/README.md)
covers setup and usage.

## Entry points

| Import | Provides |
| --- | --- |
| `@openaudr/audr` | `Client`, `createRecord`, validation and encoding, the sink contract; no Node-specific APIs |
| `@openaudr/audr/file` | `FileSink`, which writes JSON Lines through `node:fs` |
| `@openaudr/audr/testing` | `makeRecord`, `MemorySink` and `assertSinkContract` |

## Client

`new Client(sink, options?)` owns the delivery pipeline for one sink.

| Option | Default | Purpose |
| --- | --- | --- |
| `emitter` | none | Stamped onto every record without one; an invalid emitter throws `ConfigurationError` |
| `ownsSink` | `true` | Close the sink on shutdown; pass `false` when the sink outlives the client |
| `maxQueueSize` | `1000` | Records queued or in flight before new ones drop with `dropped_queue_full` |
| `batchMaxSize` | `50` | Records per `deliver()` call, at most 500 |
| `lingerMs` | `5000` | Longest wait to fill a partial batch, at most 2147483647 |
| `onFailure` | none | Called once per record that ends `dropped` or `unknown` |
| `onDelivered` | none | Called once per accepted batch with the records the sink accepted |
| `clock` | `() => new Date()` | The clock `timing.event_time` is checked against |
| `logger` | none | Receives diagnostics; any object with `warn` and `error`, such as `console` |

An invalid option throws `ConfigurationError` from the constructor.

| Member | Behaviour |
| --- | --- |
| `record(record)` | Copy, validate and queue one record; returns a `SubmitResult` at once |
| `await flush(timeoutMs = 30000)` | Deliver queued work now; `true` when every earlier record reached a terminal state, `false` when the bound expired first |
| `await shutdown(timeoutMs = 30000)` | Stop accepting records, drain within the bound, wait for callback promises, then close the sink |
| `stats` | A `DeliveryStats` snapshot |
| `await using client = ...` | Calls `shutdown()` at the end of the scope |

Callbacks run synchronously on the delivery path, so keep them fast. A callback may return
a promise: delivery does not wait for it, but `shutdown()` does, within its bound. The
client catches any error a callback throws or rejects with. Changing a record after
passing it to `record()` does not change what is delivered.

## Submission outcomes

`record()` returns a `SubmitResult` whose `outcome` is a `SubmitOutcome`. `result.queued`
is `true` only for `queued`, and `result.issues` lists the validation issues of a rejected
record.

| `SubmitOutcome` | Meaning |
| --- | --- |
| `queued` | Validated and queued for delivery |
| `rejected_invalid` | Failed validation; never queued |
| `dropped_queue_full` | The queue held `maxQueueSize` records |
| `dropped_not_running` | The client had shut down |

## Failures and statistics

`onFailure` receives `{ record, disposition, reason, retryable, detail }`, where
`disposition` is `dropped` or `unknown`.

| `FailureReason` | Cause |
| --- | --- |
| `invalid` | The record failed validation |
| `queue_full` | The queue was full |
| `shutdown` | Still queued when the shutdown bound expired |
| `rejected` | The sink named the record in `BatchResult.rejected` |
| `sink_failure` | The batch failed with `retryable_failure` or `permanent_failure` |
| `sink_closed` | The sink answered `closed` |
| `inconclusive` | The sink named the record `unknown`, threw, or returned no valid result |

`DeliveryStats` counts `submitted`, `sent`, `dropped`, `unknown` and `batches`, and reports
the current `queueDepth` and `queueCapacity`. Every submitted record ends in exactly one of
`sent`, `dropped` or `unknown`.

## Sink contract

A sink implements two methods:

| Method | Contract |
| --- | --- |
| `deliver(batch, { signal })` | Receives a non-empty batch of at most `batchMaxSize` records, one batch at a time, and resolves to a `BatchResult` |
| `close()` | Releases resources; idempotent |

`signal` is an `AbortSignal` that fires when `shutdown()` stops waiting for the delivery.
By then the batch's records are already accounted `unknown`, so pass the signal to
`fetch()` or any other cancellable I/O and answer promptly.

| `BatchResult` | Meaning |
| --- | --- |
| `BatchResult.accepted({ rejected, unknown })` | The sink took the batch; `rejected` names records it refused with a reason, `unknown` names records it could not confirm |
| `BatchResult.failed({ retryable, detail })` | The whole batch failed |
| `BatchResult.closed()` | The sink is closed |

A sink reports an ordinary delivery failure as a result rather than throwing, and owns any
retry. An answered batch is never re-sent. The
[core contract](https://github.com/openaudr/audr/blob/main/adapters/core/README.md#the-sink-contract)
is the same in every language.

## FileSink

`new FileSink(path, { append })` writes one JSON line per record, with one write per batch.

- The file is opened in append mode unless `append` is `false`.
- When a write fails, the batch is reported retryable and any lines already written remain
  in the file, so consumers de-duplicate on `record_id`.
- A batch holding a record `encodeRecord()` refuses is reported as a permanent failure and
  not written.

## Validation and encoding

| Function | Behaviour |
| --- | --- |
| `createRecord(input)` | Fills `record_id`, `spec_version` and `timing.event_time` when absent |
| `decodeRecord(json)` | Parses and validates JSON text; throws `ValidationError` |
| `parseRecord(value)` | Validates an already parsed object; throws `ValidationError` |
| `validate(record)` | Returns the list of issues without throwing |
| `encodeRecord(record)` | Canonical JSON with sorted keys; throws `ValidationError` for a number JSON cannot represent (`NaN`, `±Infinity`) and for an array or non-plain object such as a `Date`, which no AUDR record holds |

Each `ValidationIssue` carries a `code` and a JSON-pointer `path`, and never the offending
value.

| Code | Meaning |
| --- | --- |
| `REQUIRED` | Required property is missing |
| `FORBIDDEN` | Property is not allowed in this context |
| `UNKNOWN_PROPERTY` | Property is not defined by the schema |
| `INVALID_TYPE` | Value has the wrong type |
| `INVALID_ENUM` | Value is not one of the allowed enumerants |
| `INVALID_STRING` | String is missing or empty |
| `STRING_TOO_LONG` | String exceeds the maximum allowed length |
| `INVALID_IDENTIFIER` | Identifier is not a ULID or UUIDv7 |
| `INVALID_DATETIME` | Value is not a valid RFC 3339 datetime |
| `MILLISECOND_PRECISION` | Timestamp must have millisecond precision |
| `FUTURE_EVENT_TIME` | `event_time` must not be in the future |
| `INVALID_COUNTER` | Counter must be a finite number greater than or equal to zero |
| `INVALID_COST` | Cost amount must be a finite number greater than or equal to zero |
| `INVALID_CURRENCY` | Currency must be a three-letter ISO 4217 code |
| `INVALID_PROPERTY_NAME` | Property name is not a valid AUDR key |
| `TOO_MANY_PROPERTIES` | Too many properties were provided |
| `NON_PSEUDONYMOUS_ID` | `user_id` must be a pseudonymous identifier, not a raw personal value |
| `EMPTY_USAGE` | Usage block must contain at least one counter |
| `INVALID_STRUCTURE` | Record shape violates a cross-field rule |
| `UNSUPPORTED_VERSION` | `spec_version` is not a supported AUDR release |
| `NOT_JSON` | Input is not valid JSON |

## Testing

| Helper (`@openaudr/audr/testing`) | Purpose |
| --- | --- |
| `makeRecord(overrides)` | A valid, minimal generation record with `overrides` applied |
| `new MemorySink({ reject, failWith })` | An in-memory sink that keeps every accepted record in `records` |
| `await assertSinkContract(sink)` | Asserts that a sink honours the contract above |

## Diagnostics

The client logs nothing unless `logger` is set. Messages carry counts, outcomes and paths;
they never contain a record value, and an error the logger throws is ignored.

## Runtime support

Node.js 22.12 or later. ESM only, with type declarations. `await using` needs Node.js 24 or
TypeScript compiled by `tsc`.
