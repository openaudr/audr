# audr-adapter-nemo-relay

[![PyPI](https://img.shields.io/pypi/v/audr-adapter-nemo-relay?include_prereleases)](https://pypi.org/project/audr-adapter-nemo-relay/)
[![Python versions](https://img.shields.io/pypi/pyversions/audr-adapter-nemo-relay)](https://pypi.org/project/audr-adapter-nemo-relay/)

The **AUDR plugin** for [NVIDIA NeMo Relay](https://pypi.org/project/nemo-relay/) turns
every completed Relay LLM call and tool execution into one
[AUDR](https://openaudr.dev/spec/v1.0.0/) record for an `audr.Client` your application
owns. It reads usage, identifiers and timings only: never prompts, responses, tool
arguments or tool results.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
pip install "audr-adapter-nemo-relay[runtime]"
```

Requires Python 3.11 or later and `nemo-relay` 0.8 within 0.8.x, which the `runtime` extra
installs. Relay is imported at activation, so importing this package alone leaves it out of
the process.

## Usage

Register the plugin once, then run Relay-managed work inside the plugin context. Every LLM
call made with a response codec, and every tool execution, is then metered:

```python
import asyncio

import nemo_relay
from audr import Attribution, Client, FileSink
from nemo_relay import plugin as relay_plugin
from audr_adapter_nemo_relay import PLUGIN_KIND, NeMoRelayConfig, NeMoRelayPlugin


async def call_model(request: nemo_relay.LLMRequest) -> nemo_relay.JsonValue:
    # Call your provider here; this returns a canned OpenAI Chat Completions response.
    return {
        "model": "gpt-4o-mini",
        "choices": [{"message": {"role": "assistant", "content": "It shipped."}}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 7},
    }


async def main() -> None:
    async with Client(FileSink("audr.jsonl")) as client:
        usage_plugin = NeMoRelayPlugin(client=client)  # on the loop that owns the client
        config = NeMoRelayConfig(attribution_defaults=Attribution(environment="production"))
        relay_config = relay_plugin.PluginConfig(
            components=[relay_plugin.ComponentSpec(kind=PLUGIN_KIND, config=config.to_dict())]
        )
        relay_plugin.register(PLUGIN_KIND, usage_plugin)
        try:
            async with relay_plugin.plugin(relay_config):
                with nemo_relay.scope.scope(
                    "support-agent",
                    nemo_relay.ScopeType.Agent,
                    metadata={"audr": {"account_id": "acct_42", "subscription_id": "sub_7"}},
                ):
                    request = nemo_relay.LLMRequest(
                        {},
                        {
                            "model": "gpt-4o-mini",
                            "messages": [{"role": "user", "content": "Where is order 42?"}],
                        },
                    )
                    await nemo_relay.llm.execute(
                        "openai",
                        request,
                        call_model,
                        model_name="gpt-4o-mini",
                        response_codec=nemo_relay.codecs.OpenAIChatCodec(),
                    )
            await usage_plugin.drain(timeout=5)
        finally:
            relay_plugin.deregister(PLUGIN_KIND)


asyncio.run(main())
```

Leaving the `async with` block drains the client's queue and closes its sink. A runnable
version with a canned model response, without network access or provider keys, is
[`examples/agent_scope.py`](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/examples/agent_scope.py).
[`examples/nemo_relay_chat.py`](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/examples/nemo_relay_chat.py)
is an interactive terminal chat against an OpenAI-compatible endpoint; install the
`example` extra to run it.

> [!IMPORTANT]
> Shut down in order: exit Relay's plugin context, await `usage_plugin.drain()`, then shut
> down the client. Only `deregister` belongs in `finally`. One plugin instance accepts one
> activation; a second would subscribe to the same process-wide event stream and count every
> operation twice.

## Attribution

Attribution is resolved when a root scope starts, from its `metadata["audr"]` merged field
by field over `attribution_defaults`. The scope wins, and `labels` merge by key:

```python
import nemo_relay

with nemo_relay.scope.scope(
    "support-agent",
    nemo_relay.ScopeType.Agent,
    metadata={
        "audr": {
            "account_id": "acct_42",
            "subscription_id": "sub_7",
            "user_id": "u_8f14e45f",  # pseudonymous, never an email or a name
            "labels": {"feature": "support-chat"},
        }
    },
):
    ...  # Relay-managed LLM and tool calls
```

- `environment`, `user_id`, `account_id`, `subscription_id` and `labels` are read.
  Child scopes inherit the snapshot taken when their root started.
- A scope with no `environment`, or a `production` scope with no `account_id`, is skipped
  with a warning rather than billed to a guess. Omit `environment` from
  `attribution_defaults` to require it on every root scope.
- The [reference](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/docs/reference.md#attribution)
  states how evicted or completed ancestors are handled.

## Records

| Relay operation | `resource.operation` | `usage` |
| --- | --- | --- |
| Each `nemo_relay.llm.execute` call with a response codec | `generation` | `llm` tokens, `requests: 1` |
| Each `nemo_relay.tools.execute` call | `tool_execution` | `tool: { type: 'invocation', call_count: 1 }` |

Cache tokens are counted apart from `input_tokens`, and a provider-reported cost becomes
`cost.total_cost`. Not metered: LLM calls without a response codec, whose end events carry
no normalized usage.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/docs/reference.md): options, attribution, record fields, errors, diagnostics, operational bounds
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/nemo-relay/python/examples): `agent_scope.py` runs on a canned response, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
