import json
from collections.abc import Awaitable, Callable

import httpx
import pytest
from audr import AUDR, Attribution, BatchOutcome, RejectedRecord
from audr.testing import make_record

from audr_sink_chargebee import ChargebeeSink
from audr_sink_chargebee._version import __version__


def _record(**overrides: object) -> AUDR:
    overrides.setdefault("attribution", Attribution(environment="test", subscription_id="sub_123"))
    return make_record(**overrides)


def _build_sink(
    handler: Callable[[httpx.Request], Awaitable[httpx.Response]],
) -> tuple[ChargebeeSink, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    async def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return await handler(request)

    sink = ChargebeeSink(
        ingest_url="https://acme.ingest.chargebee.com",
        api_key="test_key",
        transport=httpx.MockTransport(record),
    )
    return sink, requests


async def test_sender_builds_the_required_batch_request() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(202)

    sink, requests = _build_sink(handler)
    record = _record()

    result = await sink.deliver([record])

    request = requests[0]
    assert request.method == "POST"
    assert str(request.url) == "https://acme.ingest.chargebee.com/api/v2/batch/usage_events"
    assert request.headers["Content-Type"] == "application/json;charset=UTF-8"
    assert request.headers["Accept"] == "application/json"
    assert request.headers["Authorization"] == "Basic dGVzdF9rZXk6"
    assert request.headers["User-Agent"] == f"audr-ingestion-python/{__version__}"
    [event] = json.loads(request.content)["events"]
    assert event["subscription_id"] == "sub_123"
    assert event["deduplication_id"] == record.record_id
    assert event["usage_timestamp"] == record.event_time_ms
    assert result.outcome is BatchOutcome.ACCEPTED
    await sink.close()


async def test_sender_handles_sequential_deliveries() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(202)

    sink, requests = _build_sink(handler)

    await sink.deliver([_record()])
    await sink.deliver([_record()])

    assert len(requests) == 2
    await sink.close()


async def test_chargebee_sink_flattens_audr_fields_into_properties() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(202)

    sink, requests = _build_sink(handler)
    record = _record()

    await sink.deliver([record])

    assert record.usage.llm is not None
    [event] = json.loads(requests[0].content)["events"]
    assert event["properties"]["usage__llm__input_tokens"] == record.usage.llm.input_tokens
    assert event["properties"]["resource__name"] == record.resource.name
    assert event["properties"]["resource__type"] == "model"
    await sink.close()


async def test_chargebee_sink_threads_the_configured_separator_into_properties() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(202)

    requests: list[httpx.Request] = []

    async def record_request(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return await handler(request)

    sink = ChargebeeSink(
        ingest_url="https://acme.ingest.chargebee.com",
        api_key="test_key",
        separator="_",
        transport=httpx.MockTransport(record_request),
    )
    record = _record()

    await sink.deliver([record])

    assert record.usage.llm is not None
    [event] = json.loads(requests[0].content)["events"]
    assert event["properties"]["usage_llm_input_tokens"] == record.usage.llm.input_tokens
    assert "usage__llm__input_tokens" not in event["properties"]
    await sink.close()


async def test_empty_batch_makes_no_request() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        pytest.fail("sink made an unexpected request")

    sink, requests = _build_sink(handler)

    result = await sink.deliver([])

    assert result.outcome is BatchOutcome.ACCEPTED
    assert requests == []
    await sink.close()


async def test_missing_subscription_rejected() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        pytest.fail("sink made an unexpected request for a record with no subscription")

    sink, requests = _build_sink(handler)
    record = _record(attribution=Attribution(environment="test"))

    result = await sink.deliver([record])

    assert result.outcome is BatchOutcome.ACCEPTED
    assert result.rejected == (RejectedRecord(record.record_id, "missing_subscription_id"),)
    assert requests == []
    await sink.close()
