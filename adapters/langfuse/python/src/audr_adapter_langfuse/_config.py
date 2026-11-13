"""Configuration owned by the Langfuse adapter."""

from __future__ import annotations

from audr import Attribution, ErrorCode
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_core import PydanticCustomError

_DEFAULT_MAX_PENDING_HANDOFFS = 1000
_MAX_PENDING_HANDOFFS = 100_000
_DEFAULT_MAX_TRACKED_SPANS = 10_000
_MAX_TRACKED_SPANS = 1_000_000


class LangfuseConfig(BaseModel):
    """Validated settings for one processor instance.

    Attribution defaults may be partial because observation metadata can complete
    them: metadata values win field by field, and ``labels`` merge by key. Values
    that can never be conformant are rejected at construction.

    ``provider`` is the provider slug used for a generation or embedding whose span
    names none. Langfuse carries no provider field, so without it such
    observations are skipped rather than attributed to a guessed provider.

    ``max_tracked_spans`` bounds, each, the open spans remembered so a span can inherit
    their ``audr_*`` metadata, and the parent spans remembered because a nested model span
    inside them already produced a record; the oldest is evicted when full.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    attribution_defaults: Attribution = Field(default_factory=Attribution)
    provider: str | None = Field(default=None, pattern=r"^[a-z0-9-]+$")
    max_pending_handoffs: int = Field(
        default=_DEFAULT_MAX_PENDING_HANDOFFS,
        ge=1,
        le=_MAX_PENDING_HANDOFFS,
        strict=True,
    )
    max_tracked_spans: int = Field(
        default=_DEFAULT_MAX_TRACKED_SPANS,
        ge=1,
        le=_MAX_TRACKED_SPANS,
        strict=True,
    )

    @field_validator("attribution_defaults")
    @classmethod
    def _reject_invalid_defaults(cls, value: Attribution) -> Attribution:
        for issue in value.validate():
            if issue.code is ErrorCode.NON_PSEUDONYMOUS_ID:
                raise PydanticCustomError(
                    "audr_attribution_value",
                    "attribution default cannot be billed on",
                )
        return value


__all__ = ["LangfuseConfig"]
