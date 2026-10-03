# audr-adapter-litellm

[![PyPI](https://img.shields.io/pypi/v/audr-adapter-litellm?include_prereleases)](https://pypi.org/project/audr-adapter-litellm/)
[![Python versions](https://img.shields.io/pypi/pyversions/audr-adapter-litellm)](https://pypi.org/project/audr-adapter-litellm/)

The **AUDR callback** for [LiteLLM](https://docs.litellm.ai) turns every provider-reported
completion, Responses API, embedding and rerank call made through the LiteLLM Python SDK or
`Router` into one [AUDR](https://openaudr.dev/spec/v1.0.0/) record for an `audr.Client`
your application owns. It reads usage, cost, identifiers and timings only: never prompts,
messages, responses, tool arguments, API keys or exception messages.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
pip install "audr-adapter-litellm[runtime]"
```

Requires Python 3.11 or later and `litellm` 1.95 or later within 1.x, which the `runtime`
extra installs. The LiteLLM Proxy is not supported: it exposes no documented callback
shutdown hook after which the adapter's records are guaranteed to have reached the client.

## Usage

Construct the callback on the running event loop that owns the `Client` and register it
through LiteLLM's callback manager, which keeps any other registered callbacks:

```python
import asyncio

import litellm
from audr import Attribution, Client, FileSink
from audr_adapter_litellm import LiteLLMAudrCallback, LiteLLMConfig


async def main() -> None:
    async with Client(FileSink("audr.jsonl")) as client:
        callback = LiteLLMAudrCallback(
            client=client,
            config=LiteLLMConfig(attribution_defaults=Attribution(environment="production")),
        )
        litellm.logging_callback_manager.add_litellm_callback(callback)
        try:
            await litellm.acompletion(
                model="openai/gpt-4o-mini",
                messages=[{"role": "user", "content": "Where is order 42?"}],
                metadata={"audr": {"attribution": {"account_id": "acct_42"}}},
            )
            # LiteLLM invokes logging callbacks after the call returns; wait up to 5 s.
            for _ in range(500):
                if client.stats.submitted:
                    break
                await asyncio.sleep(0.01)
        finally:
            litellm.logging_callback_manager.remove_callback_from_all_lists(callback)
            await callback.drain(timeout=5)
            callback.close()


asyncio.run(main())
```

Leaving the `async with` block drains the client's queue and closes its sink. Runnable
versions on mock responses, without network access or provider keys, are
[`examples/litellm_completion.py`](https://github.com/openaudr/audr/blob/main/adapters/litellm/python/examples/litellm_completion.py)
and
[`examples/router_fallback.py`](https://github.com/openaudr/audr/blob/main/adapters/litellm/python/examples/router_fallback.py).

> [!IMPORTANT]
> Unregister the callback with `remove_callback_from_all_lists(callback)`. LiteLLM copies
> registered callbacks into internal success and failure lists, so restoring
> `litellm.callbacks` alone leaves the callback active. Then await `drain()` and call
> `close()` before the client shuts down; the
> [shutdown order](https://github.com/openaudr/audr/blob/main/adapters/litellm/python/docs/reference.md#shutdown-order)
> lists every step.

## Attribution

Attribution is resolved for each call from `metadata["audr"]["attribution"]` merged field
by field over `LiteLLMConfig.attribution_defaults`. The request wins, and `labels` merge by
key:

```python
from audr import Attribution
from audr_adapter_litellm import LiteLLMConfig

config = LiteLLMConfig(
    attribution_defaults=Attribution(environment="production", labels={"region": "us"}),
)
metadata = {
    "audr": {
        "attribution": {
            "account_id": "acct_42",
            "user_id": "u_8f14e45f",  # pseudonymous, never an email or a name
            "labels": {"feature": "support-chat"},
        },
        "run": {"run_id": "agent-run-123", "run_type": "agent_run"},
    }
}
# A call made with this metadata carries labels {"region": "us", "feature": "support-chat"}.
```

- `metadata["audr"]` accepts `attribution`, `run` and `resource` objects, and each rejects
  unknown fields. The
  [reference](https://github.com/openaudr/audr/blob/main/adapters/litellm/python/docs/reference.md#request-metadata)
  lists every field.
- A call with no `environment`, or a `production` call with no `account_id`, is skipped
  with a warning rather than billed to a guess.
- Pass the agent's `run_id` so model calls from one agent execution join downstream.
  Without it, the LiteLLM trace or call identifier becomes `run.run_id`.

## Records

| LiteLLM call | `resource.operation` | `usage` |
| --- | --- | --- |
| `completion`, `text_completion`, Responses API | `generation` | `llm` tokens, `requests: 1` |
| `embedding` | `embedding` | `llm` tokens, `requests: 1` |
| `rerank` | `reranking` | `llm` tokens, `requests: 1` |

Cache and reasoning tokens are counted apart from `input_tokens` and `output_tokens`, and
LiteLLM's `response_cost` becomes `cost.total_cost` in USD. The provider-echoed model name
wins over the requested LiteLLM alias. A `Router` fallback chain produces one record, for
the attempt that reported usage.

Not metered: cache hits, failures and abandoned streams without reported usage or a
positive cost, and tool executions, which LiteLLM returns to the application rather than
running.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/litellm/python/docs/reference.md): options, request metadata, record fields, shutdown order, diagnostics, operational bounds
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/litellm/python/examples): runnable on mock responses, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/litellm/python/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
