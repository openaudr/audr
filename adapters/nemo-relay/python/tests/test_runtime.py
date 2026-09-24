"""Lifecycle coverage against the installed NeMo Relay 0.8 runtime."""

from typing import TYPE_CHECKING, cast

import pytest
from audr import (
    AUDR,
    Attribution,
    Client,
    Emitter,
    Resource,
    Run,
    SubmitOutcome,
    Timing,
    ToolUsage,
    Usage,
)
from audr.ids import uuid7
from audr.testing import MemorySink

from audr_adapter_nemo_relay import (
    PLUGIN_KIND,
    NeMoRelayConfig,
    NeMoRelayPlugin,
)

pytestmark = pytest.mark.nemo_relay
nemo_relay = pytest.importorskip("nemo_relay")

if TYPE_CHECKING:
    from nemo_relay.plugin import Plugin

    _relay_plugin: Plugin = NeMoRelayPlugin(
        client=cast(Client, object()),
    )


def _manual_record() -> AUDR:
    """A host-submitted record, to prove the client still accepts non-Relay traffic."""
    return AUDR(
        emitter=Emitter(component="harness", name="example-app", version="1.0"),
        timing=Timing(),
        resource=Resource(
            provider="self-hosted",
            type="tool",
            name="manual-tool",
            operation="tool_execution",
        ),
        usage=Usage(tool=ToolUsage(type="invocation", call_count=1)),
        run=Run(run_id=uuid7(), span_id="manual-span"),
        attribution=Attribution(environment="test", subscription_id="subscription"),
    )


async def test_real_relay_llm_and_tool_lifecycle_drains_before_client_stop() -> None:
    sink = MemorySink()
    client = Client(sink=sink)
    plugin = NeMoRelayPlugin(client=client)
    config = NeMoRelayConfig(
        max_pending_handoffs=10,
        max_tracked_scopes=20,
    )
    plugin_config = nemo_relay.plugin.PluginConfig(
        components=[
            nemo_relay.plugin.ComponentSpec(
                kind=PLUGIN_KIND,
                config=config.to_dict(),
            )
        ]
    )
    nemo_relay.plugin.register(PLUGIN_KIND, plugin)
    try:
        async with nemo_relay.plugin.plugin(plugin_config):
            request = nemo_relay.LLMRequest(
                {},
                {
                    "messages": [{"role": "user", "content": "not submitted"}],
                    "model": "demo-model",
                },
            )

            async def call_model(_: object) -> object:
                return {
                    "id": "response-1",
                    "model": "demo-model",
                    "choices": [
                        {
                            "message": {"role": "assistant", "content": "not submitted"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 3,
                        "completion_tokens": 2,
                        "total_tokens": 5,
                    },
                }

            async def call_tool(_: object) -> object:
                return nemo_relay.ToolExecutionResult({"opaque": "not submitted"})

            with nemo_relay.scope.scope(
                "agent",
                nemo_relay.ScopeType.Agent,
                metadata={
                    "audr": {
                        "environment": "test",
                        "subscription_id": "subscription",
                    }
                },
            ):
                await nemo_relay.llm.execute(
                    "openai",
                    request,
                    call_model,
                    model_name="demo-model",
                    response_codec=nemo_relay.codecs.OpenAIChatCodec(),
                )
                await nemo_relay.tools.execute("lookup", {"secret": "not submitted"}, call_tool)

        await plugin.drain(timeout=5)
        assert client.stats.submitted == 2
        submitted_after_clear = client.stats.submitted
        await nemo_relay.tools.execute("after-clear", {}, call_tool)
        await nemo_relay.subscribers.flush_async()
        await plugin.drain(timeout=5)
        assert client.stats.submitted == submitted_after_clear
        manual = client.record(_manual_record())
        assert manual.outcome is SubmitOutcome.QUEUED
    finally:
        try:
            await client.shutdown()
        finally:
            nemo_relay.plugin.deregister(PLUGIN_KIND)

    delivered = sink.records
    assert len(delivered) == 3
    relay_records = [
        record
        for record in delivered
        if record.emitter is not None and record.emitter.name == "audr-adapter-nemo-relay"
    ]
    assert len(relay_records) == 2
    for record in relay_records:
        assert "not submitted" not in record.to_json()
    assert {record.resource.operation for record in relay_records} == {
        "generation",
        "tool_execution",
    }


async def test_real_relay_scopes_bill_to_attribution_defaults_without_metadata() -> None:
    """Relay never emits a root scope's own parent, so defaults must still apply."""
    sink = MemorySink()
    client = Client(sink=sink)
    plugin = NeMoRelayPlugin(client=client)
    config = NeMoRelayConfig(
        attribution_defaults=Attribution(
            environment="test",
            subscription_id="default-subscription",
        ),
    )
    plugin_config = nemo_relay.plugin.PluginConfig(
        components=[nemo_relay.plugin.ComponentSpec(kind=PLUGIN_KIND, config=config.to_dict())]
    )
    nemo_relay.plugin.register(PLUGIN_KIND, plugin)
    try:
        async with nemo_relay.plugin.plugin(plugin_config):
            request = nemo_relay.LLMRequest(
                {},
                {"messages": [{"role": "user", "content": "x"}], "model": "demo-model"},
            )

            async def call_model(_: object) -> object:
                return {
                    "id": "response-1",
                    # AUDR bills the provider's verbatim identifier, not the requested name.
                    "model": "demo-model-2026-01-01",
                    "choices": [
                        {
                            "message": {"role": "assistant", "content": "y"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 3, "completion_tokens": 2},
                }

            # No enclosing scope and no audr metadata anywhere.
            await nemo_relay.llm.execute(
                "openai",
                request,
                call_model,
                model_name="demo-model",
                response_codec=nemo_relay.codecs.OpenAIChatCodec(),
            )

        await plugin.drain(timeout=5)
    finally:
        try:
            await client.shutdown()
        finally:
            nemo_relay.plugin.deregister(PLUGIN_KIND)

    delivered = sink.records
    assert len(delivered) == 1
    record = delivered[0]
    assert record.attribution.subscription_id == "default-subscription"
    assert record.resource.name == "demo-model-2026-01-01"


async def _deliver_one(codec: object, body: dict[str, object], response: object) -> AUDR:
    """Run one managed LLM call through the real runtime and return its record."""
    sink = MemorySink()
    client = Client(sink=sink)
    plugin = NeMoRelayPlugin(client=client)
    config = NeMoRelayConfig(
        attribution_defaults=Attribution(environment="test", subscription_id="subscription"),
    )
    plugin_config = nemo_relay.plugin.PluginConfig(
        components=[nemo_relay.plugin.ComponentSpec(kind=PLUGIN_KIND, config=config.to_dict())]
    )
    nemo_relay.plugin.register(PLUGIN_KIND, plugin)
    try:
        async with nemo_relay.plugin.plugin(plugin_config):

            async def call_model(_: object) -> object:
                return response

            await nemo_relay.llm.execute(
                "provider",
                nemo_relay.LLMRequest({}, body),
                call_model,
                model_name="demo-model",
                response_codec=codec,
            )
        await plugin.drain(timeout=5)
    finally:
        try:
            await client.shutdown()
        finally:
            nemo_relay.plugin.deregister(PLUGIN_KIND)

    assert len(sink.records) == 1
    return sink.records[0]


async def test_real_relay_anthropic_prompt_count_is_not_reduced_by_the_cache() -> None:
    """Relay's Anthropic codec publishes uncached input as `prompt_tokens`."""
    record = await _deliver_one(
        nemo_relay.codecs.AnthropicMessagesCodec(),
        {"model": "demo-model", "max_tokens": 8, "messages": [{"role": "user", "content": "x"}]},
        {
            "id": "msg-1",
            "type": "message",
            "role": "assistant",
            "model": "demo-model",
            "content": [{"type": "text", "text": "y"}],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 5,
                "cache_read_input_tokens": 800,
                "cache_creation_input_tokens": 50,
            },
        },
    )

    assert record.usage.llm is not None
    assert record.usage.llm.input_tokens == 100
    assert record.usage.llm.cache_read_tokens == 800
    assert record.usage.llm.cache_write_tokens == 50


async def test_real_relay_gateway_cost_is_carried_as_provider_reported() -> None:
    record = await _deliver_one(
        nemo_relay.codecs.OpenAIChatCodec(),
        {"model": "demo-model", "messages": [{"role": "user", "content": "x"}]},
        {
            "id": "gen-1",
            "model": "vendor/demo-model",
            "choices": [
                {"message": {"role": "assistant", "content": "y"}, "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": 24, "completion_tokens": 32, "cost": 0.00042},
        },
    )

    assert record.validate() == []
    assert record.cost is not None
    assert record.cost.total_cost == 0.00042
    assert record.cost.currency == "USD"
