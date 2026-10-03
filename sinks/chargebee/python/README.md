# audr-sink-chargebee

[![PyPI](https://img.shields.io/pypi/v/audr-sink-chargebee?include_prereleases)](https://pypi.org/project/audr-sink-chargebee/)
[![Python versions](https://img.shields.io/pypi/pyversions/audr-sink-chargebee)](https://pypi.org/project/audr-sink-chargebee/)

The **Chargebee sink** for [AUDR](https://openaudr.dev/spec/v1.0.0/) delivers record batches
from an `audr.Client` to a Chargebee site's usage-ingest batch endpoint, for Chargebee
Usage-Based Billing. Each record becomes one usage event, routed on
`attribution.subscription_id` and de-duplicated on `record_id`.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
pip install audr audr-sink-chargebee
```

Requires Python 3.11 or later.

## Usage

```python
import asyncio
import audr
from audr_sink_chargebee import ChargebeeSink

record = audr.AUDR(
    timing=audr.Timing(duration_ms=812),  # event_time defaults to now
    resource=audr.Resource(
        provider="anthropic",
        type="model",
        name="claude-sonnet-5",
        operation="generation",
        modality="text",
    ),
    usage=audr.Usage(llm=audr.LlmUsage(input_tokens=1200, output_tokens=340, requests=1)),
    run=audr.Run(run_id="01J8ZQ8Y2K3M4N5P6Q7R8S9T0V", span_id="turn-3", run_type="agent_run"),
    attribution=audr.Attribution(
        environment="production", account_id="acct_42", subscription_id="sub_42"
    ),
)


async def main() -> None:
    sink = ChargebeeSink()  # reads CHARGEBEE_SITE and CHARGEBEE_API_KEY
    async with audr.Client(
        sink,
        emitter=audr.Emitter(component="harness", name="my-harness", version="1.4.0"),
    ) as client:
        result = client.record(record)
        assert result.queued, result.issues


asyncio.run(main())
```

Leaving the `async with` block drains the queue and then closes the sink. The `Client`
stamps its `emitter` onto every record that arrives without one; a record that reaches
validation with no emitter is rejected with an `/emitter` issue and never sent. Record
construction is documented in the
[core SDK README](https://github.com/openaudr/audr/blob/main/adapters/core/python/README.md).

> [!IMPORTANT]
> Chargebee routes on `attribution.subscription_id`. A record without one is never sent:
> `deliver()` returns it as `RejectedRecord(record_id, "missing_subscription_id")`.

## Configuration

Configure the sink with `site` and `api_key`. Pass them explicitly or set `CHARGEBEE_SITE`
and `CHARGEBEE_API_KEY`; explicit values take precedence, and `api_key` is always required.
Credentials belong to the sink and never appear in logs, errors or `repr()`. An invalid
configuration raises `audr.ConfigurationError` from the constructor.

The sink sends each batch to `https://{site}.{ingest_domain}/api/v2/batch/usage_events`.
`ingest_domain` defaults to `ingest.chargebee.com`; override it with `ingest_domain=` or
`CHARGEBEE_INGEST_DOMAIN`. For a host that is not a `{site}` subdomain of the ingest
domain, set the full origin with `ingest_url=` or `CHARGEBEE_INGEST_URL`, which is mutually
exclusive with `site` and `ingest_domain`.

## Delivery

| AUDR field | Chargebee usage event |
| --- | --- |
| `attribution.subscription_id` | `subscription_id` |
| `record_id` | `deduplication_id` |
| `timing.event_time` | `usage_timestamp`, in milliseconds |
| Every field, flattened | `properties`, such as `usage__llm__input_tokens` |

Chargebee accepts scalar properties only, so every field is flattened to a reversible name
joined by `__`. Arrays and `attribution.labels` are sent as canonical JSON under a `__json`
suffix, such as `attribution__labels__json`. Create metered features against these names.
`flatten_audr(record)` returns the properties a record becomes before it is sent.

A batch is sent as one request, and each response becomes one `audr.BatchResult`. A
replay keyed on `record_id` is idempotent. The
[reference](https://github.com/openaudr/audr/blob/main/sinks/chargebee/python/docs/reference.md#responses)
maps each response status to an outcome.

This sink forwards **every field of the record**, including `attribution.labels` and any
`x_*` extension, to your Chargebee site verbatim. `attribution.labels` MUST NOT contain
PII and `resource.key_name` is a label, never key material; the
[security policy](https://github.com/openaudr/audr/blob/main/SECURITY.md) holds the full
rules. Enforce them where the record is built, the last point at which they can be
enforced.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/sinks/chargebee/python/docs/reference.md): options, flattening, responses, retries, diagnostics
- [Examples](https://github.com/openaudr/audr/tree/main/sinks/chargebee/python/examples): runnable against a mock ingest endpoint, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/sinks/chargebee/python/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
