"""Privacy-preserving mapping from ended Langfuse spans to AUDR.

Only identifiers, usage, cost, timings and the ``audr_*`` metadata keys are read.
``langfuse.observation.input`` and ``langfuse.observation.output`` are never touched.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, TypeAlias, get_args

from audr import (
    AUDR,
    Attribution,
    Cost,
    Emitter,
    Environment,
    LlmUsage,
    Modality,
    Operation,
    Resource,
    Run,
    Timing,
    ToolUsage,
    Usage,
)
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import StatusCode
from pydantic import ValidationError

from audr_adapter_langfuse._errors import LangfuseRunErrorCode
from audr_adapter_langfuse._version import __version__

_EMITTER_NAME: Final = "audr-adapter-langfuse"
_TYPE: Final = "langfuse.observation.type"
_LEVEL: Final = "langfuse.observation.level"
_MODEL: Final = "langfuse.observation.model.name"
_USAGE: Final = "langfuse.observation.usage_details"
_COST: Final = "langfuse.observation.cost_details"
_ENVIRONMENT: Final = "langfuse.environment"
_TRACE_METADATA: Final = "langfuse.trace.metadata"
_OBSERVATION_METADATA: Final = "langfuse.observation.metadata"
_METADATA_KEY_PREFIX: Final = "audr_"

_OPERATIONS: Final[dict[str, Operation]] = {
    "generation": "generation",
    "embedding": "embedding",
    "tool": "tool_execution",
    "retriever": "retrieval",
}
_TOOL_USAGE_TYPES: Final[dict[Operation, str]] = {
    "tool_execution": "invocation",
    "retrieval": "retrieval",
}
_ENVIRONMENTS: Final = frozenset(get_args(Environment))
# Langfuse tags experiment runs with this environment; they are evaluation traffic.
_LANGFUSE_ENVIRONMENTS: Final[dict[str, Environment]] = {"sdk-experiment": "evaluation"}
_ATTRIBUTION_FIELDS: Final = frozenset(Attribution.model_fields)
_PROVIDER_DISALLOWED: Final = re.compile(r"[^a-z0-9-]+")

# Langfuse usage buckets are exclusive: `input` excludes every `input_*` bucket and
# `output` every `output_*` bucket. Each tuple lists aliases written by different
# integrations for the same bucket; the first present wins.
_CACHE_READ_KEYS: Final = ("cache_read_input_tokens", "input_cached_tokens", "input_cache_read")
_CACHE_WRITE_KEYS: Final = ("cache_creation_input_tokens", "input_cache_creation")
_REASONING_KEYS: Final = ("output_reasoning_tokens", "output_reasoning")
# Vertex AI cache reads per modality, written by the LangChain handler.
_CACHED_MODALITY_PREFIX: Final = "cached_modality_"
# Buckets that are not exclusive token counts: priority tiers repeat other counts, and
# Anthropic cache tiers (`input_ephemeral_*`, `cache_creation_ephemeral_*`) split the
# cache-write aggregate.
_NON_EXCLUSIVE_MARKERS: Final = ("priority", "cache", "ephemeral")
# Raw provider usage, which the `langfuse.openai` wrapper and manual observations forward
# unnormalised, is recognised by its provider keys.
_RAW_KEYS: Final = frozenset(
    {"prompt_tokens", "completion_tokens", "input_tokens", "output_tokens"}
)
_RAW_DETAILS: Final = (
    "prompt_tokens_details",
    "input_tokens_details",
    "completion_tokens_details",
    "output_tokens_details",
)
# Count keys naming a modality AUDR does not call text, in Langfuse buckets
# (`input_audio`, `input_modality_IMAGE`, `cached_modality_VIDEO`) and raw details
# (`audio_tokens`, `image_tokens`).
_NON_TEXT_MARKERS: Final = ("audio", "image", "video")


@dataclass(frozen=True, slots=True)
class RecordReady:
    """An ended span carried enough metering data to emit a record."""

    record: AUDR


@dataclass(frozen=True, slots=True)
class RecordSkipped:
    """An ended span was valid but has no billable AUDR representation."""

    path: str


@dataclass(frozen=True, slots=True)
class RecordMalformed:
    """A documented span attribute had an invalid shape."""

    path: str


MappingResult: TypeAlias = RecordReady | RecordSkipped | RecordMalformed


class _Malformed(Exception):
    def __init__(self, path: str) -> None:
        super().__init__(path)
        self.path = path


def map_span(
    span: ReadableSpan,
    *,
    attribution_defaults: Attribution,
    provider: str | None,
    ancestors: Sequence[Mapping[str, object]] = (),
) -> MappingResult:
    """Map one ended span without reading observation input or output.

    ``ancestors`` are the attributes of the open spans enclosing it, nearest first; their
    ``audr_*`` observation metadata applies under the span's own.
    """
    attributes: Mapping[str, object] = span.attributes or {}
    kind = attributes.get(_TYPE)
    operation = _OPERATIONS.get(kind) if isinstance(kind, str) else None
    if operation is None:
        return RecordSkipped(_pointer(_TYPE))
    try:
        return _map(span, attributes, ancestors, operation, attribution_defaults, provider)
    except _Malformed as error:
        return RecordMalformed(error.path)


def _map(
    span: ReadableSpan,
    attributes: Mapping[str, object],
    ancestors: Sequence[Mapping[str, object]],
    operation: Operation,
    attribution_defaults: Attribution,
    default_provider: str | None,
) -> MappingResult:
    attribution = _resolve_attribution(attributes, ancestors, attribution_defaults)
    if isinstance(attribution, RecordSkipped):
        return attribution

    failed = span.status.status_code is StatusCode.ERROR or attributes.get(_LEVEL) == "ERROR"
    cost: Cost | None = None
    if operation in _TOOL_USAGE_TYPES:
        if not span.name:
            return RecordSkipped("/name")
        resource = Resource(
            provider="self-hosted", type="tool", name=span.name, operation=operation
        )
        usage = Usage(tool=ToolUsage(type=_TOOL_USAGE_TYPES[operation], call_count=1))
    else:
        details = _decode_object(attributes.get(_USAGE), _USAGE)
        llm_usage = _llm_usage(details)
        cost = _cost(attributes.get(_COST))
        # The OpenAI wrapper writes an all-zero cost on failure, so only a positive cost
        # shows that a failed call was billed.
        if cost is not None and failed and cost.total_cost == 0:
            cost = None
        if llm_usage is None:
            if cost is None:
                return RecordSkipped(_pointer(_USAGE))
            llm_usage = LlmUsage()
        llm_usage = llm_usage.model_copy(update={"requests": 1})
        provider = _provider(attributes, default_provider)
        if provider is None:
            return RecordSkipped("/resource/provider")
        model = _first_string(attributes, _MODEL, "gen_ai.response.model", "gen_ai.request.model")
        if model is None:
            return RecordSkipped(_pointer(_MODEL))
        resource = Resource(
            provider=provider,
            type="model",
            name=model,
            operation=operation,
            modality=_modality(details),
        )
        usage = Usage(llm=llm_usage)

    record = AUDR(
        emitter=Emitter(component="harness", name=_EMITTER_NAME, version=__version__),
        timing=_timing(span),
        resource=resource,
        usage=usage,
        run=_run(span, failed=failed),
        attribution=attribution,
        cost=cost,
    )
    issues = record.validate()
    if issues:
        return RecordMalformed(issues[0].path)
    return RecordReady(record)


def _resolve_attribution(
    attributes: Mapping[str, object],
    ancestors: Sequence[Mapping[str, object]],
    defaults: Attribution,
) -> Attribution | RecordSkipped:
    """Merge observation metadata, then the nearest ancestor's down to the farthest's, over
    trace metadata over environment and defaults."""
    values = defaults.model_dump(include=set(_ATTRIBUTION_FIELDS - {"labels"}), exclude_none=True)
    labels: dict[str, object] = dict(defaults.labels or {})
    environment = attributes.get(_ENVIRONMENT)
    if isinstance(environment, str):
        environment = _LANGFUSE_ENVIRONMENTS.get(environment, environment)
        if environment in _ENVIRONMENTS:
            values["environment"] = environment
    sources = [
        (attributes, _TRACE_METADATA),
        *((ancestor, _OBSERVATION_METADATA) for ancestor in reversed(ancestors)),
        (attributes, _OBSERVATION_METADATA),
    ]
    for source, prefix in sources:
        for field in _ATTRIBUTION_FIELDS:
            key = f"{prefix}.{_METADATA_KEY_PREFIX}{field}"
            if key not in source:
                continue
            value = _decode(source[key])
            if field != "labels":
                values[field] = value
            elif isinstance(value, dict):
                labels |= value
            else:
                raise _Malformed(_pointer(key))
    if labels:
        values["labels"] = labels
    try:
        attribution = Attribution.model_validate(values)
    except ValidationError as error:
        loc = error.errors(include_url=False, include_input=False)[0]["loc"]
        name = str(loc[0]) if loc and str(loc[0]) in _ATTRIBUTION_FIELDS else None
        return RecordSkipped(f"/attribution/{name}" if name else "/attribution")
    issues = attribution.validate()
    if issues:
        return RecordSkipped(issues[0].path)
    return attribution


def _llm_usage(details: Mapping[str, object] | None) -> LlmUsage | None:
    if details is None:
        return None
    counts = _raw_counts(details) if _RAW_KEYS.intersection(details) else _bucket_counts(details)
    present = {name: value for name, value in counts.items() if value is not None}
    return LlmUsage(**present) if present else None


def _bucket_counts(details: Mapping[str, object]) -> dict[str, int | None]:
    """Map Langfuse's exclusive buckets, folding modality and audio buckets back in."""
    cache_read = _first_count(details, _CACHE_READ_KEYS)
    if cache_read is None and any(key.startswith(_CACHED_MODALITY_PREFIX) for key in details):
        cache_read = _sum_counts(details, lambda key: key.startswith(_CACHED_MODALITY_PREFIX))
    cache_write = _first_count(details, _CACHE_WRITE_KEYS)
    reasoning = _first_count(details, _REASONING_KEYS)
    output = _count(details, "output")
    if output is not None:
        output += _sum_counts(
            details, lambda key: _is_extra_bucket(key, "output_", _REASONING_KEYS)
        )
    input_tokens: int | None = None
    if "input" in details:
        input_tokens = (_count(details, "input") or 0) + _sum_counts(
            details, lambda key: _is_extra_bucket(key, "input_", _CACHE_READ_KEYS)
        )
        # The LangChain handler clamps `input` at zero after subtracting every detail, so
        # the integration's inclusive total can be the only source of uncached input. The
        # larger value wins, so a total that disagrees with the buckets never lowers it.
        from_total = _exclusive(
            _count(details, "total"), output, reasoning, cache_read, cache_write
        )
        input_tokens = max(input_tokens, from_total or 0)
    return {
        "input_tokens": input_tokens,
        "output_tokens": output,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning,
    }


def _raw_counts(details: Mapping[str, object]) -> dict[str, int | None]:
    """Map raw OpenAI or Anthropic usage.

    OpenAI totals (`prompt_tokens`, or `input_tokens` with detail objects) include cached
    and reasoning tokens. Anthropic's `input_tokens` already excludes its top-level cache
    counts.
    """
    prompt_details = _nested(details, "prompt_tokens_details", "input_tokens_details")
    completion_details = _nested(details, "completion_tokens_details", "output_tokens_details")
    cache_read = _count(prompt_details, "cached_tokens")
    if cache_read is None:
        cache_read = _count(details, "cache_read_input_tokens")
    cache_write = _first_count(prompt_details, ("cache_creation_tokens", "cache_write_tokens"))
    if cache_write is None:
        cache_write = _count(details, "cache_creation_input_tokens")
    reasoning = _count(completion_details, "reasoning_tokens")
    prompt = _first_count(details, ("prompt_tokens", "input_tokens"))
    completion = _first_count(details, ("completion_tokens", "output_tokens"))
    inclusive = "prompt_tokens" in details or any(key in details for key in _RAW_DETAILS)
    return {
        "input_tokens": _exclusive(prompt, cache_read, cache_write) if inclusive else prompt,
        "output_tokens": _exclusive(completion, reasoning),
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning,
    }


def _modality(details: Mapping[str, object] | None) -> Modality:
    """`multimodal` when an audio, image or video count is positive, else `text`.

    Langfuse records no modality, and those tokens come alongside text, so the OpenRouter
    adapter's rule applies: more than one kind is `multimodal`.
    """
    if details is None:
        return "text"
    sources = [details, *(_nested(details, key) for key in _RAW_DETAILS)]
    non_text = any(
        isinstance(value, int)
        and not isinstance(value, bool)
        and value > 0
        and any(marker in key.lower() for marker in _NON_TEXT_MARKERS)
        for source in sources
        for key, value in source.items()
    )
    return "multimodal" if non_text else "text"


def _is_extra_bucket(key: str, prefix: str, aliases: tuple[str, ...]) -> bool:
    return (
        key.startswith(prefix)
        and key not in aliases
        and not any(marker in key[len(prefix) :] for marker in _NON_EXCLUSIVE_MARKERS)
    )


def _cost(raw: object) -> Cost | None:
    details = _decode_object(raw, _COST)
    if not details:
        return None
    amounts: dict[str, float] = {}
    for key, value in details.items():
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not math.isfinite(value)
            or value < 0
        ):
            raise _Malformed(_pointer(_COST))
        amounts[key] = float(value)
    total = amounts["total"] if "total" in amounts else sum(amounts.values())
    # Langfuse records cost in USD only.
    return Cost(total_cost=total, currency="USD")


def _provider(attributes: Mapping[str, object], default: str | None) -> str | None:
    candidates = (
        attributes.get("gen_ai.provider.name"),
        attributes.get("gen_ai.system"),
        _decode(attributes.get(f"{_OBSERVATION_METADATA}.ls_provider")),
        default,
    )
    for candidate in candidates:
        if isinstance(candidate, str):
            slug = _PROVIDER_DISALLOWED.sub("-", candidate.lower()).strip("-")
            if slug:
                return slug
    return None


def _timing(span: ReadableSpan) -> Timing:
    if span.start_time is None or span.end_time is None:
        raise _Malformed("/timing")
    seconds, nanos = divmod(span.end_time, 1_000_000_000)
    end = datetime.fromtimestamp(seconds, tz=UTC).replace(microsecond=nanos // 1_000_000 * 1000)
    duration_ms = max(0, (span.end_time - span.start_time) // 1_000_000)
    return Timing(event_time=end, duration_ms=duration_ms)


def _run(span: ReadableSpan, *, failed: bool) -> Run:
    context = span.context
    if context is None:
        raise _Malformed("/run")
    trace_id = f"{context.trace_id:032x}"
    return Run(
        run_id=trace_id,
        trace_id=trace_id,
        span_id=f"{context.span_id:016x}",
        parent_span_id=f"{span.parent.span_id:016x}" if span.parent is not None else None,
        error_code=LangfuseRunErrorCode.OBSERVATION_ERROR if failed else None,
    )


def _decode(value: object) -> object:
    """Return a metadata value; SDK v5 JSON-encodes every value, strings included."""
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except ValueError:
        return value


def _decode_object(raw: object, attribute: str) -> Mapping[str, object] | None:
    if raw is None:
        return None
    decoded = _decode(raw)
    if not isinstance(decoded, dict):
        raise _Malformed(_pointer(attribute))
    return decoded


def _nested(details: Mapping[str, object], *keys: str) -> Mapping[str, object]:
    for key in keys:
        value = details.get(key)
        if isinstance(value, dict):
            return value
    return {}


def _count(details: Mapping[str, object], key: str) -> int | None:
    value = details.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _Malformed(_pointer(_USAGE))
    return value


def _first_count(details: Mapping[str, object], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = _count(details, key)
        if value is not None:
            return value
    return None


def _sum_counts(details: Mapping[str, object], include: Callable[[str], bool]) -> int:
    return sum(_count(details, key) or 0 for key in details if include(key))


def _exclusive(total: int | None, *parts: int | None) -> int | None:
    if total is None:
        return None
    return max(0, total - sum(part or 0 for part in parts))


def _first_string(attributes: Mapping[str, object], *keys: str) -> str | None:
    for key in keys:
        value = attributes.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _pointer(attribute: str) -> str:
    return f"/attributes/{attribute}"


__all__ = ["MappingResult", "RecordMalformed", "RecordReady", "RecordSkipped", "map_span"]
