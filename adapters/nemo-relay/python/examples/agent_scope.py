"""Meter one model call and one tool call inside a NeMo Relay agent scope.

The model and tool callables return canned results, so the example runs without network
access or provider keys. Records are written to a temporary JSON Lines file and printed.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import nemo_relay
from audr import Attribution, Client, FileSink
from nemo_relay import plugin as relay_plugin

from audr_adapter_nemo_relay import PLUGIN_KIND, NeMoRelayConfig, NeMoRelayPlugin


async def call_model(_: nemo_relay.LLMRequest) -> nemo_relay.JsonValue:
    """Stand in for a provider: an OpenAI Chat Completions response with usage."""
    return {
        "id": "chatcmpl-1",
        "model": "gpt-4o-mini",
        "choices": [
            {
                "message": {"role": "assistant", "content": "Order 42 shipped yesterday."},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19},
    }


async def lookup_order(_: object) -> nemo_relay.ToolExecutionResult[nemo_relay.JsonValue]:
    return nemo_relay.ToolExecutionResult({"status": "shipped"})


async def main() -> None:
    path = Path(tempfile.gettempdir()) / "audr-nemo-relay-example.jsonl"
    path.unlink(missing_ok=True)

    async with Client(FileSink(path)) as client:
        usage_plugin = NeMoRelayPlugin(client=client)
        config = NeMoRelayConfig(
            attribution_defaults=Attribution(environment="production", labels={"region": "us"})
        )
        relay_config = relay_plugin.PluginConfig(
            components=[relay_plugin.ComponentSpec(kind=PLUGIN_KIND, config=config.to_dict())]
        )
        relay_plugin.register(PLUGIN_KIND, usage_plugin)
        try:
            async with relay_plugin.plugin(relay_config):
                with nemo_relay.scope.scope(
                    "support-agent",
                    nemo_relay.ScopeType.Agent,
                    metadata={
                        "audr": {
                            "account_id": "acct_42",
                            "subscription_id": "sub_7",
                            "labels": {"feature": "support-chat"},
                        }
                    },
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
                    await nemo_relay.tools.execute("lookup_order", {"order": 42}, lookup_order)
            await usage_plugin.drain(timeout=5)
        finally:
            relay_plugin.deregister(PLUGIN_KIND)

    # Each record's labels hold both the default and the scope's keys.
    print(path.read_text())


if __name__ == "__main__":
    asyncio.run(main())
