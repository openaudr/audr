"""The public AUDR record model.

The shape of a record comes from the specification, so it is generated into
:mod:`audr.record._schema` and never written by hand. What lives here is the behaviour the
SDK owns on top of that shape: the identifiers and timestamps an emitter should not have to
supply, the parse/serialize boundary, and the prose rules a JSON Schema cannot state.

Three generated classes are subclassed. ``Timing`` gains a default ``event_time`` so a caller
can time an operation by building the record at the end of it. ``Attribution`` gains its
billability rules. ``AUDR`` gains SDK-owned defaults, and re-declares ``timing``
and ``attribution`` with the subclass types so parsing builds the richer classes. Every other
block is re-exported exactly as generated.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Literal

import pydantic
from pydantic import AwareDatetime, Field

from audr._time import now_utc
from audr.errors import ValidationError, ValidationIssue
from audr.ids import uuid7
from audr.record import _encode, _schema, _validate
from audr.record._schema import (
    Cost,
    Emitter,
    LlmCost,
    LlmUsage,
    Resource,
    Run,
    ToolCost,
    ToolUsage,
    Usage,
)
from audr.record.codes import ErrorCode

#: The one AUDR release this package implements.
SPEC_VERSION = "1.1.0"

# Names for the closed vocabularies of the schema, so callers can annotate their own code
# without reaching into the generated module. `tests/test_models.py` asserts each one still
# matches the generated field it mirrors.
EmitterComponent = Literal["harness", "router", "provider"]
ResourceType = Literal["model", "tool"]
Operation = Literal["generation", "embedding", "reranking", "tool_execution", "retrieval"]
Modality = Literal["text", "image", "audio", "multimodal"]
RunType = Literal["agent_run", "workflow", "single_call"]
RunOutcome = Literal["resolved", "escalated", "abandoned", "failed"]
Environment = Literal["production", "staging", "development", "test", "evaluation"]

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class Timing(_schema.Timing):
    """Timing observations, with `event_time` defaulting to the moment of construction."""

    event_time: AwareDatetime = Field(default_factory=now_utc)


class Attribution(_schema.Attribution):
    """Allocation dimensions, plus the billability rules the specification states in prose."""

    def validate(self) -> list[ValidationIssue]:  # type: ignore[override]
        """Every billability issue, with paths relative to the enclosing record."""
        return _validate.attribution_issues(self)


class AUDR(_schema.AUDR):
    """One metered operation in an agent system.

    The generated model requires `spec_version`, `record_id` and `emitter`; all three are
    SDK-owned, so they are defaulted here. `emitter` stays `None` until a client stamps it on
    delivery, and :meth:`validate` reports its absence rather than the constructor.
    """

    spec_version: str = SPEC_VERSION
    record_id: str = Field(default_factory=uuid7)
    # Deliberately widened: a client stamps the emitter on delivery, and `validate` reports
    # its absence with a stable code instead of pydantic reporting it as a missing field.
    emitter: Emitter | None = None  # type: ignore[assignment]
    # Re-declared so parsing builds the subclasses above rather than the generated bases.
    timing: Timing
    attribution: Attribution

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> AUDR:
        """Parse an already-decoded record, raising :class:`ValidationError` on any issue."""
        version_issues = _validate.version_issues(data)
        if version_issues:
            raise ValidationError(version_issues)
        try:
            record = cls.model_validate(dict(data))
        except pydantic.ValidationError as exc:
            raise ValidationError(_validate.issues_from_pydantic(exc)) from None
        return record.ensure_valid()

    @classmethod
    def from_json(cls, text: str | bytes) -> AUDR:
        """Parse a JSON record, raising :class:`ValidationError` on any issue."""
        try:
            data = json.loads(text)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValidationError([ValidationIssue(ErrorCode.NOT_JSON, "/")]) from None
        if not isinstance(data, dict):
            raise ValidationError([ValidationIssue(ErrorCode.INVALID_TYPE, "/")])
        return cls.from_dict(data)

    def validate(self, *, now: datetime | None = None) -> list[ValidationIssue]:  # type: ignore[override]
        """Every rule this record breaks; empty when it is conformant.

        Returns the issues rather than raising.
        """
        return _validate.cross_field_issues(self, now=now)

    def ensure_valid(self) -> AUDR:
        """Return this record, or raise :class:`ValidationError` carrying every issue."""
        issues = self.validate()
        if issues:
            raise ValidationError(issues)
        return self

    def to_dict(self) -> dict[str, Any]:
        """The record as plain JSON types: absent optionals dropped, timestamps RFC 3339."""
        return _encode.to_plain(self)

    def to_json(self, *, indent: int | None = None) -> str:
        """The record as JSON with sorted keys; compact unless `indent` is given."""
        return _encode.to_json(self.to_dict(), indent=indent)

    def with_emitter(self, emitter: Emitter) -> AUDR:
        """A copy stamped with `emitter`, for a client that identifies itself on delivery."""
        return self.model_copy(update={"emitter": emitter})

    @property
    def event_time_ms(self) -> int:
        """`timing.event_time` as whole milliseconds since the Unix epoch."""
        elapsed = self.timing.event_time - _EPOCH
        return elapsed.days * 86_400_000 + elapsed.seconds * 1_000 + elapsed.microseconds // 1_000


__all__ = [
    "AUDR",
    "SPEC_VERSION",
    "Attribution",
    "Cost",
    "Emitter",
    "EmitterComponent",
    "Environment",
    "LlmCost",
    "LlmUsage",
    "Modality",
    "Operation",
    "Resource",
    "ResourceType",
    "Run",
    "RunOutcome",
    "RunType",
    "Timing",
    "ToolCost",
    "ToolUsage",
    "Usage",
]
