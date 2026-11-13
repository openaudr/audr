"""Processor lifecycle and end-to-end behaviour with the Langfuse SDK."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from typing import Literal, cast

import pytest

pytest.importorskip("langfuse")

from audr import AUDR, Attribution, Client
from audr.testing import MemorySink
from langfuse import Langfuse, propagate_attributes
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from audr_adapter_langfuse import LangfuseActivationError, LangfuseAudrProcessor, LangfuseConfig
from tests.helpers import generation_attributes, span

pytestmark = pytest.mark.langfuse

_CONFIG = LangfuseConfig(provider="openai", attribution_defaults=Attribution(environment="test"))


@dataclass
class Harness:
    sink: MemorySink
    client: Client
    processor: LangfuseAudrProcessor


@pytest.fixture
async def harness() -> AsyncIterator[Harness]:
    sink = MemorySink()
    async with Client(sink) as client:
        yield Harness(sink, client, LangfuseAudrProcessor(client=client, config=_CONFIG))


@pytest.fixture
def langfuse_provider() -> Iterator[TracerProvider]:
    provider = TracerProvider()
    yield provider
    provider.shutdown()


async def _records(harness: Harness) -> list[AUDR]:
    await harness.processor.drain(timeout=5)
    await harness.client.flush()
    return list(harness.sink.records)


def _langfuse(provider: TracerProvider) -> Langfuse:
    # The in-memory exporter keeps the SDK offline; no request reaches base_url. Langfuse
    # keeps one tracer setup per public key, so each test uses its own key.
    return Langfuse(
        public_key=f"pk-lf-{uuid.uuid4()}",
        secret_key="sk-lf-test",
        base_url="https://langfuse.invalid",
        tracer_provider=provider,
        span_exporter=InMemorySpanExporter(),
        environment="production",
    )


async def test_meters_langfuse_observations_end_to_end(
    harness: Harness, langfuse_provider: TracerProvider
) -> None:
    langfuse_provider.add_span_processor(harness.processor)
    langfuse = _langfuse(langfuse_provider)

    with (
        langfuse.start_as_current_observation(name="agent", as_type="agent"),
        propagate_attributes(
            user_id="someone@example.com",
            metadata={"audr_account_id": "acct_42", "audr_feature_id": "support-chat"},
        ),
    ):
        with langfuse.start_as_current_observation(
            name="llm", as_type="generation", model="gpt-5.6-luna", input="SECRET-PROMPT"
        ) as generation:
            generation.update(
                usage_details={"input": 10, "output": 5, "cache_read_input_tokens": 2},
                output="SECRET-COMPLETION",
            )
        with langfuse.start_as_current_observation(name="search_orders", as_type="tool"):
            pass
    langfuse.flush()

    records = await _records(harness)

    assert [record.resource.operation for record in records] == ["generation", "tool_execution"]
    generation_record, tool_record = records
    assert generation_record.usage.llm is not None
    assert generation_record.usage.llm.model_dump(exclude_none=True) == {
        "input_tokens": 10,
        "output_tokens": 5,
        "cache_read_tokens": 2,
        "requests": 1,
    }
    assert generation_record.resource.provider == "openai"
    assert generation_record.run.run_id == tool_record.run.run_id
    assert generation_record.run.parent_span_id == tool_record.run.parent_span_id
    for record in records:
        assert record.attribution.environment == "production"
        assert record.attribution.account_id == "acct_42"
        assert record.attribution.feature_id == "support-chat"
        assert record.attribution.user_id is None
        assert "SECRET" not in json.dumps(record.model_dump(mode="json"))


async def test_span_ended_on_worker_thread_reaches_client(harness: Harness) -> None:
    worker = threading.Thread(target=harness.processor.on_end, args=(span(),))
    worker.start()
    worker.join()

    assert len(await _records(harness)) == 1


async def test_skips_are_logged_without_values(
    harness: Harness, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)

    harness.processor.on_end(span(generation_attributes(**{"gen_ai.provider.name": "!!"})))
    harness.processor.on_end(
        span(generation_attributes(**{"langfuse.observation.usage_details": "x"}))
    )
    harness.processor.on_end(span({"langfuse.observation.type": "tool"}, name=""))
    harness.processor.on_end(span({"langfuse.observation.type": "span"}))

    # An unusable provider attribute falls back to the configured provider.
    assert len(await _records(harness)) == 1
    messages = [record.getMessage() for record in caplog.records]
    assert "Langfuse span skipped (path=/name)" in messages
    assert "Langfuse span malformed (path=/attributes/langfuse.observation.usage_details)" in (
        messages
    )
    assert not any("langfuse.observation.type" in message for message in messages)
    assert not any("SECRET" in message for message in messages)


async def test_full_handoff_drops_with_warning(caplog: pytest.LogCaptureFixture) -> None:
    sink = MemorySink()
    async with Client(sink) as client:
        processor = LangfuseAudrProcessor(
            client=client, config=_CONFIG.model_copy(update={"max_pending_handoffs": 1})
        )
        processor.on_end(span())
        processor.on_end(span())
        await processor.drain(timeout=5)
        await client.flush()

        assert len(sink.records) == 1
    assert "Langfuse span record dropped: handoff full" in caplog.text


async def test_rejected_record_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    sink = MemorySink()
    async with Client(sink) as client:
        processor = LangfuseAudrProcessor(client=client, config=_CONFIG)
        await client.shutdown()
        processor.on_end(span())
        await processor.drain(timeout=5)

    assert "Langfuse span record submission dropped" in caplog.text


async def test_internal_mapping_failure_is_contained(
    harness: Harness, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def boom(*_: object, **__: object) -> None:
        raise RuntimeError("SECRET")

    monkeypatch.setattr("audr_adapter_langfuse._processor.map_span", boom)

    harness.processor.on_end(span())

    assert "Langfuse span mapping failed internally" in caplog.text
    assert "SECRET" not in caplog.text


async def test_lifecycle(harness: Harness) -> None:
    processor = harness.processor
    processor.on_start(span())  # type: ignore[arg-type]
    assert processor.force_flush() is True

    processor.shutdown()
    await processor.drain()
    processor.close()
    processor.on_end(span())

    assert harness.sink.records == []
    with pytest.raises(LangfuseActivationError):
        await processor.drain()


def test_requires_running_loop() -> None:
    with pytest.raises(LangfuseActivationError):
        LangfuseAudrProcessor(client=Client(MemorySink()))

    loop = asyncio.new_event_loop()
    try:
        with pytest.raises(LangfuseActivationError):
            LangfuseAudrProcessor(client=Client(MemorySink()), loop=loop)
    finally:
        loop.close()


async def test_drain_on_another_loop_is_rejected(harness: Harness) -> None:
    harness.processor.on_end(span())

    def drain_elsewhere() -> None:
        asyncio.run(harness.processor.drain(timeout=1))

    with pytest.raises(LangfuseActivationError):
        await asyncio.to_thread(drain_elsewhere)
    await harness.processor.drain(timeout=5)


def test_unknown_attribute_raises() -> None:
    import audr_adapter_langfuse

    with pytest.raises(AttributeError):
        _ = audr_adapter_langfuse.Missing


async def test_span_after_close_is_logged(
    harness: Harness, caplog: pytest.LogCaptureFixture
) -> None:
    harness.processor.close()

    harness.processor.on_end(span())

    assert "Langfuse span ignored: adapter is closed" in caplog.text


async def test_generation_without_usage_is_skipped_quietly(
    harness: Harness, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)

    harness.processor.on_end(
        span(generation_attributes(**{"langfuse.observation.usage_details": None}))
    )

    assert await _records(harness) == []
    assert caplog.text == ""


async def test_client_failure_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    class FailingClient:
        def record(self, record: AUDR) -> None:
            raise RuntimeError("SECRET")

    processor = LangfuseAudrProcessor(client=cast(Client, FailingClient()), config=_CONFIG)

    processor.on_end(span())
    await processor.drain(timeout=5)

    assert "Langfuse span record submission failed" in caplog.text
    assert "SECRET" not in caplog.text


async def test_closed_loop_drops_with_warning(caplog: pytest.LogCaptureFixture) -> None:
    loop = asyncio.new_event_loop()
    runner = threading.Thread(target=loop.run_forever)
    runner.start()
    try:
        processor = LangfuseAudrProcessor(client=Client(MemorySink()), config=_CONFIG, loop=loop)
    finally:
        loop.call_soon_threadsafe(loop.stop)
        runner.join()
        loop.close()

    processor.on_end(span())

    assert "Langfuse span record dropped: event loop unavailable" in caplog.text


async def test_drain_timeout(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = harness.processor._bridge
    monkeypatch.setattr(bridge, "_submit_to_client", lambda record: None)
    harness.processor.on_end(span())

    with pytest.raises(TimeoutError, match="drain timed out"):
        await harness.processor.drain(timeout=0.01)


def test_missing_runtime_raises_activation_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import audr_adapter_langfuse

    monkeypatch.delitem(sys.modules, "audr_adapter_langfuse._processor", raising=False)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace", None)

    with pytest.raises(LangfuseActivationError, match="install the runtime extra"):
        _ = audr_adapter_langfuse.LangfuseAudrProcessor


async def _nested(
    harness: Harness,
    provider: TracerProvider,
    *,
    outer_usage: dict[str, int] | None,
    inner_usage: dict[str, int] | None,
    inner_type: Literal["generation", "tool"] = "generation",
) -> list[AUDR]:
    provider.add_span_processor(harness.processor)
    langfuse = _langfuse(provider)
    with (
        propagate_attributes(metadata={"audr_account_id": "acct_42"}),
        langfuse.start_as_current_observation(
            name="outer", as_type="generation", model="gpt-5.6-luna"
        ) as outer,
    ):
        if inner_type == "tool":
            with langfuse.start_as_current_observation(name="inner", as_type="tool"):
                pass
        else:
            with langfuse.start_as_current_observation(
                name="inner", as_type="generation", model="gpt-5.6-luna"
            ) as inner:
                if inner_usage is not None:
                    inner.update(usage_details=inner_usage)
        if outer_usage is not None:
            outer.update(usage_details=outer_usage)
    langfuse.flush()
    return await _records(harness)


async def test_nested_model_span_is_billed_once(
    harness: Harness, langfuse_provider: TracerProvider
) -> None:
    # The shape LangChain's ChatOpenAI produces when the langfuse.openai drop-in is imported.
    usage = {"input": 10, "output": 5}

    records = await _nested(harness, langfuse_provider, outer_usage=usage, inner_usage=usage)

    assert [record.resource.name for record in records] == ["gpt-5.6-luna"]
    assert records[0].run.parent_span_id is not None


async def test_outer_usage_is_billed_when_inner_reports_none(
    harness: Harness, langfuse_provider: TracerProvider
) -> None:
    records = await _nested(harness, langfuse_provider, outer_usage={"input": 10}, inner_usage=None)

    assert len(records) == 1
    assert records[0].run.parent_span_id is None


async def test_tool_inside_generation_does_not_suppress_it(
    harness: Harness, langfuse_provider: TracerProvider
) -> None:
    records = await _nested(
        harness, langfuse_provider, outer_usage={"input": 10}, inner_usage=None, inner_type="tool"
    )

    assert sorted(record.resource.operation for record in records) == [
        "generation",
        "tool_execution",
    ]


async def test_full_tracking_evicts_oldest_parent(langfuse_provider: TracerProvider) -> None:
    sink = MemorySink()
    async with Client(sink) as client:
        processor = LangfuseAudrProcessor(
            client=client, config=_CONFIG.model_copy(update={"max_tracked_spans": 1})
        )
        # A child that ends after its parent leaves a stale entry nothing will take.
        processor.on_end(span(parent=True))
        usage = {"input": 10}
        records = await _nested(
            Harness(sink, client, processor),
            langfuse_provider,
            outer_usage=usage,
            inner_usage=usage,
        )

    # The stale entry is evicted, so the nested pair is still billed once.
    assert len(records) == 2
    assert len(processor._billed_parents) == 0


async def test_remote_parent_is_not_tracked(harness: Harness) -> None:
    from opentelemetry.sdk.trace import ReadableSpan
    from opentelemetry.trace import SpanContext

    from tests.helpers import END_NS, PARENT_ID, START_NS, TRACE_ID

    remote_child = ReadableSpan(
        name="llm",
        context=SpanContext(TRACE_ID, 0x1, is_remote=False),
        parent=SpanContext(TRACE_ID, PARENT_ID, is_remote=True),
        attributes=generation_attributes(),
        start_time=START_NS,
        end_time=END_NS,
    )

    harness.processor.on_end(remote_child)

    assert harness.processor._billed_parents == {}
    assert len(await _records(harness)) == 1
