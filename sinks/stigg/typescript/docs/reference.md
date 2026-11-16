# Reference

Complete behaviour of `@openaudr/audr-sink-stigg`. The
[README](https://github.com/openaudr/audr/blob/main/sinks/stigg/typescript/README.md)
covers setup and usage.

## Options

`new StiggSink(options)` takes one options object.

| Option | Default | Purpose |
| --- | --- | --- |
| `apiKey` | `STIGG_API_KEY` | Stigg server API key, sent as the `X-API-KEY` header; always required. It selects the Stigg environment |
| `eventName` | none | The Stigg event name every record is sent under; always required |
| `apiUrl` | `STIGG_API_URL`, then `https://api.stigg.io` | Stigg API origin, an origin with `/api/v1`, or the full events URL |
| `retry` | see [Retries](#retries) | Retry budget and backoff |
| `timeoutMs` | `10000` | Deadline for each HTTP request, in milliseconds |
| `fetch` | `globalThis.fetch` | Replaces `fetch`, for example with one backed by an undici `Agent` for connection-pool tuning |
| `logger` | none | Receives diagnostics; any object with `warn` and `error`, such as `console` |

Explicit options take precedence over environment variables. An invalid value throws
`ConfigurationError` from the constructor; its message names the option and never repeats
the value.

```ts
import { StiggSink } from '@openaudr/audr-sink-stigg';

const sink = new StiggSink({
  apiKey: process.env.STIGG_API_KEY,
  eventName: 'ai.usage',
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
| `https://api.stigg.io` | `https://api.stigg.io/api/v1/events` |
| `https://api.stigg.io/api/v1` | `https://api.stigg.io/api/v1/events` |
| `https://api.stigg.io/api/v1/events` | unchanged |

A trailing slash is ignored. The URL must use `https` and a lowercase dotted host name. It
must not carry a port, userinfo, a query string, a fragment, a backslash or an
internationalised host name. The API key is sent to the resulting endpoint only,
and the sink never follows a redirect.

`apiKey` is a non-empty string of printable ASCII characters without spaces. Use a server
key: Stigg's client and publishable keys cannot report usage.

### Event name

Every event carries the name `eventName` gives it. An event never names a Stigg feature: each
metered feature's meter selects events with conditions on `eventName` and on dimensions, and
every meter whose conditions an event matches counts it. One name may therefore feed several
features. The record's `attribution.feature_id` is an ordinary dimension,
`attribution__feature_id`, that a meter condition can filter on.

A name is valid when it is non-empty, has no leading or trailing whitespace, is at most 255
characters, and is not one Stigg reserves for events it creates (`$usage.reported`,
`$usage.ingested`, `usage.credit`). A name that is not valid throws `ConfigurationError`
from the constructor. To split usage across features, add meter conditions on dimensions
such as `attribution__feature_id`.

## Event mapping

Every record becomes one event of Stigg's `POST /api/v1/events`.

| Stigg event field | Source |
| --- | --- |
| `eventName` | the `eventName` option |
| `customerId` | `attribution.account_id` |
| `idempotencyKey` | `record_id` |
| `timestamp` | `timing.event_time`, converted to UTC with millisecond precision, such as `"2026-10-29T12:00:00.000Z"` |
| `dimensions` | the flattened record, see [Flattening](#flattening) |

- Stigg accepts only a UTC (`Z`) timestamp and refuses an offset such as `+02:00`, which
  AUDR permits; the sink converts it. Stigg defaults a missing timestamp to the ingestion
  time, so the sink always sends one, so that a retry reproduces the original event.
- Stigg checks `customerId` against `^[a-zA-Z0-9][a-zA-Z0-9_|.@-]*$`, at most 255
  characters. The sink applies the same check before sending.
- The sink never sends `resourceId`, so usage counts toward the customer's customer-level
  subscriptions. `attribution.subscription_id` is forwarded as the
  `attribution__subscription_id` dimension, which a meter condition can filter on.
- One record becomes one event. The sink never computes a price: a record's `cost` fields
  are forwarded as ordinary dimensions, which a credit formula can read.

## Flattening

`flattenRecord(record)` produces the `dimensions` of an event.

- A nested object becomes one dimension per leaf, its path joined by `__`:
  `usage.llm.input_tokens` becomes `usage__llm__input_tokens`.
- Each `attribution.labels` entry becomes one dimension, `attribution__labels__<key>`, with
  the key verbatim.
- An array becomes one canonical JSON string under a terminal `json` segment. Canonical
  means sorted keys and no whitespace, so equal values produce equal strings.
- Strings, finite numbers and booleans are kept as they are. Stigg stores every dimension
  value as a string and parses numbers back for numeric aggregations.
- Every field is forwarded, including `x_*` extensions.
- A leaf that is `null` or a non-finite number cannot be a Stigg dimension. The record is
  rejected with detail `unencodable_field:<pointer>`, where the pointer is the record
  field's JSON pointer. Inside an array, every JSON value is kept except a non-finite
  number.

The separator is `__` and cannot be changed. It keeps path boundaries distinct from the
underscores inside AUDR field names, so every dimension name maps back to exactly one field,
and a meter or credit formula that refers to a name keeps working across releases.

## Record rejections

A record is returned in `rejected` with one of these details. A record that cannot become a
valid event is rejected locally and never sent; the other records of the batch are
unaffected.

| `detail` | Cause |
| --- | --- |
| `unsupported_correction` | The record carries `corrects`; Stigg usage is append-only |
| `missing_customer_id` | The record has no `attribution.account_id` |
| `invalid_customer_id` | `attribution.account_id` does not match Stigg's customer ID pattern |
| `invalid_field:/record_id` | `record_id` is not a non-empty string of at most 255 characters |
| `invalid_timestamp` | `timing.event_time` is not an RFC 3339 instant in the years 0000–9999 |
| `unencodable_field:<pointer>` | The field at the JSON pointer cannot be a Stigg dimension, see [Flattening](#flattening) |
| `dimensions_too_large` | The flattened record exceeds Stigg's 1 MiB limit on an event's dimensions |
| `unencodable_record` | The record lacks the structure the encoder reads |
| `duplicate_record_id` | Several records of the batch share a `record_id` and differ in content |
| `bad_user_input:<field>`, `bad_user_input` | Stigg refused the event, see [Validation responses](#validation-responses) |
| `auth`, `forbidden`, `not_found`, `payload_too_large`, `http_<status>` | Stigg refused the request that carried the record, after another record of the batch had reached an outcome, see [Batch results](#batch-results) |

Records that repeat an earlier record of the batch byte for byte share that record's event
and its outcome. Records that share a `record_id` but differ are all rejected: Stigg accepts
duplicate idempotency keys inside one request and keeps one, so sending either would
silently discard the other.

## Responses

A batch is sent as sequential requests of at most 1,000 events, Stigg's maximum. Each HTTP
response becomes part of one `BatchResult`.

| Response | Effect | `detail` |
| --- | --- | --- |
| `202`, `200` | The request's events are accepted | |
| Any other `2xx` | The request's events are unknown, without a retry | |
| `400` | The events the message names are rejected and the others are resent, see [Validation responses](#validation-responses) | `bad_user_input` when the message cannot be matched to the request |
| `401` | Permanent failure | `auth` |
| `403` | Permanent failure | `forbidden` |
| `404` | Permanent failure: the request did not reach the events endpoint, which never answers `404` for an unknown event or customer. Check `apiUrl` | `not_found` |
| `413` | Permanent failure | `payload_too_large` |
| `408`, `409`, `429`, `500`–`599` | Retryable failure, once `retry` is exhausted | `http_<status>` |
| Network error or timeout | Retryable failure, once `retry` is exhausted | the system error code or error class name |
| Any other status, redirects included | Permanent failure | `http_<status>` |

- A `202` confirms that Stigg queued the events, not that a meter counted them. Stigg
  accepts an event for a customer it does not know, and a meter counts an
  event only when the customer has a subscription or credit grant whose feature selects
  it. The sink cannot observe this.
- Stigg rate-limits reporting at about 1,000 events per second for an API key and answers
  `429` with a `Retry-After` in seconds. The sink waits at least that long before it retries.
- A permanent failure is Stigg's verdict on the request, and a retryable failure is not.
  [Batch results](#batch-results) describes how each is reported when another record of the
  batch has an outcome.
- A `413` fails the request. Lower the client's `batchMaxSize` to send fewer records per
  request.
- Response bodies are never copied into results, logs or exceptions.

### Validation responses

Stigg validates a request as a unit. When any event breaks its schema, Stigg queues no
event of the request and answers `400` with one readable message that names the position of
each event at fault:

```json
{
  "code": "BadUserInput",
  "message": "Validation error: String must match pattern at \"events[1].customerId\""
}
```

The sink acts on a `400` only when its `code` is `BadUserInput` and the message names at
least one event, every one a canonical position inside the request. Otherwise the message
cannot be matched to the request, and the request fails permanently with detail
`bad_user_input`. The local checks in [Record rejections](#record-rejections) mirror Stigg's
schema, so a `400` is rare.

For a trusted message, each event named is rejected, with a detail that names the field
when it is one Stigg defines, such as `bad_user_input:customerId`, and `bad_user_input`
otherwise, so a detail never repeats text from the response. The events that were not
named are resent, which can produce another `400`. At most three such responses are acted on
for one request. A fourth ends the request, and the events it still holds are reported
`unknown`: Stigg did not name them as invalid, so delivering them again can succeed.

## Idempotency

A replay of a delivered record must not be counted twice. Stigg treats two events as the
same when their `timestamp`, `customerId`, `eventName` and `idempotencyKey`
are all equal, and keeps the first.

- The sink serializes each request body once and resends it unchanged after a transient
  failure, so a retry is the same event.
- Replaying a record with the same `record_id`, `timing.event_time`, account
  and event name is safe. A replay that changes any of them is a distinct event and is
  counted again. Keep them stable across replays, and keep an `eventName` function
  deterministic.
- Stigg documents the de-duplication window as at least seven days.
- A restated record, one that carries `corrects`, is rejected locally: Stigg usage is
  append-only, so an event can be neither replaced nor voided.
- The sink does not merge records that share `(run.run_id, run.span_id)`. Records for the
  same call from different emitters, such as a harness and a router, each become an event.
- The Stigg Agent SDK (`@stigg/agent-sdk-js`) reports the usage it measures to Stigg itself.
  Its AUDR records must not be delivered to this sink, or every call is counted twice.

## Batch results

Requests of one batch are sent in order, and every record ends in exactly one state:
confirmed, rejected, or unknown. The sink answers one `BatchResult`:

| Situation | Result |
| --- | --- |
| Every request settled | `accepted`, naming every rejected record in `rejected` |
| Sending stopped, and some record was already confirmed or rejected | `accepted`. The records of a request that failed permanently are in `rejected` with the failure's detail; the records that never reached an outcome are in `unknown` |
| Sending stopped, and no record had an outcome | `failed`, retryable or permanent as in [Responses](#responses); `closed` when the sink was closed |
| Stigg answered a `2xx` other than `202` or `200` | `accepted`, with that request's records and those of later requests in `unknown` |
| The caller aborted through `DeliverOptions.signal` | `accepted` with the unresolved records in `unknown`, or `closed` when the sink was closed |
| An unexpected error occurred while sending | As for any other stop: records with an outcome keep it and the rest are `unknown`; `failed` with detail `internal_error` when no record had an outcome |

Sending stops at the first request that fails, and the events of later requests are then
`unknown`, because their delivery was never attempted. The events of the failed request
itself are `rejected` when the failure is permanent, since Stigg refused them, and
`unknown` when it is retryable, since Stigg may have queued them before the answer was lost.
A confirmed record is never relabelled by a later failure. `unknown` records are safe to
deliver again.

## Retries

| `retry` field | Default | Purpose |
| --- | --- | --- |
| `maxAttempts` | `3` | Attempts per request, including the first; an integer of at least 1 |
| `initialBackoffMs` | `500` | Ceiling of the delay before the first retry |
| `maxBackoffMs` | `30000` | Upper bound on any delay, a server hint included |
| `multiplier` | `2` | Exponential growth factor, at least 1 |

Delays use full-jitter exponential backoff. A `Retry-After` header, in seconds or as an HTTP
date, raises a delay to the time it asks for, capped at `maxBackoffMs`; Stigg sends one with
every `429`. `409` is retried, as Stigg's own SDKs retry it. Retries happen inside `deliver()`.

## Cancellation and shutdown

`deliver(batch, { signal })` stops sending when the signal aborts, including during a
request or a backoff. The sink never retries a request that the caller aborted.

`close()` is idempotent and never throws. It aborts any request in flight, waits for it to
settle, and makes later deliveries answer `closed`. A batch that closing interrupts is
reported as in [Batch results](#batch-results).

## Diagnostics

The sink logs nothing unless `logger` is set. Messages are prefixed `audr-sink-stigg:` and
carry status codes and event counts; they never contain a record value, an event name, a
response body or a credential. A logger that throws cannot disturb delivery.

| Level | When |
| --- | --- |
| `error` | The API key was rejected (`401`) or is not permitted to report events (`403`), or the events endpoint was not found (`404`) |
| `error` | An unexpected internal failure; the batch is answered as in [Batch results](#batch-results), as a permanent failure with detail `internal_error` only when no record had an outcome |
| `warn` | A request was refused as too large, rejected permanently, or ended on a transient status after its last attempt |
| `warn` | Stigg answered a `2xx` other than `202` or `200` |
| `warn` | Stigg refused events of a request, or refused a request again after three resends |
| `warn` | A validation response could not be matched to the request |
| `warn` | A delivery was aborted by the caller, or the sink was closed |

`String(sink)` and `util.inspect(sink)` render the endpoint only.

## Runtime support

Node.js 22.12 or later. ESM only, with type declarations.
