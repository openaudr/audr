"""Privacy-preserving mapping from LiteLLM callback data to AUDR."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import Annotated, TypeAlias, TypeVar

from audr import (
    AUDR,
    Attribution,
    Cost,
    Emitter,
    LlmUsage,
    Modality,
    Operation,
    Resource,
    Run,
    RunType,
    Timing,
    Usage,
)
from audr.ids import uuid7
from pydantic import (
    AliasChoices,
    AliasPath,
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    ValidationError,
)

from audr_adapter_litellm._errors import LiteLLMRunErrorCode
from audr_adapter_litellm._version import __version__

_EMITTER_NAME = "audr-adapter-litellm"
_PROVIDER_DISALLOWED = re.compile(r"[^a-z0-9-]+")
_GENERATION_CALLS = frozenset(
    {
        "acompletion",
        "aresponses",
        "atext_completion",
        "completion",
        "responses",
        "text_completion",
    }
)
_EMBEDDING_CALLS = frozenset({"aembedding", "embedding", "embeddings"})
_RERANK_CALLS = frozenset({"arerank", "rerank"})
_ATTRIBUTION_FIELDS = set(Attribution.model_fields)
_MISSING = object()


class _RunMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    run_id: str | None = None
    span_id: str | None = None
    parent_span_id: str | None = None
    step: int | None = None
    trace_id: str | None = None
    run_type: RunType | None = None


class _ResourceMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    modality: Modality = "text"
    key_name: str | None = None
    region: str | None = None
    deployment: str | None = None


class _AudrMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    attribution: Attribution | None = None
    run: _RunMetadata = _RunMetadata()
    resource: _ResourceMetadata = _ResourceMetadata()


_Count: TypeAlias = Annotated[int, Field(ge=0, strict=True)]
_AMOUNT: TypeAdapter[float] = TypeAdapter(
    Annotated[float, Field(ge=0, allow_inf_nan=False, strict=True)]
)
_Parsed = TypeVar("_Parsed", bound=BaseModel)


def _alias(*choices: str | tuple[str, str]) -> AliasChoices:
    return AliasChoices(*(AliasPath(*c) if isinstance(c, tuple) else c for c in choices))


class _TokenUsage(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    input_total: _Count | None = Field(
        None, validation_alias=_alias("prompt_tokens", "input_tokens")
    )
    output_total: _Count | None = Field(
        None, validation_alias=_alias("completion_tokens", "output_tokens")
    )
    total: _Count | None = Field(None, validation_alias="total_tokens")
    cache_read: _Count | None = Field(
        None,
        validation_alias=_alias(
            "cache_read_input_tokens",
            ("prompt_tokens_details", "cached_tokens"),
            ("input_tokens_details", "cached_tokens"),
        ),
    )
    cache_write: _Count | None = Field(
        None,
        validation_alias=_alias(
            "cache_creation_input_tokens",
            ("prompt_tokens_details", "cache_creation_tokens"),
            ("input_tokens_details", "cache_creation_tokens"),
        ),
    )
    reasoning: _Count | None = Field(
        None,
        validation_alias=_alias(
            ("completion_tokens_details", "reasoning_tokens"),
            ("output_tokens_details", "reasoning_tokens"),
            "reasoning_tokens",
        ),
    )


class _RerankMeta(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    input_tokens: _Count | None = Field(None, validation_alias=AliasPath("tokens", "input_tokens"))
    output_tokens: _Count | None = Field(
        None, validation_alias=AliasPath("tokens", "output_tokens")
    )
    billed_total: _Count | None = Field(
        None, validation_alias=AliasPath("billed_units", "total_tokens")
    )
    search_units: _Count | None = Field(
        None, validation_alias=AliasPath("billed_units", "search_units")
    )


def _parse(model: type[_Parsed], value: object, root: str) -> _Parsed | RecordMalformed:
    try:
        return model.model_validate(_compact(value))
    except ValidationError as error:
        loc = error.errors(include_url=False, include_input=False)[0]["loc"]
        return RecordMalformed(root + "".join(f"/{part}" for part in loc))


def _compact(value: object) -> object:
    if isinstance(value, BaseModel):
        value = value.model_dump(warnings=False)
    if isinstance(value, Mapping):
        return {key: _compact(item) for key, item in value.items() if item is not None}
    return value


@dataclass(frozen=True, slots=True)
class RecordReady:
    """A callback carried enough metering data to emit a record."""

    record: AUDR


@dataclass(frozen=True, slots=True)
class RecordSkipped:
    """A callback was valid but had no billable AUDR representation."""

    path: str


@dataclass(frozen=True, slots=True)
class RecordMalformed:
    """A documented callback field had an invalid shape."""

    path: str


MappingResult: TypeAlias = RecordReady | RecordSkipped | RecordMalformed


def map_callback(
    *,
    kwargs: object,
    response: object,
    start_time: object,
    end_time: object,
    attribution_defaults: Attribution,
    failed: bool,
) -> MappingResult:
    """Map one request-level LiteLLM callback without reading request content."""
    if not isinstance(kwargs, Mapping):
        return RecordMalformed("/")
    if kwargs.get("cache_hit") is True:
        return RecordSkipped("/cache_hit")

    metadata_result = _parse_metadata(kwargs)
    if isinstance(metadata_result, RecordMalformed):
        return metadata_result
    metadata = metadata_result

    attribution_result = _resolve_attribution(
        defaults=attribution_defaults,
        overrides=metadata.attribution,
    )
    if isinstance(attribution_result, RecordSkipped):
        return attribution_result
    attribution = attribution_result

    operation = _operation_from(kwargs.get("call_type"))
    if operation is None:
        return RecordSkipped("/call_type")

    provider = _provider_from(kwargs)
    usage_result = _usage_from(response, operation, provider)
    if isinstance(usage_result, RecordMalformed):
        return usage_result
    cost = _cost_from(kwargs, response)
    if isinstance(cost, RecordMalformed):
        return cost
    # LiteLLM zeroes response_cost on every failure, so only a positive cost
    # shows that a failed call was billed.
    cost_is_evidence = cost is not None and (cost.total_cost > 0 or not failed)
    if usage_result is None and not cost_is_evidence:
        return RecordSkipped("/usage")

    if provider is None:
        return RecordSkipped("/custom_llm_provider")
    model = _model_from(kwargs, response)
    if model is None:
        return RecordSkipped("/model")

    timing = _timing_from(start_time, end_time)
    if timing is None:
        return RecordMalformed("/timing")

    resource = _parse(
        Resource,
        {
            "provider": provider,
            "type": "model",
            "name": model,
            "operation": operation,
            **metadata.resource.model_dump(exclude_none=True),
        },
        "/resource",
    )
    if isinstance(resource, RecordMalformed):
        return resource
    run = _run_from(kwargs, metadata.run, failed=failed)
    if isinstance(run, RecordMalformed):
        return run

    usage = usage_result or LlmUsage(requests=1)
    record = AUDR(
        emitter=Emitter(component="router", name=_EMITTER_NAME, version=__version__),
        timing=timing,
        resource=resource,
        usage=Usage(llm=usage),
        run=run,
        attribution=attribution,
        cost=cost,
    )
    issues = record.validate()
    if issues:
        return RecordMalformed(issues[0].path)
    return RecordReady(record)


def _parse_metadata(kwargs: Mapping[object, object]) -> _AudrMetadata | RecordMalformed:
    litellm_params = kwargs.get("litellm_params")
    if litellm_params is None:
        return _AudrMetadata()
    if not isinstance(litellm_params, Mapping):
        return RecordMalformed("/litellm_params")
    metadata = litellm_params.get("metadata")
    if metadata is None:
        return _AudrMetadata()
    if not isinstance(metadata, Mapping):
        return RecordMalformed("/litellm_params/metadata")
    namespace = metadata.get("audr")
    if namespace is None:
        return _AudrMetadata()
    if not isinstance(namespace, Mapping):
        return RecordMalformed("/litellm_params/metadata/audr")
    try:
        return _AudrMetadata.model_validate(dict(namespace))
    except ValidationError:
        return RecordMalformed("/litellm_params/metadata/audr")


def _resolve_attribution(
    *,
    defaults: Attribution,
    overrides: Attribution | None,
) -> Attribution | RecordSkipped:
    values = defaults.model_dump(include=_ATTRIBUTION_FIELDS, exclude_none=True)
    if overrides is not None:
        values |= overrides.model_dump(include=_ATTRIBUTION_FIELDS, exclude_unset=True)
        labels = {**(defaults.labels or {}), **(overrides.labels or {})}
        if labels:
            values["labels"] = labels
        else:
            values.pop("labels", None)
    try:
        attribution = Attribution.model_validate(values)
    except ValidationError:
        return RecordSkipped("/attribution")
    issues = attribution.validate()
    if issues:
        return RecordSkipped(issues[0].path)
    return attribution


def _operation_from(value: object) -> Operation | None:
    if isinstance(value, Enum):
        value = value.value
    if not isinstance(value, str):
        return None
    normalized = value.lower()
    if normalized in _GENERATION_CALLS:
        return "generation"
    if normalized in _EMBEDDING_CALLS:
        return "embedding"
    if normalized in _RERANK_CALLS:
        return "reranking"
    return None


def _usage_from(
    response: object,
    operation: Operation,
    provider: str | None,
) -> LlmUsage | RecordMalformed | None:
    usage = _field(response, "usage")
    if usage is not _MISSING and usage is not None:
        return _standard_usage_from(usage)
    if operation == "reranking":
        return _rerank_usage_from(response, provider)
    return None


def _standard_usage_from(usage: object) -> LlmUsage | RecordMalformed | None:
    parsed = _parse(_TokenUsage, usage, "/usage")
    if isinstance(parsed, RecordMalformed):
        return parsed
    if not parsed.model_fields_set:
        return None
    return LlmUsage(
        input_tokens=_exclusive(parsed.input_total, parsed.cache_read, parsed.cache_write),
        output_tokens=_exclusive(parsed.output_total, parsed.reasoning),
        cache_read_tokens=parsed.cache_read,
        cache_write_tokens=parsed.cache_write,
        reasoning_tokens=parsed.reasoning,
        requests=1,
    )


def _rerank_usage_from(response: object, provider: str | None) -> LlmUsage | RecordMalformed | None:
    meta = _field(response, "meta")
    if meta is _MISSING or meta is None:
        return None
    parsed = _parse(_RerankMeta, meta, "/meta")
    if isinstance(parsed, RecordMalformed):
        return parsed
    if not parsed.model_fields_set:
        return None
    input_count = parsed.input_tokens
    if input_count is None and parsed.billed_total is not None:
        input_count = max(0, parsed.billed_total - (parsed.output_tokens or 0))
    values: dict[str, object] = {
        "input_tokens": input_count,
        "output_tokens": parsed.output_tokens,
        "requests": 1,
    }
    if parsed.search_units is not None and provider is not None:
        values[f"x_{provider.replace('-', '_')}_search_units"] = parsed.search_units
    return LlmUsage.model_validate(values)


def _cost_from(
    kwargs: Mapping[object, object],
    response: object,
) -> Cost | RecordMalformed | None:
    raw = kwargs.get("response_cost", _MISSING)
    if raw is _MISSING or raw is None:
        raw = _field(_field(response, "_hidden_params"), "response_cost")
    if raw is _MISSING or raw is None:
        return None
    try:
        amount = _AMOUNT.validate_python(raw)
    except ValidationError:
        return RecordMalformed("/response_cost")
    # response_cost is net of LiteLLM discounts and margins and includes built-in
    # tool fees, so it is not a gross token cost for cost.llm.
    return Cost(total_cost=amount, currency="USD")


def _provider_from(kwargs: Mapping[object, object]) -> str | None:
    litellm_params = kwargs.get("litellm_params")
    candidates = [kwargs.get("custom_llm_provider")]
    if isinstance(litellm_params, Mapping):
        candidates.append(litellm_params.get("custom_llm_provider"))
    model = kwargs.get("model")
    if isinstance(model, str) and "/" in model:
        candidates.append(model.split("/", 1)[0])
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            provider = _PROVIDER_DISALLOWED.sub("-", candidate.lower()).strip("-")
            if provider:
                return provider
    return None


def _model_from(kwargs: Mapping[object, object], response: object) -> str | None:
    candidates = [_field(response, "model")]
    litellm_params = kwargs.get("litellm_params")
    if isinstance(litellm_params, Mapping):
        candidates.append(litellm_params.get("model"))
    candidates.append(kwargs.get("model"))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _timing_from(start_time: object, end_time: object) -> Timing | None:
    start = _datetime(start_time)
    end = _datetime(end_time)
    if start is None or end is None:
        return None
    duration_ms = max(0, int((end - start).total_seconds() * 1000))
    return Timing(
        event_time=end.replace(microsecond=(end.microsecond // 1000) * 1000),
        duration_ms=duration_ms,
    )


def _run_from(
    kwargs: Mapping[object, object],
    metadata: _RunMetadata,
    *,
    failed: bool,
) -> Run | RecordMalformed:
    call_id = _non_empty(kwargs.get("litellm_call_id"))
    trace_id = _non_empty(kwargs.get("litellm_trace_id"))
    return _parse(
        Run,
        {
            "run_id": metadata.run_id or trace_id or call_id or uuid7(),
            "span_id": metadata.span_id or call_id or uuid7(),
            "parent_span_id": metadata.parent_span_id,
            "step": metadata.step,
            "trace_id": metadata.trace_id,
            "run_type": metadata.run_type or "single_call",
            "error_code": _error_code(kwargs.get("exception")) if failed else None,
        },
        "/run",
    )


def _error_code(error: object) -> LiteLLMRunErrorCode:
    name = type(error).__name__.lower()
    status = getattr(error, "status_code", None)
    if "timeout" in name:
        return LiteLLMRunErrorCode.TIMEOUT
    if "ratelimit" in name or status == 429:
        return LiteLLMRunErrorCode.RATE_LIMIT
    if "authentication" in name or status in {401, 403}:
        return LiteLLMRunErrorCode.AUTHENTICATION
    if "contextwindow" in name:
        return LiteLLMRunErrorCode.CONTEXT_WINDOW
    if "contentpolicy" in name:
        return LiteLLMRunErrorCode.CONTENT_POLICY
    return LiteLLMRunErrorCode.PROVIDER_ERROR


def _field(value: object, name: str) -> object:
    if value is _MISSING or value is None:
        return _MISSING
    if isinstance(value, Mapping):
        return value.get(name, _MISSING)
    return getattr(value, name, _MISSING)


def _exclusive(total: int | None, *parts: int | None) -> int | None:
    if total is None:
        return None
    return max(0, total - sum(part or 0 for part in parts))


def _datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        # LiteLLM currently supplies naive ``datetime.now()`` values. Python's
        # astimezone() correctly interprets those in the process-local timezone.
        return value.astimezone(UTC)
    if isinstance(value, int | float) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(value, tz=UTC)
        except (OverflowError, OSError, ValueError):
            return None
    return None


def _non_empty(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


__all__ = [
    "MappingResult",
    "RecordMalformed",
    "RecordReady",
    "RecordSkipped",
    "map_callback",
]
