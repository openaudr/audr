# AGENTS.md

Guidance for working in this package. Rules for every sink are in
[`sinks/AGENTS.md`](../../AGENTS.md). Setup, the shared Python toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this sink into an application, see [`README.md`](README.md); this file covers
changes to the package itself.

## What this is

`sinks/chargebee/python` is the `audr-sink-chargebee` distribution: an HTTP sink that
delivers `audr.AUDR` record batches to a Chargebee site's usage-ingest batch endpoint
for Usage-Based Billing. It implements the sink contract defined in
[`adapters/core/README.md`](../../../adapters/core/README.md#the-sink-contract).

Update [`docs/reference.md`](docs/reference.md) when public behaviour changes.
Live integration tests must not run in CI.

## Rules

1. `api_key` is always required. Explicit arguments take precedence over `CHARGEBEE_SITE`,
   `CHARGEBEE_API_KEY`, `CHARGEBEE_INGEST_DOMAIN` and `CHARGEBEE_INGEST_URL`. `ingest_url`
   is mutually exclusive with `site` and `ingest_domain`.
2. Chargebee routes on `attribution.subscription_id`. Return a record without one as
   `RejectedRecord(record_id, "missing_subscription_id")`; never send it.
3. `record_id` is Chargebee's `deduplication_id`, and `timing.event_time` in milliseconds
   is `usage_timestamp`. A replay keyed on `record_id` is idempotent.
4. Flatten and forward every field of the record, including `attribution.labels` and
   `x_*` extensions. Keep property names reversible and identical to the TypeScript sink;
   the separator defaults to `__` and is one or more underscores.
5. A change to the status-to-outcome mapping in `_sink.py` must update the
   [Responses table](docs/reference.md#responses) in the same change. When a `207`
   failure cannot be matched to a record, mark every non-rejected record in the batch
   `unknown`. Retries are bounded by `RetryPolicy`.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-python-toolchain). Specific to this
package:

- **Runtime deps:** `audr`, `httpx`.
- **Version:** `src/audr_sink_chargebee/_version.py`.
- **Tests:** the default run makes no network call and `test_no_live_network.py` enforces
  it. The `live` marker requires `CHARGEBEE_INGEST_URL`, `CHARGEBEE_API_KEY` and
  `CHARGEBEE_TEST_SUBSCRIPTION_ID` and is run deliberately with `uv run pytest -m live`.

`make verify` is `lint test isolation`.
