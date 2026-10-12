"""Rules the type system cannot express, plus the bridge from pydantic's errors.

Pydantic already enforces types, enumerants, string shapes and numeric bounds from the
generated model. What is left is the cross-field half of the specification — identifier
formats, millisecond precision, the ``allOf`` operation-shape branches, and the
billability rules stated in prose — and the translation of pydantic's own failures into
the SDK's stable, value-free :class:`~audr.errors.ValidationIssue` catalog.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from audr._time import now_utc
from audr.errors import ValidationIssue
from audr.record._base import ExtensibleBase
from audr.record.codes import PYDANTIC_TYPE_TO_CODE, ErrorCode

if TYPE_CHECKING:  # pragma: no cover - import cycle broken for runtime
    import pydantic

    from audr.record.models import AUDR, Attribution

_SUPPORTED_SPEC_VERSION = re.compile(r"^1\.\d+\.\d+$")
_ULID = re.compile(r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")
_UUID7 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
)
_TRACE_ID = re.compile(r"^[0-9a-f]{32}$")

# Pydantic marks a failing mapping *key* with this sentinel as the last element of `loc`.
_KEY_SENTINEL = "[key]"
# The one object in the schema whose property names come from the caller. Anything directly
# beneath it is caller data and must never reach a path.
_CALLER_KEYED = "labels"
_REDACTED = "*"

_MODEL_OPERATIONS = frozenset({"generation", "embedding", "reranking"})
_TOOL_OPERATIONS = frozenset({"tool_execution", "retrieval"})

# Emitter clocks drift, so a record minted slightly ahead of the validator remains valid.
_FUTURE_SKEW = timedelta(minutes=5)


def issues_from_pydantic(exc: pydantic.ValidationError) -> list[ValidationIssue]:
    """Translate a pydantic failure into the stable AUDR issue catalog."""
    return _dedupe(
        ValidationIssue(_code_for(error), _pointer(error["loc"])) for error in exc.errors()
    )


def version_issues(data: Mapping[str, Any]) -> list[ValidationIssue]:
    """Gate a payload on its declared `spec_version` before the model is built.

    A record that omits its contract version, or declares one this release does not
    implement, is rejected on its own terms rather than as a cascade of field errors.
    """
    if "spec_version" not in data:
        return [ValidationIssue(ErrorCode.REQUIRED, "/spec_version")]
    declared = data["spec_version"]
    if isinstance(declared, str) and not _SUPPORTED_SPEC_VERSION.match(declared):
        return [ValidationIssue(ErrorCode.UNSUPPORTED_VERSION, "/spec_version")]
    return []


def cross_field_issues(record: AUDR, *, now: datetime | None = None) -> list[ValidationIssue]:
    """Every hand-written rule that holds for `record`, in document order."""
    moment = now_utc() if now is None else now
    if moment.tzinfo is None:
        # A naive `now` can only mean UTC here; comparing it to an aware `event_time` would
        # raise, and `validate` promises never to.
        moment = moment.replace(tzinfo=UTC)
    return _dedupe(
        [
            *_envelope_issues(record),
            *_emitter_issues(record),
            *_timing_issues(record, moment),
            *_shape_issues(record),
            *_run_issues(record),
            *attribution_issues(record.attribution),
        ]
    )


def attribution_issues(attribution: Attribution) -> list[ValidationIssue]:
    """Billability rules, with paths relative to the enclosing record."""
    issues: list[ValidationIssue] = []
    if attribution.environment is None:
        issues.append(ValidationIssue(ErrorCode.REQUIRED, "/attribution/environment"))
    elif attribution.environment == "production" and not attribution.account_id:
        issues.append(ValidationIssue(ErrorCode.REQUIRED, "/attribution/account_id"))
    if attribution.user_id is not None and "@" in attribution.user_id:
        issues.append(ValidationIssue(ErrorCode.NON_PSEUDONYMOUS_ID, "/attribution/user_id"))
    return issues


def _envelope_issues(record: AUDR) -> Iterator[ValidationIssue]:
    if not _SUPPORTED_SPEC_VERSION.match(record.spec_version):
        yield ValidationIssue(ErrorCode.UNSUPPORTED_VERSION, "/spec_version")
    if not _is_record_identifier(record.record_id):
        yield ValidationIssue(ErrorCode.INVALID_IDENTIFIER, "/record_id")
    if record.corrects is not None and not _is_record_identifier(record.corrects):
        yield ValidationIssue(ErrorCode.INVALID_IDENTIFIER, "/corrects")


def _emitter_issues(record: AUDR) -> Iterator[ValidationIssue]:
    # The model leaves `emitter` unset so a client can stamp it on delivery; by the time a
    # record is validated it must be there.
    if record.emitter is None:
        yield ValidationIssue(ErrorCode.REQUIRED, "/emitter")


def _timing_issues(record: AUDR, now: datetime) -> Iterator[ValidationIssue]:
    timing = record.timing
    if timing.event_time.microsecond % 1000:
        yield ValidationIssue(ErrorCode.MILLISECOND_PRECISION, "/timing/event_time")
    if timing.event_time > now + _FUTURE_SKEW:
        yield ValidationIssue(ErrorCode.FUTURE_EVENT_TIME, "/timing/event_time")
    if timing.received_time is not None:
        yield ValidationIssue(ErrorCode.FORBIDDEN, "/timing/received_time")


def _shape_issues(record: AUDR) -> Iterator[ValidationIssue]:
    usage = record.usage
    if (usage.llm is None) == (usage.tool is None):
        yield ValidationIssue(ErrorCode.INVALID_STRUCTURE, "/usage")
    if usage.llm is not None and _is_empty_block(usage.llm):
        yield ValidationIssue(ErrorCode.EMPTY_USAGE, "/usage/llm")
    if usage.tool is not None and _is_empty_block(usage.tool):
        yield ValidationIssue(ErrorCode.EMPTY_USAGE, "/usage/tool")

    operation = record.resource.operation
    if operation in _MODEL_OPERATIONS:
        if record.resource.type != "model":
            yield ValidationIssue(ErrorCode.INVALID_STRUCTURE, "/resource/type")
        if record.resource.modality is None:
            yield ValidationIssue(ErrorCode.REQUIRED, "/resource/modality")
        if usage.llm is None:
            yield ValidationIssue(ErrorCode.INVALID_STRUCTURE, "/usage")
        if record.cost is not None and record.cost.tool is not None:
            yield ValidationIssue(ErrorCode.FORBIDDEN, "/cost/tool")
        if record.resource.namespace is not None:
            yield ValidationIssue(ErrorCode.FORBIDDEN, "/resource/namespace")
    elif operation in _TOOL_OPERATIONS:
        if record.resource.type != "tool":
            yield ValidationIssue(ErrorCode.INVALID_STRUCTURE, "/resource/type")
        if usage.tool is None:
            yield ValidationIssue(ErrorCode.INVALID_STRUCTURE, "/usage")
        if record.cost is not None and record.cost.llm is not None:
            yield ValidationIssue(ErrorCode.FORBIDDEN, "/cost/llm")


def _run_issues(record: AUDR) -> Iterator[ValidationIssue]:
    trace_id = record.run.trace_id
    if trace_id is not None and not _TRACE_ID.match(trace_id):
        yield ValidationIssue(ErrorCode.INVALID_IDENTIFIER, "/run/trace_id")


def _is_empty_block(block: ExtensibleBase) -> bool:
    if block.extensions:
        return False
    return all(getattr(block, name) is None for name in type(block).model_fields)


def _is_record_identifier(value: str) -> bool:
    return bool(_ULID.match(value) or _UUID7.match(value))


def _code_for(error: Any) -> ErrorCode:
    kind = str(error["type"])
    field_specific = _field_specific_code(kind, tuple(error["loc"]))
    if field_specific is not None:
        return field_specific
    mapped = PYDANTIC_TYPE_TO_CODE.get(kind)
    if mapped is not None:
        return mapped
    if kind.startswith("datetime"):
        return ErrorCode.INVALID_DATETIME
    if kind == "value_error":
        # `ExtensibleBase` rejects stray keys with a ValueError; everything else that
        # raises from a validator is a counter that failed its own bounds.
        message = str(error.get("msg", "")).lower()
        if "unknown property" in message:
            return ErrorCode.UNKNOWN_PROPERTY
        return ErrorCode.INVALID_COUNTER
    return ErrorCode.INVALID_TYPE


def _field_specific_code(kind: str, loc: tuple[Any, ...]) -> ErrorCode | None:
    """Codes the generic table cannot reach, because the field decides them, not the failure.

    Both are string-constraint failures that the table would flatten to `INVALID_STRING`, which
    tells a caller far less than the code the catalog reserves for them.
    """
    if loc and loc[-1] == _KEY_SENTINEL and _CALLER_KEYED in loc:
        return ErrorCode.INVALID_PROPERTY_NAME
    if kind == "string_pattern_mismatch" and loc and loc[-1] == "currency":
        return ErrorCode.INVALID_CURRENCY
    return None


def _pointer(loc: tuple[Any, ...]) -> str:
    """An RFC 6901 pointer that carries no record values.

    Schema property names are part of the specification and are safe to name. A caller's own
    map keys are not — a label named after an email address would otherwise be copied verbatim
    into an error message — so they are replaced by a placeholder.
    """
    parts = [str(part) for part in loc]
    if parts and parts[-1] == _KEY_SENTINEL:
        parts.pop()
    segments: list[str] = []
    for index, part in enumerate(parts):
        caller_supplied = index > 0 and parts[index - 1] == _CALLER_KEYED
        segments.append(_REDACTED if caller_supplied else _escape(part))
    return "/" + "/".join(segments)


def _escape(segment: str) -> str:
    return segment.replace("~", "~0").replace("/", "~1")


def _dedupe(issues: Iterable[ValidationIssue]) -> list[ValidationIssue]:
    seen: dict[ValidationIssue, None] = {}
    for issue in issues:
        seen.setdefault(issue, None)
    return list(seen)
