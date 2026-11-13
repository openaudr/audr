# audr-adapter-langfuse

[![PyPI](https://img.shields.io/pypi/v/audr-adapter-langfuse?include_prereleases)](https://pypi.org/project/audr-adapter-langfuse/)
[![Python versions](https://img.shields.io/pypi/pyversions/audr-adapter-langfuse)](https://pypi.org/project/audr-adapter-langfuse/)

The **AUDR span processor** for [Langfuse](https://langfuse.com) turns every generation,
embedding, tool and retriever observation recorded through the Langfuse Python SDK into one
[AUDR](https://openaudr.dev) record for an `audr.Client` your application owns. Because it
observes the Langfuse layer, one processor meters every integration that reports through
the SDK: the `langfuse.openai` drop-in, the LangChain `CallbackHandler`,
`@observe(as_type="generation")` and manual observations. It reads usage, cost,
identifiers and timings only: never observation input or output, prompts, completions or
error messages.

> **Status: alpha.** The record model follows AUDR specification 1.x; until this package
> reaches 1.0.0, a minor release may change the public API.

## Setup

```bash
pip install "audr-adapter-langfuse[runtime]"
```

Requires Python 3.11 or later and `langfuse` 5.2 or later within 5.x, which the `runtime`
extra installs. The Langfuse SDK is built on OpenTelemetry; the adapter is an OpenTelemetry
`SpanProcessor` added to the same `TracerProvider` as Langfuse's own processor. Langfuse and
OpenTelemetry are imported when `LangfuseAudrProcessor` is first accessed, not when
`audr_adapter_langfuse` is imported.

## Usage

Construct the processor on the running event loop that owns the `Client`, add it to a
`TracerProvider`, and hand that provider to the Langfuse client:

```python
import asyncio

from audr import Attribution, Client, FileSink
from audr_adapter_langfuse import LangfuseAudrProcessor, LangfuseConfig
from langfuse import Langfuse, propagate_attributes
from opentelemetry.sdk.trace import TracerProvider


async def main() -> None:
    async with Client(FileSink("audr.jsonl")) as client:
        processor = LangfuseAudrProcessor(
            client=client,
            config=LangfuseConfig(
                provider="openai",
                attribution_defaults=Attribution(environment="production"),
            ),
        )
        tracer_provider = TracerProvider()
        tracer_provider.add_span_processor(processor)
        langfuse = Langfuse(tracer_provider=tracer_provider)  # keys from LANGFUSE_* variables
        try:
            with propagate_attributes(metadata={"audr_account_id": "acct_42"}):
                with langfuse.start_as_current_observation(
                    name="answer", as_type="generation", model="gpt-4o-mini"
                ) as generation:
                    generation.update(usage_details={"input": 120, "output": 40})
        finally:
            langfuse.shutdown()
            await processor.drain(timeout=5)
            processor.close()


asyncio.run(main())
```

Leaving the `async with` block drains the client's queue and closes its sink. A runnable
version that keeps Langfuse offline is
[`examples/observe_generation.py`](https://github.com/openaudr/audr/blob/main/adapters/langfuse/python/examples/observe_generation.py).

> [!IMPORTANT]
> The processor meters only spans the provider records. Configure the `TracerProvider` you
> pass to Langfuse to sample every billed trace: Langfuse's own `sample_rate` does not apply
> to a provider you supply. A Langfuse client that is disabled, because its keys are missing
> or `tracing_enabled=False`, creates no spans, and no record is produced. Shut down in this
> order: `langfuse.shutdown()` (or `langfuse.flush()`), `await processor.drain()`,
> `processor.close()`, then the client; the
> [shutdown order](https://github.com/openaudr/audr/blob/main/adapters/langfuse/python/docs/reference.md#shutdown-order)
> explains each step.

## Attribution

Attribution is read for each span from `audr_*` metadata keys, field by field: observation
metadata wins over trace metadata set with `propagate_attributes()`, which wins over
`langfuse.environment` (only when it is exactly an AUDR environment), which wins over
`LangfuseConfig.attribution_defaults`. `labels` merge by key. Langfuse experiment runs
(`sdk-experiment`) are attributed to `evaluation`. Flat keys keep each value under
Langfuse's 200-character limit for propagated metadata:

```python
from langfuse import propagate_attributes

with propagate_attributes(
    metadata={
        "audr_environment": "production",
        "audr_account_id": "acct_42",
        "audr_subscription_id": "sub_7",
        "audr_user_id": "u_8f14e45f",  # pseudonymous, never an email or a name
        "audr_feature_id": "support-chat",  # selects the meter the usage is billed against
        "audr_labels": {"team": "support"},
    }
):
    pass  # observations created here carry this attribution
```

- A span with no `environment`, or a `production` span with no `account_id`, is skipped with
  a warning rather than billed to a guess.
- Langfuse's own `user_id` is **not** copied to `attribution.user_id`: applications often
  put an email there. Set `audr_user_id` to a pseudonymous id instead.

## Records

| Langfuse observation type | `resource.operation` | `usage` |
| --- | --- | --- |
| `generation` | `generation` | `llm` tokens, `requests: 1` |
| `embedding` | `embedding` | `llm` tokens, `requests: 1` |
| `tool` | `tool_execution` | `tool`, `type: invocation`, `call_count: 1` |
| `retriever` | `retrieval` | `tool`, `type: retrieval`, `call_count: 1` |

Other types (`span`, `agent`, `chain`, `event`, `evaluator`, `guardrail`) and spans from
other OpenTelemetry instrumentation are not metered.

- **Identifiers.** `run.run_id` and `run.trace_id` are the OpenTelemetry trace id, and
  `run.span_id` and `run.parent_span_id` the span ids, so every observation in one Langfuse
  trace joins.
- **Usage.** Cache reads, cache writes and reasoning are counted apart from
  `input_tokens` and `output_tokens`. Langfuse's exclusive buckets are folded back together,
  so audio and modality counts stay in input and output; raw OpenAI usage, as the
  `langfuse.openai` drop-in records it, and raw Anthropic usage are recognised too. The
  [reference](https://github.com/openaudr/audr/blob/main/adapters/langfuse/python/docs/reference.md#tokens)
  lists every key.
- **Cost.** A generation's or embedding's `cost_details` becomes `cost.total_cost` in USD
  when the application or integration set it on the span. Langfuse's server-side inferred
  cost is never seen, so most records carry no cost.
- **Provider.** Langfuse records no provider. The adapter takes `gen_ai.provider.name`,
  then `gen_ai.system`, then the LangChain `ls_provider` metadata, then
  `LangfuseConfig.provider`. A generation or embedding with none is skipped with a warning.
- **Failures.** A span with status `ERROR` or level `ERROR` carries
  `run.error_code = LANGFUSE_OBSERVATION_ERROR`. Failed tool and retriever spans are always
  recorded; a failed generation or embedding is recorded only when it reported usage or a
  positive cost.

When one model call is recorded as a model span inside another, as with LangChain's
`ChatOpenAI` while the `langfuse.openai` drop-in is imported, only the inner span is
recorded. Running this adapter alongside another AUDR adapter that observes the same calls, such as
the LiteLLM adapter, records each call twice.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/langfuse/python/docs/reference.md): options, span metadata, record fields, shutdown order, diagnostics, operational bounds
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/langfuse/python/examples): runnable offline, without Langfuse keys
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/langfuse/python/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
