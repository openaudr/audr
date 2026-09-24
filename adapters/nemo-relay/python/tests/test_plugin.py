"""Subscriber registration and event-loop bridge tests."""

import asyncio
import logging
import threading
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, cast

import pytest
from audr import AUDR, Client, SubmitOutcome, SubmitResult

from audr_adapter_nemo_relay import (
    NeMoRelayActivationError,
    NeMoRelayPlugin,
    _plugin,
)

if TYPE_CHECKING:
    from nemo_relay.plugin import PluginContext

_ROOT_ID = "0199f123-0000-7000-8000-000000000011"
_LLM_ID = "0199f123-0000-7000-8000-000000000012"
_BASE_TIME = datetime.now(UTC) - timedelta(seconds=1)


class _Event:
    def __init__(self, payload: Mapping[str, object]) -> None:
        self._payload = payload

    def to_dict(self) -> Mapping[str, object]:
        return self._payload


class _Context:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.callback: Callable[[_Event], None] | None = None

    def register_subscriber(self, name: str, callback: Callable[[_Event], None]) -> None:
        assert name == "usage-events"
        if self.fail:
            raise RuntimeError("registration failed")
        self.callback = callback


class _Client:
    def __init__(
        self,
        *,
        outcome: SubmitOutcome = SubmitOutcome.QUEUED,
        error_message: str | None = None,
    ) -> None:
        self.outcome = outcome
        self.error_message = error_message
        self.records: list[AUDR] = []
        self.thread_ids: list[int] = []

    def record(self, record: AUDR) -> SubmitResult:
        self.records.append(record)
        self.thread_ids.append(threading.get_ident())
        if self.error_message is not None:
            raise RuntimeError(self.error_message)
        return SubmitResult(self.outcome)


@pytest.fixture(autouse=True)
def supported_relay_version(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_plugin, "package_version", lambda _: "0.8.4")


def _time(offset_ms: int) -> str:
    return (_BASE_TIME + timedelta(milliseconds=offset_ms)).isoformat()


def _root_start() -> _Event:
    return _Event(
        {
            "kind": "scope",
            "scope_category": "start",
            "uuid": _ROOT_ID,
            "parent_uuid": None,
            "timestamp": _time(0),
            "category": "agent",
            "name": "agent",
            "metadata": {
                "audr": {
                    "environment": "test",
                    "subscription_id": "subscription",
                }
            },
        }
    )


def _llm_start(scope_id: str = _LLM_ID) -> _Event:
    return _Event(
        {
            "kind": "scope",
            "scope_category": "start",
            "uuid": scope_id,
            "parent_uuid": _ROOT_ID,
            "timestamp": _time(5),
            "category": "llm",
            "name": "provider",
        }
    )


def _llm_end(scope_id: str = _LLM_ID, *, secret: str = "hidden") -> _Event:
    return _Event(
        {
            "kind": "scope",
            "scope_category": "end",
            "uuid": scope_id,
            "parent_uuid": _ROOT_ID,
            "timestamp": _time(20),
            "category": "llm",
            "name": "provider",
            "category_profile": {
                "annotated_response": {
                    "model": "model",
                    "usage": {"prompt_tokens": 2, "completion_tokens": 1},
                }
            },
            "data": {"prompt": secret, "response": secret},
        }
    )


async def _activated(
    client: _Client,
    config: Mapping[str, object] | None = None,
) -> tuple[NeMoRelayPlugin, _Context]:
    plugin = NeMoRelayPlugin(client=cast(Client, client))
    context = _Context()
    plugin.register(config or {}, cast("PluginContext", context))
    assert context.callback is not None
    return plugin, context


async def test_worker_thread_handoff_submits_one_audr_record() -> None:
    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None
    loop_thread = threading.get_ident()

    def produce() -> None:
        callback(_root_start())
        callback(_llm_start())
        callback(_llm_end())

    await asyncio.to_thread(produce)
    await plugin.drain()

    assert len(client.records) == 1
    assert isinstance(client.records[0], AUDR)
    assert client.thread_ids == [loop_thread]


async def test_handoff_bound_drops_without_blocking_subscriber(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client()
    plugin, context = await _activated(
        client,
        {
            "attribution_defaults": {
                "environment": "test",
                "subscription_id": "subscription",
            },
            "max_pending_handoffs": 1,
        },
    )
    callback = context.callback
    assert callback is not None
    second_id = "0199f123-0000-7000-8000-000000000013"
    caplog.set_level(logging.WARNING)

    callback(_root_start())
    callback(_llm_start())
    callback(_llm_end())
    callback(_llm_start(second_id))
    callback(_llm_end(second_id))
    await plugin.drain()

    assert len(client.records) == 1
    assert "handoff full" in caplog.text


async def test_non_queued_client_result_isolated_from_relay(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client(outcome=SubmitOutcome.DROPPED_QUEUE_FULL)
    plugin, context = await _activated(
        client,
        {
            "attribution_defaults": {
                "environment": "test",
                "subscription_id": "subscription",
            }
        },
    )
    callback = context.callback
    assert callback is not None
    caplog.set_level(logging.WARNING)

    callback(_root_start())
    callback(_llm_start())
    callback(_llm_end())
    await plugin.drain()

    assert "outcome=dropped_queue_full" in caplog.text


async def test_client_exception_is_safely_isolated(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "client-exception-must-not-be-logged"
    client = _Client(error_message=secret)
    plugin, context = await _activated(
        client,
        {
            "attribution_defaults": {
                "environment": "test",
                "subscription_id": "subscription",
            }
        },
    )
    callback = context.callback
    assert callback is not None
    caplog.set_level(logging.WARNING)

    callback(_root_start())
    callback(_llm_start())
    callback(_llm_end())
    await plugin.drain()

    assert "submission failed" in caplog.text
    assert secret not in caplog.text


async def test_closed_event_loop_is_logged_without_blocking_drain(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client()
    plugin, context = await _activated(
        client,
        {
            "attribution_defaults": {
                "environment": "test",
                "subscription_id": "subscription",
            }
        },
    )
    callback = context.callback
    bridge = plugin._bridge
    assert callback is not None
    assert bridge is not None
    closed_loop = asyncio.new_event_loop()
    closed_loop.close()
    bridge._loop = closed_loop
    caplog.set_level(logging.WARNING)

    callback(_root_start())
    callback(_llm_start())
    callback(_llm_end())
    await plugin.drain()

    assert "event loop unavailable" in caplog.text


async def test_unexpected_encoder_failure_is_logged_as_internal(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None

    def fail_encoding(*_: object, **__: object) -> AUDR:
        raise RuntimeError("internal encoder bug")

    monkeypatch.setattr(_plugin, "encode_audr", fail_encoding)
    caplog.set_level(logging.WARNING)
    callback(_root_start())
    callback(_llm_start())
    callback(_llm_end())
    await plugin.drain()

    assert "event submission failed" in caplog.text
    assert "internal encoder bug" in caplog.text


async def test_registration_rolls_back_and_duplicate_activation_is_rejected() -> None:
    client = _Client()
    plugin = NeMoRelayPlugin(client=cast(Client, client))

    with pytest.raises(RuntimeError, match="registration failed"):
        plugin.register({}, cast("PluginContext", _Context(fail=True)))

    context = _Context()
    plugin.register({}, cast("PluginContext", context))
    with pytest.raises(NeMoRelayActivationError, match="already activated"):
        plugin.register({}, cast("PluginContext", _Context()))


async def test_draining_after_close_is_refused_instead_of_losing_events() -> None:
    plugin, _ = await _activated(_Client())

    plugin.close()

    with pytest.raises(NeMoRelayActivationError, match="before close"):
        await plugin.drain()


async def test_drain_waits_for_handoffs_accepted_before_it_was_awaited() -> None:
    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None

    def produce() -> None:
        callback(_root_start())
        callback(_llm_start())
        callback(_llm_end())

    await asyncio.to_thread(produce)
    await plugin.drain(timeout=5.0)

    assert len(client.records) == 1
    # A second drain has nothing outstanding and must return immediately.
    await plugin.drain(timeout=0)


async def test_malformed_events_never_raise_or_log_payload_values(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None
    secret = "never-log-this-value"
    caplog.set_level(logging.WARNING)

    callback(_root_start())
    callback(_llm_start())
    callback(
        _Event(
            {
                "kind": "scope",
                "scope_category": "end",
                "uuid": _LLM_ID,
                "timestamp": _time(20),
                "category": "llm",
                "name": "provider",
                "data": secret,
            }
        )
    )
    callback(
        _Event(
            {
                "kind": "scope",
                "scope_category": "end",
                "uuid": secret,
                "timestamp": _time(20),
                "category": "llm",
                "name": "provider",
            }
        )
    )
    await plugin.drain()

    assert "event malformed" in caplog.text
    assert secret not in caplog.text


# --- events the plugin must survive without raising into Relay's dispatcher ---------


async def test_an_event_whose_to_dict_raises_is_logged_and_dropped(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class _Hostile:
        def to_dict(self) -> Mapping[str, object]:
            raise RuntimeError("relay serialisation bug")

    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None
    caplog.set_level(logging.WARNING)

    callback(cast(_Event, _Hostile()))  # must not propagate into Relay
    await plugin.drain()

    assert "to_dict() raised" in caplog.text
    assert client.records == []


async def test_an_event_that_is_not_a_mapping_is_logged_and_dropped(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None
    caplog.set_level(logging.WARNING)

    callback(_Event(cast(Mapping[str, object], ["not", "a", "mapping"])))
    await plugin.drain()

    assert "did not return a mapping" in caplog.text
    assert client.records == []


async def test_events_arriving_after_close_are_logged_not_dropped_silently(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Relay may dispatch a callback that was already in flight when we closed."""
    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None

    plugin.close()
    caplog.set_level(logging.WARNING)
    callback(_root_start())

    assert "plugin is not active" in caplog.text
    assert client.records == []


async def test_a_mapping_failure_is_logged_without_killing_the_subscriber(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None

    def explode(_payload: Mapping[str, object]) -> object:
        raise RuntimeError("tracker bug")

    assert plugin._tracker is not None
    monkeypatch.setattr(plugin._tracker, "consume", explode)
    caplog.set_level(logging.WARNING)

    callback(_root_start())  # must not propagate into Relay

    assert "event mapping failed" in caplog.text


async def test_evicted_scope_state_is_reported(caplog: pytest.LogCaptureFixture) -> None:
    """A run larger than `max_tracked_scopes` loses state; that must be visible."""
    client = _Client()
    plugin, context = await _activated(client, {"max_tracked_scopes": 1})
    callback = context.callback
    assert callback is not None
    caplog.set_level(logging.WARNING)

    callback(_root_start())
    callback(_llm_start())
    callback(_llm_start("0199f123-0000-7000-8000-0000000000ff"))
    await plugin.drain()

    assert "scope state evicted" in caplog.text


async def test_a_skipped_event_names_the_field_that_made_it_unbillable(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None
    caplog.set_level(logging.WARNING)

    # A root scope with no `audr` metadata leaves attribution unresolvable.
    callback(
        _Event(
            {
                "kind": "scope",
                "scope_category": "start",
                "uuid": _ROOT_ID,
                "parent_uuid": None,
                "timestamp": _time(0),
                "category": "agent",
                "name": "agent",
            }
        )
    )
    callback(_llm_start())
    callback(_llm_end())
    await plugin.drain()

    assert "event skipped" in caplog.text
    assert client.records == []


async def test_drain_with_no_budget_reports_a_timeout_instead_of_returning_early() -> None:
    """A drain that could not finish must raise, never claim success."""
    client = _Client()
    plugin, context = await _activated(client)
    callback = context.callback
    assert callback is not None

    # Produce on a worker thread and join it without yielding to the loop, so the
    # handoffs are accepted but their loop callbacks have not run yet.
    def produce() -> None:
        callback(_root_start())
        callback(_llm_start())
        callback(_llm_end())

    worker = threading.Thread(target=produce)
    worker.start()
    worker.join()

    with pytest.raises(TimeoutError, match="drain timed out"):
        await plugin.drain(timeout=0)

    # The bridge stays usable: a real drain still completes.
    await plugin.drain(timeout=5.0)
    assert len(client.records) == 1


@pytest.mark.parametrize(
    ("version", "supported"),
    [
        ("0.8.0", True),
        ("0.8.4", True),
        ("0.9.0", False),
        ("1.8.0", False),
        ("0.8", True),
        ("0", False),
        ("", False),
        ("not.a.version", False),
        ("0.x.1", False),
    ],
)
def test_relay_version_support_is_decided_on_the_major_minor_series(
    version: str, supported: bool
) -> None:
    assert _plugin.is_supported_relay_version(version) is supported
