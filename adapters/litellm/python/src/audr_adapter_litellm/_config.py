"""Configuration owned by the LiteLLM adapter."""

from __future__ import annotations

from audr import Attribution, ErrorCode
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_core import PydanticCustomError

_DEFAULT_MAX_PENDING_HANDOFFS = 1000
_MAX_PENDING_HANDOFFS = 100_000


class LiteLLMConfig(BaseModel):
    """Validated settings for one callback instance.

    Attribution defaults may be partial because request metadata can complete
    them: request values win field by field, and ``labels`` merge by key. Values
    that can never be conformant are rejected at construction.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    attribution_defaults: Attribution = Field(default_factory=Attribution)
    max_pending_handoffs: int = Field(
        default=_DEFAULT_MAX_PENDING_HANDOFFS,
        ge=1,
        le=_MAX_PENDING_HANDOFFS,
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


__all__ = ["LiteLLMConfig"]
