"""Public contract and dependency-isolation tests for the Relay integration."""

import asyncio
import subprocess
import sys
from collections.abc import Callable, Iterator
from importlib.metadata import PackageNotFoundError
from typing import TYPE_CHECKING, cast

import pytest
from audr import Attribution, Client, ConfigurationError
from pydantic import ValidationError

from audr_adapter_nemo_relay import (
    NeMoRelayActivationError,
    NeMoRelayCompatibilityError,
    NeMoRelayConfig,
    NeMoRelayDiagnosticCode,
    NeMoRelayPlugin,
    _plugin,
)

if TYPE_CHECKING:
    from nemo_relay.plugin import PluginContext


class _Context:
    def __init__(self) -> None:
        self.callback: Callable[[object], None] | None = None

    def register_subscriber(self, name: str, callback: Callable[[object], None]) -> None:
        del name
        self.callback = callback


@pytest.fixture
def idle_loop() -> Iterator[asyncio.AbstractEventLoop]:
    loop = asyncio.new_event_loop()
    try:
        yield loop
    finally:
        loop.close()


def _make_plugin(loop: asyncio.AbstractEventLoop) -> NeMoRelayPlugin:
    return NeMoRelayPlugin(client=cast(Client, object()), loop=loop)


def test_public_config_is_json_compatible_and_immutable() -> None:
    config = NeMoRelayConfig(
        attribution_defaults=Attribution(
            environment="test",
            subscription_id="subscription",
            labels={"team": "ai"},
        ),
        max_pending_handoffs=20,
        max_tracked_scopes=30,
    )
    assert config.to_dict() == {
        "attribution_defaults": {
            "environment": "test",
            "subscription_id": "subscription",
            "labels": {"team": "ai"},
        },
        "max_pending_handoffs": 20,
        "max_tracked_scopes": 30,
    }
    with pytest.raises(ValidationError):
        config.max_pending_handoffs = 1  # type: ignore[misc]


def test_public_config_round_trips_through_its_own_serialization() -> None:
    config = NeMoRelayConfig(
        attribution_defaults=Attribution(environment="test", subscription_id="subscription")
    )
    assert NeMoRelayConfig.model_validate(config.to_dict()) == config


@pytest.mark.parametrize(
    "kwargs",
    [
        {"record_format": "other"},
        {"max_pending_handoffs": 0},
        {"max_pending_handoffs": 100_001},
        {"max_tracked_scopes": True},
        {"attribution_defaults": Attribution(user_id="person@example.com")},
        {"attribution_defaults": Attribution(subscription_id="")},
    ],
)
def test_public_config_rejects_invalid_values_at_construction(
    kwargs: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        NeMoRelayConfig(**kwargs)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("config", "field", "code"),
    [
        ({"record_format": "other"}, "record_format", "UNKNOWN_FIELD"),
        ({"max_pending_handoffs": 0}, "max_pending_handoffs", "INVALID_BOUND"),
        ({"max_pending_handoffs": 100_001}, "max_pending_handoffs", "INVALID_BOUND"),
        ({"max_tracked_scopes": True}, "max_tracked_scopes", "INVALID_BOUND"),
        ({"attribution_defaults": []}, "attribution_defaults", "INVALID_ATTRIBUTION"),
        (
            {"attribution_defaults": {"environment": "invalid"}},
            "attribution_defaults.environment",
            "INVALID_ATTRIBUTION_VALUE",
        ),
        (
            {"attribution_defaults": {"subscription_id": ""}},
            "attribution_defaults.subscription_id",
            "INVALID_ATTRIBUTION_VALUE",
        ),
        (
            {"attribution_defaults": {"user_id": "person@example.com"}},
            "attribution_defaults.user_id",
            "INVALID_ATTRIBUTION_VALUE",
        ),
        (
            {"attribution_defaults": {"labels": {"bad key": "value"}}},
            "attribution_defaults.labels",
            "INVALID_ATTRIBUTION_VALUE",
        ),
        (
            {"attribution_defaults": {"initiator": "system"}},
            "attribution_defaults",
            "INVALID_ATTRIBUTION_FIELD",
        ),
        ({"unknown": "value"}, "unknown", "UNKNOWN_FIELD"),
    ],
)
def test_validate_reports_field_specific_errors_without_registering(
    config: dict[str, object],
    field: str,
    code: str,
    idle_loop: asyncio.AbstractEventLoop,
) -> None:
    diagnostics = _make_plugin(idle_loop).validate(config)

    assert diagnostics
    assert diagnostics[0]["field"] == field
    assert diagnostics[0]["level"] == "error"
    assert diagnostics[0]["code"] == NeMoRelayDiagnosticCode[code]
    assert diagnostics[0]["message"] == NeMoRelayDiagnosticCode[code].message


def test_validate_reports_every_unknown_field_deterministically(
    idle_loop: asyncio.AbstractEventLoop,
) -> None:
    plugin = _make_plugin(idle_loop)
    config = {"zebra": 1, "alpha": 2}

    first = plugin.validate(config)
    second = plugin.validate(config)

    assert first is not None
    assert [item["field"] for item in first] == ["alpha", "zebra"]
    assert first == second


def test_validate_accepts_defaults_and_partial_attribution(
    idle_loop: asyncio.AbstractEventLoop,
) -> None:
    plugin = _make_plugin(idle_loop)
    assert plugin.validate({}) == []
    assert (
        plugin.validate(
            {
                "attribution_defaults": {"subscription_id": "subscription"},
                "max_pending_handoffs": 1,
                "max_tracked_scopes": 1,
            }
        )
        == []
    )


def test_validate_reports_an_unsupported_relay_release(
    monkeypatch: pytest.MonkeyPatch,
    idle_loop: asyncio.AbstractEventLoop,
) -> None:
    monkeypatch.setattr(_plugin, "package_version", lambda _: "0.9.0")

    diagnostics = _make_plugin(idle_loop).validate({})

    assert diagnostics is not None
    assert [item["code"] for item in diagnostics] == [
        NeMoRelayDiagnosticCode.UNSUPPORTED_RELAY_VERSION
    ]


async def test_unsupported_relay_version_fails_before_subscriber_registration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_plugin, "package_version", lambda _: "0.9.0")
    context = _Context()

    with pytest.raises(NeMoRelayCompatibilityError, match=r">=0\.8,<0\.9"):
        NeMoRelayPlugin(client=cast(Client, object())).register({}, cast("PluginContext", context))

    assert context.callback is None


async def test_missing_relay_extra_has_actionable_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def missing(_: str) -> str:
        raise PackageNotFoundError

    monkeypatch.setattr(_plugin, "package_version", missing)

    with pytest.raises(NeMoRelayCompatibilityError, match=r"nemo-relay.*extra"):
        NeMoRelayPlugin(client=cast(Client, object())).register(
            {}, cast("PluginContext", _Context())
        )


def test_core_and_integration_import_do_not_import_nemo_relay() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; "
            "import audr; "
            "import audr_adapter_nemo_relay; "
            "assert 'nemo_relay' not in sys.modules",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_construction_off_the_running_loop_fails_immediately() -> None:
    with pytest.raises(NeMoRelayActivationError, match="running event loop"):
        NeMoRelayPlugin(client=cast(Client, object()))


async def test_explicit_loop_allows_construction_off_the_running_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_plugin, "package_version", lambda _: "0.8.4")
    plugin = _make_plugin(asyncio.get_running_loop())
    context = _Context()

    plugin.register({}, cast("PluginContext", context))

    assert context.callback is not None


def test_explicit_non_running_loop_is_rejected_before_registration(
    monkeypatch: pytest.MonkeyPatch,
    idle_loop: asyncio.AbstractEventLoop,
) -> None:
    monkeypatch.setattr(_plugin, "package_version", lambda _: "0.8.4")
    context = _Context()

    with pytest.raises(NeMoRelayActivationError, match="must be running"):
        _make_plugin(idle_loop).register({}, cast("PluginContext", context))

    assert context.callback is None


async def test_second_activation_is_refused_and_leaves_no_stale_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_plugin, "package_version", lambda _: "0.8.4")
    plugin = _make_plugin(asyncio.get_running_loop())
    plugin.register({}, cast("PluginContext", _Context()))

    with pytest.raises(NeMoRelayActivationError, match="already activated"):
        plugin.register({}, cast("PluginContext", _Context()))

    # Relay rolls the whole initialization back, so the refusal must not wedge
    # the instance against the host's next, corrected initialization.
    retried = _Context()
    plugin.register({}, cast("PluginContext", retried))
    assert retried.callback is not None


async def test_invalid_component_config_is_refused_at_activation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_plugin, "package_version", lambda _: "0.8.4")
    plugin = _make_plugin(asyncio.get_running_loop())
    context = _Context()

    with pytest.raises(ConfigurationError, match="max_tracked_scopes"):
        plugin.register({"max_tracked_scopes": 0}, cast("PluginContext", context))

    assert context.callback is None
