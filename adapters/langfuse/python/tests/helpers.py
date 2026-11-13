"""Shared span fixtures."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from audr import Attribution
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanContext, Status, StatusCode

from audr_adapter_langfuse._mapping import MappingResult, RecordReady, map_span

TRACE_ID = 0x0AF7651916CD43DD8448EB211C80319C
SPAN_ID = 0x00F067AA0BA902B7
PARENT_ID = 0x00000000000000AA
START_NS = 1_789_000_000_123_456_789
END_NS = START_NS + 125_400_000


def generation_attributes(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "langfuse.observation.type": "generation",
        "langfuse.observation.model.name": "gpt-5.6-luna",
        "langfuse.observation.usage_details": json.dumps({"input": 120, "output": 40}),
        "langfuse.observation.input": "SECRET-PROMPT",
        "langfuse.observation.output": "SECRET-COMPLETION",
    }
    values.update(overrides)
    return {key: value for key, value in values.items() if value is not None}


def span(
    attributes: dict[str, Any] | None = None,
    *,
    name: str = "llm",
    error: bool = False,
    parent: bool = True,
) -> ReadableSpan:
    return ReadableSpan(
        name=name,
        context=SpanContext(TRACE_ID, SPAN_ID, is_remote=False),
        parent=SpanContext(TRACE_ID, PARENT_ID, is_remote=False) if parent else None,
        attributes=generation_attributes() if attributes is None else attributes,
        status=Status(StatusCode.ERROR if error else StatusCode.UNSET),
        start_time=START_NS,
        end_time=END_NS,
    )


def map_result(
    readable: ReadableSpan | None = None,
    *,
    defaults: Attribution | None = None,
    provider: str | None = "openai",
    ancestors: Sequence[Mapping[str, object]] = (),
) -> MappingResult:
    return map_span(
        span() if readable is None else readable,
        attribution_defaults=defaults or Attribution(environment="test"),
        provider=provider,
        ancestors=ancestors,
    )


def ready(result: object) -> RecordReady:
    assert isinstance(result, RecordReady)
    assert result.record.validate() == []
    return result
