"""Processor configuration."""

from __future__ import annotations

import pytest
from audr import Attribution
from pydantic import ValidationError

from audr_adapter_langfuse import LangfuseConfig


def test_defaults() -> None:
    config = LangfuseConfig()

    assert config.max_pending_handoffs == 1000
    assert config.max_tracked_spans == 10_000
    assert config.provider is None
    assert config.attribution_defaults == Attribution()


@pytest.mark.parametrize(
    "overrides",
    [
        {"provider": "Open AI"},
        {"provider": ""},
        {"max_pending_handoffs": 0},
        {"max_pending_handoffs": 100_001},
        {"max_pending_handoffs": "10"},
        {"max_tracked_spans": 0},
        {"max_tracked_spans": 1_000_001},
        {"attribution_defaults": Attribution(user_id="someone@example.com")},
        {"unknown": True},
    ],
)
def test_rejects_invalid_settings(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        LangfuseConfig.model_validate(overrides)
