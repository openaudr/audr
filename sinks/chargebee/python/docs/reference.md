# Reference

Complete behaviour of `audr-sink-chargebee`. The
[README](https://github.com/openaudr/audr/blob/main/sinks/chargebee/python/README.md) covers
setup and usage.

## Options

`ChargebeeSink` takes keyword arguments only.

| Option | Default | Purpose |
| --- | --- | --- |
| `site` | `CHARGEBEE_SITE` | Chargebee site name, the `{site}` subdomain of the ingest domain |
| `api_key` | `CHARGEBEE_API_KEY` | Site API key; always required |
| `ingest_domain` | `CHARGEBEE_INGEST_DOMAIN`, then `ingest.chargebee.com` | Domain the site subdomain is joined to |
| `ingest_url` | `CHARGEBEE_INGEST_URL` | Full ingest origin; mutually exclusive with `site` and `ingest_domain` |
| `retry` | `RetryPolicy()` | Retry budget and backoff, see [Retries](#retries) |
| `http` | `HttpTransportConfig()` | Timeouts and connection pool, see [Transport](#transport) |
| `separator` | `"__"` | Joins flattened path segments; one or more underscores |
| `transport` | `None` | An `httpx.AsyncBaseTransport`, for tests or custom networking |

Explicit arguments take precedence over environment variables. An invalid combination or
value raises `audr.ConfigurationError` from the constructor.

```python
from audr_sink_chargebee import ChargebeeSink, HttpTransportConfig, RetryPolicy

sink = ChargebeeSink(
    site="acme",
    api_key="cb_test_key",
    retry=RetryPolicy(max_attempts=5, initial_backoff=1.0),
    http=HttpTransportConfig(read_timeout=20.0),
    separator="__",
)
```

## Flattening

`flatten_audr(record, separator="__")` produces the `properties` of each usage event.

- A nested object becomes one property per leaf, its path joined by the separator:
  `usage.llm.input_tokens` becomes `usage__llm__input_tokens`.
- An array, and the caller-keyed `attribution.labels` map, become one canonical JSON
  string under a terminal `json` segment: `attribution__labels__json`.
- Every field is forwarded, including `x_*` extensions.

The default `__` keeps path boundaries distinct from the underscores inside AUDR field
names, so every property name maps back to exactly one field. Chargebee property names may
contain only letters, digits and underscores, so the separator must be one or more
underscores. The TypeScript sink emits the same names, so both can deliver to one site.

## Responses

Each HTTP response becomes one `audr.BatchResult`.

| Response | Outcome | `detail` |
| --- | --- | --- |
| `202`, `207` | `ACCEPTED`; `rejected` and `unknown` name individual records | |
| `401` | `PERMANENT_FAILURE` | `auth` |
| `413` | `PERMANENT_FAILURE` | `payload_too_large` |
| `408`, `429`, `500`, `502`, `503`, `504` | `RETRYABLE_FAILURE`, once `retry` is exhausted | `http_<status>` |
| Network error or timeout | `RETRYABLE_FAILURE`, once `retry` is exhausted | the exception class name |
| Any other status | `PERMANENT_FAILURE` | `http_<status>` |

- A `413` fails the whole batch and drops every record in it. Lower
  `audr.Client(batch_max_size=...)` to send fewer records per request. That bounds the
  record count, not the byte size; a single record too large on its own cannot be
  delivered.
- When a `207` body names a failed event that cannot be matched to a record in the batch,
  an unrecognised or duplicated `deduplication_id`, every non-rejected record in the batch
  is reported `unknown` rather than assumed accepted.
- A record without `attribution.subscription_id` is returned as
  `RejectedRecord(record_id, "missing_subscription_id")` and never sent.

## Retries

`RetryPolicy` bounds the attempts for each batch.

| Field | Default | Purpose |
| --- | --- | --- |
| `max_attempts` | `3` | Attempts per batch, including the first; at least 1 |
| `initial_backoff` | `0.5` | Seconds before the first retry |
| `max_backoff` | `30.0` | Upper bound on any delay, in seconds |
| `multiplier` | `2.0` | Exponential growth factor; at least 1 |

Delays use full-jitter exponential backoff and honour a valid `Retry-After` header, capped
at `max_backoff`.

## Transport

`HttpTransportConfig` configures the shared `httpx.AsyncClient`, created on first use.

| Field | Default |
| --- | --- |
| `connect_timeout` | `5.0` |
| `read_timeout` | `10.0` |
| `write_timeout` | `10.0` |
| `pool_timeout` | `5.0` |
| `max_connections` | `10` |
| `max_keepalive_connections` | `5` |

Timeouts are in seconds. `close()` closes the client once and is idempotent.

## Diagnostics

The sink logs to the `audr_sink_chargebee._sink` logger through the standard `logging`
module. Messages carry status codes, batch sizes and the ingest origin; they never contain
a record value or a credential.

| Level | When |
| --- | --- |
| `ERROR` | The API key was rejected (`401`) |
| `WARNING` | A batch was refused as too large, rejected permanently, or sent after `close()` |
| `WARNING` | A `207` body was unparseable or named events that could not be matched to the batch |
