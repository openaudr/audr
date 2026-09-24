"""In-process NeMo Relay language-binding plugin."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as package_version
from typing import TYPE_CHECKING, Protocol, assert_never, cast

from audr import Client, SubmitOutcome

from audr_adapter_nemo_relay._bridge import (
    EventLoopBridge,
    HandoffOutcome,
)
from audr_adapter_nemo_relay._config import (
    parse_config,
    unsupported_relay_version_diagnostic,
    validate_config,
)
from audr_adapter_nemo_relay._errors import (
    NeMoRelayActivationError,
    NeMoRelayCompatibilityError,
)
from audr_adapter_nemo_relay._mapping import (
    EventIgnored,
    EventMalformed,
    EventSkipped,
    MappingResult,
    Operation,
    OperationReady,
    ScopeTracker,
    encode_audr,
    is_uuid,
)

if TYPE_CHECKING:
    from nemo_relay.plugin import ConfigDiagnostic, PluginContext

_SUBSCRIBER_NAME = "usage-events"
_UNKNOWN_EVENT_ID = "unknown"
_RELAY_DISTRIBUTION = "nemo-relay"
_SUPPORTED_RELAY_SERIES = (0, 8)
_SUPPORTED_RELAY_RANGE = ">=0.8,<0.9"
_LOGGER = logging.getLogger(__name__)


class _RelayEvent(Protocol):
    def to_dict(self) -> Mapping[str, object]: ...


class NeMoRelayPlugin:
    """Translate Relay lifecycle events into host-owned SDK submissions.

    This satisfies ``nemo_relay.plugin.Plugin``. Register it under
    :data:`PLUGIN_KIND` before activating Relay. The host application owns the
    client and its sink, including construction, startup and shutdown.

    One instance serves one component activation. Two activations would install
    two subscribers over the same process-wide event stream and double-count
    every operation, so a second :meth:`register` is refused.
    """

    def __init__(
        self,
        *,
        client: Client,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        if loop is None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError as error:
                raise NeMoRelayActivationError(
                    "construct NeMoRelayPlugin on the running event loop that owns the "
                    "Client client, or pass loop= explicitly"
                ) from error
        self._client = client
        self._loop = loop
        self._tracker: ScopeTracker | None = None
        self._bridge: EventLoopBridge | None = None
        self._registered = False
        self._closed = False

    def validate(
        self,
        plugin_config: Mapping[str, object],
    ) -> list[ConfigDiagnostic] | None:
        """Validate one component without changing runtime state.

        An unsupported Relay release is reported here as well as refused at
        activation, so a host sees it from ``plugin.validate(...)``.
        """
        diagnostics = validate_config(plugin_config)
        version = _installed_relay_version()
        if version is not None and not is_supported_relay_version(version):
            diagnostics.append(unsupported_relay_version_diagnostic())
        return cast("list[ConfigDiagnostic]", diagnostics)

    def register(
        self,
        plugin_config: Mapping[str, object],
        context: PluginContext,
    ) -> None:
        """Install the component-owned subscriber during Relay activation."""
        try:
            self._activate(plugin_config, context)
        except Exception:
            # Relay rolls back every registration from this initialization, so
            # state published for an earlier component of this kind is stale too.
            self._forget_activation()
            raise

    async def drain(self, timeout: float | None = None) -> None:
        """Wait for accepted subscriber handoffs to reach the client."""
        if self._closed:
            raise NeMoRelayActivationError(
                "drain() must be awaited before close(); closing first discards "
                "handoffs that had not yet reached the client"
            )
        bridge = self._bridge
        if bridge is not None:
            await bridge.drain(timeout)

    def close(self) -> None:
        """Drop plugin-owned scope state after Relay has stopped producing events."""
        self._closed = True
        tracker = self._tracker
        if tracker is not None:
            tracker.clear()
        self._tracker = None
        self._bridge = None

    def _activate(
        self,
        plugin_config: Mapping[str, object],
        context: PluginContext,
    ) -> None:
        if self._registered:
            raise NeMoRelayActivationError(
                "this NeMoRelayPlugin instance is already activated; construct one "
                "instance per component activation"
            )
        if self._loop.is_closed() or not self._loop.is_running():
            raise NeMoRelayActivationError(
                "the event loop supplied to NeMoRelayPlugin must be running when "
                "Relay activates the component"
            )
        _require_supported_relay_version()
        config = parse_config(plugin_config)
        tracker = ScopeTracker(
            defaults=config.attribution_defaults,
            max_scopes=config.max_tracked_scopes,
        )
        bridge = EventLoopBridge(
            client=self._client,
            loop=self._loop,
            max_pending=config.max_pending_handoffs,
            on_result=self._on_submit_result,
        )
        context.register_subscriber(_SUBSCRIBER_NAME, self._on_event)
        self._tracker = tracker
        self._bridge = bridge
        self._registered = True

    def _forget_activation(self) -> None:
        self._tracker = None
        self._bridge = None
        self._registered = False

    def _on_event(self, event: _RelayEvent) -> None:
        payload, event_id = _read_payload(event)
        if payload is None:
            return
        tracker = self._tracker
        if tracker is None:
            _LOGGER.warning(
                "NeMo Relay event ignored: plugin is not active (event_id=%s)",
                event_id,
            )
            return
        try:
            result = tracker.consume(payload)
        except Exception:
            _LOGGER.exception("NeMo Relay event mapping failed (event_id=%s)", event_id)
            return
        if isinstance(result, EventIgnored) and result.evicted:
            _LOGGER.warning(
                "NeMo Relay scope state evicted (event_id=%s, count=%s)",
                event_id,
                result.evicted,
            )
        try:
            self._dispatch(result, event_id)
        except Exception:
            _LOGGER.exception("NeMo Relay event submission failed (event_id=%s)", event_id)

    def _dispatch(self, result: MappingResult, event_id: str) -> None:
        match result:
            case EventIgnored():
                return
            case EventSkipped(path=path):
                _LOGGER.warning(
                    "NeMo Relay event skipped (event_id=%s, path=%s)",
                    event_id,
                    path,
                )
            case EventMalformed(path=path):
                _LOGGER.warning(
                    "NeMo Relay event malformed (event_id=%s, path=%s)",
                    event_id,
                    path,
                )
            case OperationReady(operation=operation):
                self._submit(operation, event_id)
            case unreachable:
                assert_never(unreachable)

    def _submit(self, operation: Operation, event_id: str) -> None:
        bridge = self._bridge
        if bridge is None:
            _LOGGER.warning(
                "NeMo Relay event dropped: plugin is not active (event_id=%s)",
                event_id,
            )
            return

        record = encode_audr(operation)
        match bridge.submit(record, event_id):
            case HandoffOutcome.SCHEDULED:
                return
            case HandoffOutcome.DROPPED_HANDOFF_FULL:
                _LOGGER.warning(
                    "NeMo Relay event dropped: handoff full (event_id=%s)",
                    event_id,
                )
            case HandoffOutcome.DROPPED_LOOP_UNAVAILABLE:
                _LOGGER.warning(
                    "NeMo Relay event dropped: event loop unavailable (event_id=%s)",
                    event_id,
                )
            case unreachable_outcome:
                assert_never(unreachable_outcome)

    def _on_submit_result(self, outcome: SubmitOutcome | None, event_id: str) -> None:
        if outcome is SubmitOutcome.QUEUED:
            return
        if outcome is None:
            _LOGGER.warning("NeMo Relay submission failed (event_id=%s)", event_id)
        else:
            _LOGGER.warning(
                "NeMo Relay submission dropped (event_id=%s, outcome=%s)",
                event_id,
                outcome,
            )


def _read_payload(event: _RelayEvent) -> tuple[Mapping[str, object] | None, str]:
    try:
        payload = event.to_dict()
    except Exception:
        _LOGGER.exception("NeMo Relay event rejected: to_dict() raised")
        return None, _UNKNOWN_EVENT_ID
    if not isinstance(payload, Mapping):
        _LOGGER.warning("NeMo Relay event rejected: to_dict() did not return a mapping")
        return None, _UNKNOWN_EVENT_ID
    raw_id = payload.get("uuid")
    event_id = raw_id if isinstance(raw_id, str) and is_uuid(raw_id) else _UNKNOWN_EVENT_ID
    return payload, event_id


def _installed_relay_version() -> str | None:
    try:
        return package_version(_RELAY_DISTRIBUTION)
    except PackageNotFoundError:
        return None


def is_supported_relay_version(version: str) -> bool:
    """Return whether an installed Relay version is in the supported series."""
    parts = version.split(".")
    try:
        return (int(parts[0]), int(parts[1])) == _SUPPORTED_RELAY_SERIES
    except (IndexError, ValueError):
        return False


def _require_supported_relay_version() -> str:
    version = _installed_relay_version()
    if version is None:
        raise NeMoRelayCompatibilityError(
            f"NeMo Relay integration requires the '{_RELAY_DISTRIBUTION}' extra"
        )
    if not is_supported_relay_version(version):
        raise NeMoRelayCompatibilityError(
            f"unsupported NeMo Relay version {version}; expected {_SUPPORTED_RELAY_RANGE}"
        )
    return version
