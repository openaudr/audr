# audr

[![PyPI](https://img.shields.io/pypi/v/audr?include_prereleases)](https://pypi.org/project/audr/)
[![Python versions](https://img.shields.io/pypi/pyversions/audr)](https://pypi.org/project/audr/)

The **core Python SDK** for [AUDR](https://openaudr.dev/spec/v1.0.0/) (Agent Usage Detail
Record) builds records, validates them against the published schema, and delivers them to
any `Sink`, such as a file, a queue or a metering backend, through a bounded, batching
async pipeline. Adapters and sinks build on it, and an application can emit records with
this package alone.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
pip install audr
```

Requires Python 3.11 or later.

## Usage

```python
import asyncio
import audr

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
    attribution=audr.Attribution(environment="production", account_id="acct_42"),
)  # record_id and spec_version defaulted


async def main() -> None:
    async with audr.Client(
        audr.FileSink("audr.jsonl"),
        emitter=audr.Emitter(component="harness", name="my-harness", version="1.4.0"),
    ) as client:
        result = client.record(record)
        assert result.queued, result.issues
    print(client.stats)


asyncio.run(main())
```

`client.record()` validates and queues the record and returns at once; a background worker
batches records and hands each batch to the sink. Leaving the `async with` block drains the
queue and closes the sink. Runnable versions, including a custom sink, are in
[`examples/`](https://github.com/openaudr/audr/tree/main/adapters/core/python/examples).

> [!IMPORTANT]
> Delivery problems never raise from `client.record()`. Check the returned `SubmitResult`,
> pass `on_failure` to `Client` to receive every record that was not delivered, and read
> `client.stats` for totals.

## Validation

Records arriving as JSON are parsed and validated by `AUDR.from_json()`, which raises
`audr.ValidationError` carrying one issue per problem:

```python
import audr

payload = '{"spec_version": "1.0.0", "resource": {"type": "model"}}'
try:
    record = audr.AUDR.from_json(payload)
except audr.ValidationError as error:
    for issue in error.issues:
        print(issue.code, issue.path)  # for example: REQUIRED /timing
```

Each issue carries a stable `ErrorCode` and a JSON-pointer `path`, never the offending
value, so issues are safe to log. `record.validate()` returns the same issues for a record
built in code.

## Delivery

| `BatchResult` from the sink | Each record becomes |
| --- | --- |
| `ACCEPTED` | `sent`, except records the sink names as `rejected` (`dropped`) or `unknown` |
| `RETRYABLE_FAILURE`, `PERMANENT_FAILURE`, `CLOSED` | `dropped` |

Every record admitted through `client.record()` ends in exactly one of `sent`, `dropped`
or `unknown`. An `unknown` record may or may not have arrived, so a consumer that
de-duplicates on `record_id` can replay it safely. The pipeline never retries; retrying is
the sink's responsibility. `FileSink` flushes once per batch, and when a write fails part
way, the batch is reported retryable while the lines already written remain in the file.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/core/python/docs/reference.md): client options, submission outcomes, callbacks, the sink contract, validation codes, testing helpers
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/core/python/examples): runnable offline, against the local filesystem
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/core/python/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
