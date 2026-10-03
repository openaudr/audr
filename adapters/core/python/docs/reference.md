# Reference

Complete behaviour of the `audr` package. The
[README](https://github.com/openaudr/audr/blob/main/adapters/core/python/README.md) covers
setup and usage.

## Client

`audr.Client(sink, **options)` owns the delivery pipeline for one sink.

| Option | Default | Purpose |
| --- | --- | --- |
| `sink` | required | Any object implementing the [`Sink`](#sink-contract) protocol |
| `emitter` | `None` | Stamped onto every record that arrives without one |
| `owns_sink` | `True` | Close the sink on shutdown; pass `False` when the sink outlives the client |
| `max_queue_size` | `1000` | Records queued before `record()` drops with `DROPPED_QUEUE_FULL`; at least 1 |
| `batch_max_size` | `50` | Records per `deliver()` call, 1 to 500 |
| `linger_seconds` | `5.0` | Longest wait to fill a batch before sending it; at least 0 |
| `on_failure` | `None` | Called once per record that was not delivered, with a `FailedRecord` |
| `on_delivered` | `None` | Called once per accepted batch with the records the sink accepted |
| `clock` | system clock | Supplies "now" for the `FUTURE_EVENT_TIME` check |

An invalid option raises `audr.ConfigurationError` from the constructor.

| Method | Behaviour |
| --- | --- |
| `record(record)` | Validate and queue one `AUDR` or mapping; returns a `SubmitResult` at once |
| `await flush(timeout=None)` | Deliver queued work now; `True` when every earlier record reached a terminal state, `False` when `timeout` (default 30 seconds) expired first |
| `await shutdown(timeout=None)` | Stop accepting records, drain within `timeout`, then close the sink; idempotent |
| `stats` | An immutable `DeliveryStats` snapshot |
| `async with Client(...)` | Calls `shutdown()` on exit |

`record()` must be called on the thread running the event loop; any other thread raises
`audr.LifecycleError`, because the record could never be delivered. Callbacks run
synchronously on the delivery path, so keep them fast; an exception a callback raises is
logged and does not stop delivery.

## Submission outcomes

`record()` returns a `SubmitResult` whose `outcome` is a `SubmitOutcome`. `result.queued`
is `True` only for `QUEUED`, and `result.issues` lists the validation issues of a rejected
record.

| `SubmitOutcome` | Meaning |
| --- | --- |
| `QUEUED` | Validated and queued for delivery |
| `REJECTED_INVALID` | Failed validation; never queued |
| `DROPPED_QUEUE_FULL` | The queue held `max_queue_size` records |
| `DROPPED_NOT_RUNNING` | The client had shut down |
| `DROPPED_INTERNAL_ERROR` | Reserved; not returned by this release |

## Failures and statistics

`on_failure` receives a `FailedRecord` with the `record`, its `disposition` (`dropped` or
`unknown`), a `reason`, whether it is `retryable`, and the sink's `detail`.

| `FailureReason` | Cause |
| --- | --- |
| `invalid` | The record failed validation |
| `queue_full` | The queue was full |
| `not_running` | The client had shut down |
| `shutdown` | Still queued when the shutdown timeout expired |
| `rejected` | The sink named the record in `BatchResult.rejected` |
| `sink_failure` | The batch failed with `RETRYABLE_FAILURE` or `PERMANENT_FAILURE` |
| `sink_closed` | The sink answered `CLOSED` |
| `inconclusive` | The sink named the record `unknown`, raised, was cancelled, or returned an incomplete result |

`DeliveryStats` counts `submitted`, `sent`, `dropped`, `unknown` and `batches`, and reports
the current `queue_depth` and `queue_capacity`. Every submitted record ends in exactly one
of `sent`, `dropped` or `unknown`.

## Sink contract

A sink implements two coroutines:

| Method | Contract |
| --- | --- |
| `deliver(batch)` | Receives a non-empty batch of at most `batch_max_size` records, one batch at a time, and returns a `BatchResult` |
| `close()` | Releases resources; idempotent |

| `BatchResult` | Meaning |
| --- | --- |
| `BatchResult.accepted(rejected=..., unknown=...)` | The sink took the batch; `rejected` lists `RejectedRecord(record_id, reason)` and `unknown` lists record IDs it could not confirm |
| `BatchResult.failed(retryable=..., detail=...)` | The whole batch failed |
| `BatchResult.closed()` | The sink is closed |

A sink reports an ordinary delivery failure as a result rather than raising, and owns any
retry. An answered batch is never re-sent. The
[core contract](https://github.com/openaudr/audr/blob/main/adapters/core/README.md#the-sink-contract)
is the same in every language.

## FileSink

`FileSink(target, format="jsonl", append=True)` writes one JSON object per line.

- A path is opened on the first `deliver()`, in append mode unless `append=False`, and
  closed by `close()`. An open stream is written as given and never closed by the sink.
- Each batch is flushed once. When a write fails part way, the batch is reported
  `RETRYABLE_FAILURE` while the lines already written remain in the file, so consumers
  de-duplicate on `record_id`.

## Validation

`AUDR.from_json(text)` and `client.record()` validate against the AUDR v1.0.0 schema and
rules; `record.validate()` returns the issues for a record built in code. Each
`ValidationIssue` carries a `code`, a JSON-pointer `path` and a `message`, and never the
offending value.

| `ErrorCode` | Meaning |
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

`record.to_json()` and `record.to_dict()` serialize a record, omitting unset fields.

## Testing

`audr.testing` supports tests of adapters and sinks.

| Helper | Purpose |
| --- | --- |
| `make_record(**overrides)` | A valid, minimal generation record with `overrides` applied |
| `MemorySink(reject=..., fail_with=...)` | An in-memory sink that collects accepted records in `records` |
| `await assert_sink_contract(sink)` | Asserts that a sink honours the contract above; it closes the sink, so pass a disposable instance |

## Diagnostics

The client logs to the `audr.client` and `audr.pipeline` loggers through the standard
`logging` module. Messages carry counts, outcomes and paths; they never contain a record
value.

## Runtime support

Python 3.11 to 3.14.
