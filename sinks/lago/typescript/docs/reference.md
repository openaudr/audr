# Reference

Complete behaviour of `@openaudr/audr-sink-lago`. The
[README](https://github.com/openaudr/audr/blob/main/sinks/lago/typescript/README.md)
covers setup and usage.

## Options

`new LagoSink(options?)` takes one options object.

| Option | Default | Purpose |
| --- | --- | --- |
| `apiKey` | `LAGO_API_KEY` | Lago API key, sent as a bearer token; always required |
| `metricCode` | `LAGO_METRIC_CODE`, then the record's `attribution.feature_id` | Code of the billable metric events are billed against, or a function that chooses it per record, see [Metric code](#metric-code) |
| `apiUrl` | `LAGO_API_URL`, then `https://api.getlago.com` | Lago origin, an origin with `/api/v1`, or the full batch URL |
| `allowInsecureHttp` | `false` | Permits an `http` `apiUrl`, which sends the API key unencrypted |
| `retry` | see [Retries](#retries) | Retry budget and backoff |
| `timeoutMs` | `10000` | Deadline for each HTTP request, in milliseconds |
| `fetch` | `globalThis.fetch` | Replaces `fetch`, for example with one backed by an undici `Agent` for connection-pool tuning |
| `logger` | none | Receives diagnostics; any object with `warn` and `error`, such as `console` |

Explicit options take precedence over environment variables. An invalid value throws
`ConfigurationError` from the constructor; its message names the option and never repeats
the value.

```ts
import { LagoSink } from '@openaudr/audr-sink-lago';

const sink = new LagoSink({
  apiKey: process.env.LAGO_API_KEY,
  metricCode: 'ai_usage',
  apiUrl: 'https://api.eu.getlago.com',
  retry: { maxAttempts: 5, initialBackoffMs: 1_000 },
  timeoutMs: 20_000,
  logger: console,
});
```

### Endpoint

`apiUrl` names one endpoint in any of three forms. The path is checked, not guessed: any
other path is rejected.

| `apiUrl` | Endpoint |
| --- | --- |
| `https://api.getlago.com` | `https://api.getlago.com/api/v1/events/batch` |
| `https://lago.internal:8443/api/v1` | `https://lago.internal:8443/api/v1/events/batch` |
| `https://lago.internal:8443/api/v1/events/batch` | unchanged |

A trailing slash is ignored. The URL must use `https`, unless `allowInsecureHttp` is set. It
must not carry userinfo, a query string, a fragment, a backslash, an internationalised
host name or an explicit default port. The API key is sent to the resulting endpoint only,
and the sink never follows a redirect.

`apiKey` is a non-empty string of printable ASCII characters without spaces. `metricCode`
is a non-blank string without leading or trailing whitespace, or a function.

### Metric code

By default, the code of each record's event is its `attribution.feature_id`, and a record
without one is rejected with `missing_metric_code`. `metricCode` replaces that default for
every record: it is either one code for every event, or a function
`(record: AudrRecord) => string | undefined` that chooses the code of each record's event.
The `MetricCode` type names both forms. `LAGO_METRIC_CODE` can only name one code.

- One `LagoSink` serves every metric. Each event carries its own `code`, so records with
  different codes travel in the same batch and the same request. Create another sink only
  for another Lago instance or API key.
- The sink calls the function once per record, before anything is sent, and validates
  what it returns as it validates a fixed code. A record for which it returns `undefined`
  is rejected with detail `missing_metric_code`; a record for which it returns anything
  else that is not a valid code, or throws, is rejected with detail
  `invalid_metric_code`. The other records of the batch are unaffected, and the error the
  function threw is neither logged nor returned.
- The function must depend only on the record. A replay that chose another code would be
  a second billable event on a ClickHouse event store, see [Idempotency](#idempotency).

## Event mapping

Every record becomes one event of Lago's batch endpoint.

| Lago event field | Source |
| --- | --- |
| `transaction_id` | `record_id` |
| `external_subscription_id` | `attribution.subscription_id` |
| `code` | `attribution.feature_id`, or the code `metricCode` names or chooses for the record |
| `timestamp` | `timing.event_time`, in Unix seconds with millisecond precision, such as `"1791192555.242"` |
| `properties` | the flattened record, see [Flattening](#flattening) |

- Lago defaults a missing `timestamp` to the ingestion time. The sink always sends one, so
  that a retry reproduces the original event.
- One record becomes one event under one metric code. The records of one batch may go to
  different metrics, but the sink does not send a record under several codes: Lago
  de-duplicates on `transaction_id`, so the second event is dropped as a duplicate on a
  Postgres event store.
- The sink does not set `precise_total_amount_cents`. A record's `cost` fields are
  forwarded as ordinary properties.

## Flattening

`flattenRecord(record)` produces the `properties` of an event.

- A nested object becomes one property per leaf, its path joined by `__`:
  `usage.llm.input_tokens` becomes `usage__llm__input_tokens`.
- Each `attribution.labels` entry becomes one property, `attribution__labels__<key>`, with
  the key verbatim.
- An array becomes one canonical JSON string under a terminal `json` segment. Canonical
  means sorted keys and no whitespace, so equal values produce equal strings.
- `attribution.feature_id` and `resource.namespace`, introduced by specification 1.1.0,
  arrive as `attribution__feature_id` and `resource__namespace`.
- Every field is forwarded, including `x_*` extensions.
- A leaf that is neither a string nor a finite number, such as `null` or a boolean, cannot
  be a Lago property. The record is rejected with detail `unencodable_field:<pointer>`,
  where the pointer is the record field's JSON pointer. Inside an array, every JSON value is
  kept except a non-finite number.

The separator is `__` and cannot be changed. It keeps path boundaries distinct from the
underscores inside AUDR field names, so every property name maps back to exactly one field,
and a billable metric that refers to a name keeps working across releases.

## Record rejections

A record is returned in `rejected` with one of these details. A record that cannot become a
valid event is rejected locally and never sent; the other records of the batch are
unaffected.

| `detail` | Cause |
| --- | --- |
| `missing_subscription_id` | `attribution.subscription_id` is absent or blank |
| `unsupported_correction` | The record carries `corrects`; Lago cannot restate an event |
| `missing_metric_code` | The record has no `attribution.feature_id` and no `metricCode` is set, or the `metricCode` function chose no code |
| `invalid_metric_code` | The `metricCode` function chose an invalid code for the record, or threw |
| `invalid_timestamp` | `timing.event_time` is not an RFC 3339 instant on or after the Unix epoch |
| `invalid_field:/record_id` | `record_id` is not a non-empty string |
| `unencodable_field:<pointer>` | The field at the JSON pointer cannot be a Lago property, see [Flattening](#flattening) |
| `unencodable_record` | The record lacks the structure the encoder reads |
| `duplicate_record_id` | Several records of the batch share a `record_id` and differ in content |
| `<field>:<code>` | Lago refused the event, see [Validation responses](#validation-responses) |
| `auth`, `forbidden`, `payload_too_large`, `too_many_events`, `http_<status>` | Lago refused the request that carried the record, after another record of the batch had reached an outcome, see [Batch results](#batch-results) |

Records that repeat an earlier record of the batch byte for byte share that record's event
and its outcome. Records that share a `record_id` but differ are all rejected, because Lago
keeps one event per `transaction_id` and sending either would silently discard the other.

## Responses

A batch is sent as sequential requests of at most 100 events, Lago's documented maximum.
Each HTTP response becomes part of one `BatchResult`.

| Response | Effect | `detail` |
| --- | --- | --- |
| `200` | The request's events are accepted | |
| Any other `2xx` | The request's events are unknown, without a retry | |
| `422` | The events the body names are settled and the others are resent, see [Validation responses](#validation-responses) | `http_422` when the body cannot be trusted, `too_many_events` when the request exceeds the instance's limit |
| `401` | Permanent failure | `auth` |
| `403` | Permanent failure | `forbidden` |
| `413` | Permanent failure | `payload_too_large` |
| `408`, `429`, `500`–`599` | Retryable failure, once `retry` is exhausted | `http_<status>` |
| Network error or timeout | Retryable failure, once `retry` is exhausted | the system error code or error class name |
| Any other status, redirects included | Permanent failure | `http_<status>` |

- A `200` confirms that Lago ingested the events, not that it billed them. Lago ingests and
  then skips an event whose `external_subscription_id` matches no active subscription, whose
  `code` matches no billable metric, whose subscription has terminated, or whose
  `timestamp` precedes the subscription start. The sink cannot observe the skip.
- Lago documents only `200` for the batch endpoint. Another `2xx`, from Lago or a proxy in
  front of it, neither confirms nor refuses the events, so they are reported `unknown`.
- A permanent failure is Lago's verdict on the request, and a retryable failure is not.
  [Batch results](#batch-results) describes how each is reported when another record of the
  batch has an outcome.
- A `413` fails the request. Lower the client's `batchMaxSize` to send fewer records per
  request. That bounds the record count, not the byte size; a single record too large on
  its own cannot be delivered.
- A self-hosted Lago accepts at most `LAGO_EVENTS_BATCH_MAX_LENGTH` events in one request,
  100 by default, and answers a larger request with a `422` naming `too_many_events`. The
  request fails with detail `too_many_events`; set the client's `batchMaxSize` to the
  instance's limit or lower.
- Response bodies are never copied into results, logs or exceptions.

### Validation responses

Lago validates a request as a unit. When any event is invalid, Lago ingests no event of the
request, and the `422` body maps the position of each refused event in the request to the
errors found:

```json
{
  "status": 422,
  "error": "Unprocessable Entity",
  "code": "validation_errors",
  "error_details": { "1": { "transaction_id": ["value_already_exist"] } }
}
```

The sink acts on a `422` only when every key of `error_details` is a canonical position
inside the request and every entry is either a message or lists at least one error code per
field. Otherwise the body cannot be matched to the request, and the request fails
permanently with detail `http_422`.

For a trusted body, each named event is settled:

- An event whose only error is `value_already_exist` on `transaction_id` is already held
  by Lago. It counts as delivered.
- An event named by a message instead of error codes is rejected with detail
  `event:expression_evaluation_failed`. Lago reports an event this way when the billable
  metric's expression cannot be evaluated for it, for example because the expression
  refers to a property that the record does not carry. The message is never read.
- Any other event is rejected, with a detail that joins the field and the code, such as
  `timestamp:invalid_format`. Fields and codes outside the sink's known lists are reported
  as `event` and `validation_error`, so a detail never repeats text from the response.

The events that were not named are resent, which can produce another `422`. At most three
such responses are acted on for one request. A fourth ends the request, and the events it
still holds are reported `unknown`: Lago did not name them as invalid, so delivering them
again can succeed.

A `422` whose `error_details` lists `too_many_events` under `events` refuses the request for
its size, not for any one event; see [Responses](#responses).

## Idempotency

A replay of a delivered record must neither be billed twice nor fail. Lago's two event
stores de-duplicate differently.

| | Postgres event store | ClickHouse event store |
| --- | --- | --- |
| De-duplication key | `transaction_id` and `external_subscription_id` | `transaction_id`, `timestamp`, `external_subscription_id` and `code` |
| A repeated event | Rejected with `422` and `value_already_exist` | Accepted with `200`; the latest copy replaces the earlier one |
| Sink behaviour | Counts the record as delivered | Nothing to do |

- The sink serializes each request body once and resends it unchanged after a transient
  failure. A retry carries the same `transaction_id` and `timestamp`, which both stores
  treat as the same event.
- Replaying a record with the same `record_id` and the same `timing.event_time` is safe on
  both stores. A replay with a different `timing.event_time` is a distinct event on the
  ClickHouse store and is billed again. Keep `record_id` and `timing.event_time` stable
  across replays.
- The same holds for the metric code. A replay under another code, because the record's
  `feature_id` or the `metricCode` function or option changed, is billed again on the ClickHouse store, and
  is dropped as a duplicate on the Postgres store, where the event keeps its first code.
- A restated record, one that carries `corrects`, is rejected locally. Postgres rejects a
  second event under one `transaction_id`, and ClickHouse replaces an event only when the
  `timestamp` matches, so a correction has no consistent meaning across the two.

## Batch results

Requests of one batch are sent in order, and every record ends in exactly one state:
confirmed, rejected, or unknown. The sink answers one `BatchResult`:

| Situation | Result |
| --- | --- |
| Every request settled | `accepted`, naming every rejected record in `rejected` |
| Sending stopped, and some record was already confirmed or rejected | `accepted`. The records of a request that failed permanently are in `rejected` with the failure's detail; the records that never reached an outcome are in `unknown` |
| Sending stopped, and no record had an outcome | `failed`, retryable or permanent as in [Responses](#responses); `closed` when the sink was closed |
| Lago answered a `2xx` other than `200` | `accepted`, with that request's records and those of later requests in `unknown` |
| The caller aborted through `DeliverOptions.signal` | `accepted` with the unresolved records in `unknown`, or `closed` when the sink was closed |
| An unexpected error occurred while sending | As for any other stop: records with an outcome keep it and the rest are `unknown`; `failed` with detail `internal_error` when no record had an outcome |

Sending stops at the first request that fails, and the events of later requests are then
`unknown`, because their delivery was never attempted. The events of the failed request
itself are `rejected` when the failure is permanent, since Lago refused them, and `unknown`
when it is retryable, since Lago may have ingested them before the answer was lost. A
confirmed record is never relabelled by a later failure, since `BatchResult` applies a
failure to the whole batch. `unknown` records are safe to deliver again.

## Retries

| `retry` field | Default | Purpose |
| --- | --- | --- |
| `maxAttempts` | `3` | Attempts per request, including the first; an integer of at least 1 |
| `initialBackoffMs` | `500` | Ceiling of the delay before the first retry |
| `maxBackoffMs` | `30000` | Upper bound on any delay, a server hint included |
| `multiplier` | `2` | Exponential growth factor, at least 1 |

Delays use full-jitter exponential backoff. The sink raises a delay to the longest hint
that the response carries, then caps it at `maxBackoffMs`. `Retry-After`, in seconds or as
an HTTP date, is honoured on every retried status. `X-RateLimit-Reset`, the seconds until
Lago's rate-limit window resets, is honoured on `429`. Retries happen inside `deliver()`.

## Cancellation and shutdown

`deliver(batch, { signal })` stops sending when the signal aborts, including during a
request or a backoff. The sink never retries a request that the caller aborted.

`close()` is idempotent and never throws. It aborts any request in flight, waits for it to
settle, and makes later deliveries answer `closed`. A batch that closing interrupts is
reported as in [Batch results](#batch-results).

## Diagnostics

The sink logs nothing unless `logger` is set. Messages are prefixed `audr-sink-lago:` and
carry status codes and event counts; they never contain a record value, a response body or
a credential. A logger that throws cannot disturb delivery.

| Level | When |
| --- | --- |
| `error` | The API key was rejected (`401`) or is not permitted to ingest events (`403`) |
| `error` | An unexpected internal failure; the batch is answered as in [Batch results](#batch-results), as a permanent failure with detail `internal_error` only when no record had an outcome |
| `warn` | A request was refused as too large or as too many events, rejected permanently, or ended on a transient status after its last attempt |
| `warn` | Lago answered a `2xx` other than `200` |
| `warn` | Lago refused or already held events of a request, or refused a request again after three resends |
| `warn` | A validation response could not be matched to the request |
| `warn` | A delivery was aborted by the caller, or the sink was closed |

`String(sink)` and `util.inspect(sink)` render the endpoint only.

## Runtime support

Node.js 22.12 or later. ESM only, with type declarations.
