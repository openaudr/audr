"""Privacy-preserving mapping from canonical Relay events to SDK records.

Only the fields needed to meter an operation are read. Relay carries prompts,
model responses, tool arguments, and tool results under ``data``, which nothing
here touches.
"""

from __future__ import annotations

import math
import re
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock
from typing import TypeAlias, assert_never
from uuid import UUID

from audr import (
    AUDR,
    SPEC_VERSION,
    Attribution,
    Cost,
    Emitter,
    LlmUsage,
    Resource,
    Run,
    Timing,
    ToolUsage,
    Usage,
)
from audr.ids import uuid7
from pydantic import ValidationError

from audr_adapter_nemo_relay._attribution import resolve_attribution
from audr_adapter_nemo_relay._errors import NeMoRelayRunErrorCode
from audr_adapter_nemo_relay._version import __version__

_EMITTER_NAME = "audr-adapter-nemo-relay"
_TOOL_PROVIDER = "self-hosted"
_TOOL_TYPE = "invocation"
_METADATA_NAMESPACE = "audr"
_OTEL_STATUS_KEY = "otel.status_code"
_OTEL_STATUS_ERROR = "ERROR"
_METERED_CATEGORIES = frozenset({"llm", "tool"})
# Relay codecs whose `prompt_tokens` already excludes cache reads and writes.
_EXCLUSIVE_PROMPT_APIS = frozenset({"anthropic_messages"})
_PROVIDER_REPORTED_COST = "provider_reported"
# AUDR restricts resource.provider to this alphabet; Relay scope names are free-form.
_PROVIDER_ALLOWED = re.compile(r"[^a-z0-9-]+")


@dataclass(frozen=True, slots=True)
class MeteredOperation:
    """Identity, timing, and attribution shared by every metered operation.

    ``scope_id`` is the Relay scope's own UUID. It becomes ``run.span_id`` on the
    encoded record; it is not a conformant AUDR ``record_id`` because Relay's scope
    UUIDs are not UUIDv7, so :func:`encode_audr` mints a fresh one for that field.
    """

    scope_id: str
    run_id: str
    parent_span_id: str | None
    event_time: datetime
    duration_ms: int
    provider: str
    attribution: Attribution


@dataclass(frozen=True, slots=True)
class LlmOperation(MeteredOperation):
    """One completed Relay-managed model call."""

    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    cost: Cost | None = None


@dataclass(frozen=True, slots=True)
class ToolOperation(MeteredOperation):
    """One completed Relay-managed tool execution."""

    tool: str
    failed: bool = False


Operation: TypeAlias = LlmOperation | ToolOperation


@dataclass(frozen=True, slots=True)
class EventIgnored:
    """The event carries no metered operation."""

    evicted: int = 0


@dataclass(frozen=True, slots=True)
class OperationReady:
    """A completed operation ready to encode."""

    operation: Operation


@dataclass(frozen=True, slots=True)
class EventSkipped:
    """A metered operation the integration cannot attribute or meter."""

    path: str


@dataclass(frozen=True, slots=True)
class EventMalformed:
    """The event did not match Relay's documented shape."""

    path: str


MappingResult: TypeAlias = EventIgnored | OperationReady | EventSkipped | EventMalformed


@dataclass(frozen=True, slots=True)
class _ScopeState:
    parent_uuid: str | None
    root_uuid: str
    started_at: datetime
    attribution: Attribution | None
    attribution_issue: str | None


class MappingFailure(Exception):
    """Internal signal carrying the pointer that stopped a normalization."""

    def __init__(self, result: EventSkipped | EventMalformed) -> None:
        self.result = result
        super().__init__(result.path)


@dataclass(frozen=True, slots=True)
class _SharedFields:
    """Fields resolved from scope state before the category is normalized."""

    scope_id: str
    run_id: str
    parent_span_id: str | None
    event_time: datetime
    duration_ms: int
    attribution: Attribution


class ScopeTracker:
    """Track open Relay scopes and complete them into metered operations.

    Attribution is snapshotted onto every scope at start, so completing a child
    never depends on its ancestors still being tracked.

    Retired scope IDs are remembered so an unobserved parent can be told apart
    from a lost one. Relay never emits the outermost scope's own parent, so a
    parent we have never seen means "this is the billing root" and static
    defaults apply. A parent we saw and then dropped means the ancestor that
    carried attribution is gone, and billing its children to static defaults
    could charge the wrong subscription.
    """

    def __init__(self, *, defaults: Attribution, max_scopes: int) -> None:
        self._defaults = defaults
        self._max_scopes = max_scopes
        self._scopes: OrderedDict[str, _ScopeState] = OrderedDict()
        self._retired: OrderedDict[str, None] = OrderedDict()
        self._lock = Lock()

    def consume(self, event: Mapping[str, object]) -> MappingResult:
        """Track structural events and return a completed metered operation."""
        with self._lock:
            return self._consume(event)

    def clear(self) -> None:
        """Drop incomplete scope state so a shutdown cannot retain it."""
        with self._lock:
            self._scopes.clear()
            self._retired.clear()

    def _consume(self, event: Mapping[str, object]) -> MappingResult:
        if event.get("kind") != "scope":
            return EventIgnored()
        scope_category = event.get("scope_category")
        if scope_category not in {"start", "end"}:
            return EventMalformed("/scope_category")
        scope_uuid = event.get("uuid")
        if not isinstance(scope_uuid, str) or not is_uuid(scope_uuid):
            return EventMalformed("/uuid")
        timestamp = _parse_timestamp(event.get("timestamp"))
        if timestamp is None:
            return EventMalformed("/timestamp")

        parent_uuid = event.get("parent_uuid")
        if parent_uuid is not None and (
            not isinstance(parent_uuid, str) or not is_uuid(parent_uuid)
        ):
            return EventMalformed("/parent_uuid")

        if scope_category == "start":
            return self._track_start(
                scope_uuid=scope_uuid,
                parent_uuid=parent_uuid,
                timestamp=timestamp,
                metadata=event.get("metadata"),
            )
        return self._complete(event=event, scope_uuid=scope_uuid, timestamp=timestamp)

    def _track_start(
        self,
        *,
        scope_uuid: str,
        parent_uuid: str | None,
        timestamp: datetime,
        metadata: object,
    ) -> MappingResult:
        self._scopes[scope_uuid] = self._start_state(
            scope_uuid=scope_uuid,
            parent_uuid=parent_uuid,
            timestamp=timestamp,
            metadata=metadata,
        )
        self._scopes.move_to_end(scope_uuid)
        return EventIgnored(evicted=self._evict_overflow())

    def _start_state(
        self,
        *,
        scope_uuid: str,
        parent_uuid: str | None,
        timestamp: datetime,
        metadata: object,
    ) -> _ScopeState:
        declares_own = _declares_attribution(metadata)
        parent = self._scopes.get(parent_uuid) if parent_uuid is not None else None
        if parent is not None and not declares_own:
            return _ScopeState(
                parent_uuid=parent_uuid,
                root_uuid=parent.root_uuid,
                started_at=timestamp,
                attribution=parent.attribution,
                attribution_issue=parent.attribution_issue,
            )
        if not declares_own and parent_uuid is not None and parent_uuid in self._retired:
            return _ScopeState(
                parent_uuid=parent_uuid,
                root_uuid=scope_uuid,
                started_at=timestamp,
                attribution=None,
                attribution_issue="/scope/parent_uuid",
            )
        attribution, attribution_issue = resolve_attribution(
            defaults=self._defaults,
            metadata=metadata,
        )
        return _ScopeState(
            parent_uuid=parent_uuid,
            root_uuid=scope_uuid,
            started_at=timestamp,
            attribution=attribution,
            attribution_issue=attribution_issue,
        )

    def _evict_overflow(self) -> int:
        evicted = 0
        while len(self._scopes) > self._max_scopes:
            retired_uuid, _ = self._scopes.popitem(last=False)
            self._retire(retired_uuid)
            evicted += 1
        return evicted

    def _retire(self, scope_uuid: str) -> None:
        self._retired[scope_uuid] = None
        self._retired.move_to_end(scope_uuid)
        while len(self._retired) > self._max_scopes:
            self._retired.popitem(last=False)

    def _complete(
        self,
        *,
        event: Mapping[str, object],
        scope_uuid: str,
        timestamp: datetime,
    ) -> MappingResult:
        state = self._scopes.pop(scope_uuid, None)
        if state is not None:
            self._retire(scope_uuid)
        category = event.get("category")
        if category not in _METERED_CATEGORIES:
            return EventIgnored()
        if state is None:
            return EventSkipped("/scope/start")
        if state.attribution is None:
            return EventSkipped(state.attribution_issue or "/attribution")

        is_billing_root = state.root_uuid == scope_uuid
        shared = _SharedFields(
            scope_id=scope_uuid,
            run_id=state.root_uuid,
            # A billing root's Relay parent is never emitted as a record of its own.
            parent_span_id=None if is_billing_root else state.parent_uuid,
            event_time=timestamp,
            duration_ms=_elapsed_ms(state.started_at, timestamp),
            attribution=state.attribution,
        )
        try:
            if category == "llm":
                return OperationReady(_normalize_llm(event, shared))
            return OperationReady(_normalize_tool(event, shared))
        except MappingFailure as failure:
            return failure.result


def _normalize_llm(event: Mapping[str, object], shared: _SharedFields) -> LlmOperation:
    profile = _required_mapping(event.get("category_profile"), "/category_profile")
    annotation = _required_mapping(
        profile.get("annotated_response"),
        "/category_profile/annotated_response",
        skipped=True,
    )
    usage = _required_mapping(
        annotation.get("usage"),
        "/category_profile/annotated_response/usage",
        skipped=True,
    )
    # AUDR wants the provider's verbatim model identifier; the caller's name is the fallback.
    model = _first_non_empty_string(annotation.get("model"), profile.get("model_name"))
    if model is None:
        raise MappingFailure(EventSkipped("/category_profile/annotated_response/model"))
    cache_read = _optional_counter(usage, "cache_read_tokens")
    cache_write = _optional_counter(usage, "cache_write_tokens")
    input_tokens = _optional_counter(usage, "prompt_tokens")
    if not _reports_exclusive_prompt(annotation):
        input_tokens = _exclusive_count(input_tokens, cache_read, cache_write)
    output_tokens = _optional_counter(usage, "completion_tokens")
    return LlmOperation(
        scope_id=shared.scope_id,
        run_id=shared.run_id,
        parent_span_id=shared.parent_span_id,
        event_time=shared.event_time,
        duration_ms=shared.duration_ms,
        provider=_provider_from(event),
        attribution=shared.attribution,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
        cost=_provider_reported_cost(usage.get("cost")),
    )


def _normalize_tool(event: Mapping[str, object], shared: _SharedFields) -> ToolOperation:
    tool = _first_non_empty_string(event.get("name"))
    if tool is None:
        raise MappingFailure(EventMalformed("/name"))
    metadata = event.get("metadata")
    failed = isinstance(metadata, Mapping) and metadata.get(_OTEL_STATUS_KEY) == _OTEL_STATUS_ERROR
    return ToolOperation(
        scope_id=shared.scope_id,
        run_id=shared.run_id,
        parent_span_id=shared.parent_span_id,
        event_time=shared.event_time,
        duration_ms=shared.duration_ms,
        provider=_TOOL_PROVIDER,
        attribution=shared.attribution,
        tool=tool,
        failed=failed,
    )


def encode_audr(operation: Operation) -> AUDR:
    """Encode one normalized operation as typed AUDR."""
    match operation:
        case LlmOperation():
            usage = Usage(
                llm=LlmUsage(
                    input_tokens=operation.input_tokens,
                    output_tokens=operation.output_tokens,
                    cache_read_tokens=operation.cache_read_tokens,
                    cache_write_tokens=operation.cache_write_tokens,
                    requests=1,
                )
            )
            resource = Resource(
                provider=operation.provider,
                type="model",
                name=operation.model,
                operation="generation",
                # Relay's LLM scopes report token counters only, with no
                # modality of their own, and a token-metered call is text.
                modality="text",
            )
            error_code = None
            cost = operation.cost
        case ToolOperation():
            usage = Usage(tool=ToolUsage(type=_TOOL_TYPE, call_count=1))
            resource = Resource(
                provider=operation.provider,
                type="tool",
                name=operation.tool,
                operation="tool_execution",
            )
            error_code = NeMoRelayRunErrorCode.TOOL_ERROR if operation.failed else None
            cost = None
        case unreachable:
            assert_never(unreachable)

    return AUDR(
        spec_version=SPEC_VERSION,
        # Relay's scope UUIDs are not UUIDv7, so `record_id` is minted fresh here;
        # the scope identity that ties related records together lives in `run.span_id`.
        record_id=uuid7(),
        emitter=Emitter(name=_EMITTER_NAME, version=__version__, component="harness"),
        timing=Timing(
            event_time=_to_millisecond_precision(operation.event_time),
            duration_ms=operation.duration_ms,
        ),
        resource=resource,
        usage=usage,
        run=Run(
            run_id=operation.run_id,
            span_id=operation.scope_id,
            parent_span_id=operation.parent_span_id,
            error_code=error_code,
        ),
        attribution=operation.attribution,
        cost=cost,
    )


def is_uuid(value: str) -> bool:
    """Return whether the value is a canonically formatted UUID."""
    try:
        return str(UUID(value)) == value.lower()
    except ValueError:
        return False


def _declares_attribution(metadata: object) -> bool:
    return isinstance(metadata, Mapping) and _METADATA_NAMESPACE in metadata


def _provider_from(event: Mapping[str, object]) -> str:
    name = _first_non_empty_string(event.get("name"))
    if name is None:
        raise MappingFailure(EventMalformed("/name"))
    provider = _PROVIDER_ALLOWED.sub("-", name.lower()).strip("-")
    if not provider:
        raise MappingFailure(EventMalformed("/name"))
    return provider


def _first_non_empty_string(*candidates: object) -> str | None:
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _required_mapping(
    value: object,
    path: str,
    *,
    skipped: bool = False,
) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return value
    raise MappingFailure(EventSkipped(path) if skipped else EventMalformed(path))


def _reports_exclusive_prompt(annotation: Mapping[str, object]) -> bool:
    api_specific = annotation.get("api_specific")
    return isinstance(api_specific, Mapping) and api_specific.get("api") in _EXCLUSIVE_PROMPT_APIS


def _exclusive_count(total: int | None, *parts: int | None) -> int | None:
    """Remove the separately reported parts from an inclusive total."""
    if total is None or all(part is None for part in parts):
        return total
    return max(0, total - sum(part or 0 for part in parts))


def _provider_reported_cost(value: object) -> Cost | None:
    """Return the provider's cost if it is reported."""
    if not isinstance(value, Mapping) or value.get("source") != _PROVIDER_REPORTED_COST:
        return None
    try:
        cost = Cost.model_validate(
            {"total_cost": value.get("total"), "currency": value.get("currency")}, strict=True
        )
    except ValidationError:
        # The error embeds input values, so it is discarded rather than logged.
        return None
    # `Cost` admits infinity, which serializes as null.
    return cost if math.isfinite(cost.total_cost) else None


def _optional_counter(values: Mapping[str, object], key: str) -> int | None:
    value = values.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise MappingFailure(EventMalformed(f"/category_profile/annotated_response/usage/{key}"))
    return value


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(UTC)


def _to_millisecond_precision(value: datetime) -> datetime:
    """Truncate to the millisecond precision AUDR requires of ``event_time``."""
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def _elapsed_ms(start: datetime, end: datetime) -> int:
    """Return whole elapsed milliseconds, measured before any truncation."""
    return max(0, int((end - start).total_seconds() * 1000))
