"""Unit tests for NeMo Relay event normalization and record encoders."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import UUID

import pytest
from audr import Attribution

from audr_adapter_nemo_relay import NeMoRelayRunErrorCode
from audr_adapter_nemo_relay._mapping import (
    EventIgnored,
    EventMalformed,
    EventSkipped,
    LlmOperation,
    Operation,
    OperationReady,
    ScopeTracker,
    ToolOperation,
    encode_audr,
)
from audr_adapter_nemo_relay._version import __version__

_ROOT_ID = "0199f123-0000-7000-8000-000000000001"
_LLM_ID = "0199f123-0000-7000-8000-000000000002"
_TOOL_ID = "0199f123-0000-7000-8000-000000000003"
# Relay never emits the outermost scope's own parent, so a real root always
# names a parent the subscriber has not observed.
_AMBIENT_ID = "0199f123-0000-7000-8000-0000000000ff"
_BASE_TIME = datetime.now(UTC) - timedelta(seconds=1)


def _timestamp(offset_ms: int = 0) -> str:
    value = _BASE_TIME + timedelta(milliseconds=offset_ms)
    return value.isoformat()


def _defaults(**overrides: object) -> Attribution:
    values = {
        "environment": "test",
        "subscription_id": "default-subscription",
        **overrides,
    }
    return Attribution(**values)


def _start(
    scope_id: str,
    *,
    category: str,
    parent_id: str | None = _AMBIENT_ID,
    metadata: object = None,
    offset_ms: int = 0,
) -> dict[str, object]:
    return {
        "kind": "scope",
        "scope_category": "start",
        "uuid": scope_id,
        "parent_uuid": parent_id,
        "timestamp": _timestamp(offset_ms),
        "category": category,
        "name": category,
        "metadata": metadata,
    }


def _end(
    scope_id: str,
    *,
    category: str,
    name: str,
    parent_id: str | None = _ROOT_ID,
    profile: object = None,
    metadata: object = None,
    offset_ms: int = 25,
    data: object = None,
) -> dict[str, object]:
    return {
        "kind": "scope",
        "scope_category": "end",
        "uuid": scope_id,
        "parent_uuid": parent_id,
        "timestamp": _timestamp(offset_ms),
        "category": category,
        "name": name,
        "category_profile": profile,
        "metadata": metadata,
        "data": data,
    }


def _llm_profile(**overrides: object) -> dict[str, object]:
    annotated: dict[str, object] = {
        "model": "model",
        "usage": {"prompt_tokens": 1},
    }
    annotated.update(overrides)
    return {"annotated_response": annotated}


def _ready_operation(result: object) -> Operation:
    assert isinstance(result, OperationReady)
    return result.operation


def test_llm_scope_maps_normalized_usage_and_both_encoders() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(
        _start(
            _ROOT_ID,
            category="agent",
            metadata={
                "audr": {
                    "subscription_id": "root-subscription",
                    "labels": {"team": "ai", "region": "us", "project": "project-1"},
                }
            },
        )
    )
    tracker.consume(_start(_LLM_ID, category="llm", parent_id=_ROOT_ID, offset_ms=5))

    result = tracker.consume(
        _end(
            _LLM_ID,
            category="llm",
            name="openai",
            profile={
                "annotated_response": {
                    "model": "gpt-test",
                    "usage": {
                        "prompt_tokens": 12,
                        "completion_tokens": 4,
                        "cache_read_tokens": 3,
                        "cache_write_tokens": 2,
                        "total_tokens": 21,
                    },
                },
            },
            data={"prompt": "must not escape"},
        )
    )

    operation = _ready_operation(result)
    audr = encode_audr(operation)
    assert audr.validate() == []
    # Relay's scope UUID is not a conformant `record_id` (not UUIDv7), so it is
    # carried on `run.span_id` instead, and `record_id` is minted fresh.
    assert audr.record_id != _LLM_ID
    assert audr.run.span_id == _LLM_ID
    assert audr.run.run_id == _ROOT_ID
    assert audr.run.parent_span_id == _ROOT_ID
    assert audr.resource.type == "model"
    assert audr.resource.name == "gpt-test"
    assert audr.resource.operation == "generation"
    assert audr.usage.llm is not None
    assert audr.usage.llm.input_tokens == 7
    assert audr.usage.llm.cache_read_tokens == 3
    assert audr.usage.llm.cache_write_tokens == 2
    assert not hasattr(audr.usage.llm, "total_tokens")


def test_provider_echoed_model_wins_over_normalized_model_name() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(_start(_LLM_ID, category="llm"))

    result = tracker.consume(
        _end(
            _LLM_ID,
            category="llm",
            name="openai",
            profile={
                "model_name": "gpt-4o",
                "annotated_response": {
                    "model": "gpt-4o-2024-08-06",
                    "usage": {"prompt_tokens": 1},
                },
            },
        )
    )

    operation = _ready_operation(result)
    assert isinstance(operation, LlmOperation)
    assert operation.model == "gpt-4o-2024-08-06"


def test_provider_is_normalized_to_the_audr_alphabet() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(_start(_LLM_ID, category="llm"))

    result = tracker.consume(
        _end(_LLM_ID, category="llm", name="My Provider_v2", profile=_llm_profile())
    )

    operation = _ready_operation(result)
    assert operation.provider == "my-provider-v2"
    assert encode_audr(operation).validate() == []


def test_duration_is_measured_before_millisecond_truncation() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    start = datetime.now(UTC).replace(microsecond=999_500)
    end = start + timedelta(microseconds=1200)
    tracker.consume(
        {
            "kind": "scope",
            "scope_category": "start",
            "uuid": _LLM_ID,
            "parent_uuid": _AMBIENT_ID,
            "timestamp": start.isoformat(),
            "category": "llm",
            "name": "openai",
            "metadata": None,
        }
    )
    result = tracker.consume(
        {
            "kind": "scope",
            "scope_category": "end",
            "uuid": _LLM_ID,
            "parent_uuid": _AMBIENT_ID,
            "timestamp": end.isoformat(),
            "category": "llm",
            "name": "openai",
            "category_profile": _llm_profile(),
            "metadata": None,
        }
    )

    operation = _ready_operation(result)
    assert operation.duration_ms == 1
    audr = encode_audr(operation)
    assert audr.validate() == []
    assert audr.timing.event_time is not None
    assert audr.timing.event_time.microsecond % 1000 == 0


def test_tool_scope_maps_call_and_reliable_otel_failure_only() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(_start(_ROOT_ID, category="agent"))
    tracker.consume(_start(_TOOL_ID, category="tool", parent_id=_ROOT_ID, offset_ms=5))

    result = tracker.consume(
        _end(
            _TOOL_ID,
            category="tool",
            name="lookup",
            metadata={
                "otel.status_code": "ERROR",
                "otel.status_description": "sensitive failure text",
            },
            data={"secret_result": "must not escape"},
        )
    )

    operation = _ready_operation(result)
    assert isinstance(operation, ToolOperation)
    audr = encode_audr(operation)
    assert audr.validate() == []
    assert "sensitive failure text" not in audr.model_dump_json()
    assert "must not escape" not in audr.model_dump_json()
    assert audr.usage.tool is not None
    assert audr.usage.tool.type == "invocation"
    assert audr.resource.provider == "self-hosted"
    assert audr.usage.tool.call_count == 1
    assert audr.resource.type == "tool"
    assert audr.resource.name == "lookup"
    assert audr.run.error_code == NeMoRelayRunErrorCode.TOOL_ERROR


def test_successful_tool_carries_no_error_code() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(_start(_TOOL_ID, category="tool"))
    result = tracker.consume(
        _end(
            _TOOL_ID,
            category="tool",
            name="lookup",
            metadata={"otel.status_code": "OK"},
        )
    )

    operation = _ready_operation(result)
    audr = encode_audr(operation)
    assert audr.run.error_code is None
    assert audr.run.outcome is None


def test_unannotated_llm_and_missing_attribution_are_safely_skipped() -> None:
    tracker = ScopeTracker(defaults=Attribution(), max_scopes=10)
    tracker.consume(_start(_LLM_ID, category="llm"))
    missing_attribution = tracker.consume(
        _end(
            _LLM_ID,
            category="llm",
            name="provider",
            profile={"annotated_response": {"usage": {}}},
        )
    )
    assert missing_attribution == EventSkipped("/attribution/environment")

    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(_start(_LLM_ID, category="llm"))
    missing_usage = tracker.consume(
        _end(
            _LLM_ID,
            category="llm",
            name="provider",
            profile={"annotated_response": {"model": "model"}},
        )
    )
    assert missing_usage == EventSkipped("/category_profile/annotated_response/usage")

    tracker.consume(_start(_TOOL_ID, category="llm"))
    missing_model = tracker.consume(
        _end(
            _TOOL_ID,
            category="llm",
            name="provider",
            profile={"annotated_response": {"usage": {"prompt_tokens": 1}}},
        )
    )
    assert missing_model == EventSkipped("/category_profile/annotated_response/model")


def test_production_without_account_id_is_skipped() -> None:
    tracker = ScopeTracker(
        defaults=_defaults(environment="production", subscription_id="subscription"),
        max_scopes=10,
    )
    tracker.consume(_start(_LLM_ID, category="llm"))
    result = tracker.consume(_end(_LLM_ID, category="llm", name="provider", profile=_llm_profile()))
    assert result == EventSkipped("/attribution/account_id")


def test_streaming_final_end_maps_once_and_ignores_unknown_profile_fields() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(_start(_LLM_ID, category="llm"))
    result = tracker.consume(
        _end(
            _LLM_ID,
            category="llm",
            name="provider",
            profile={
                "streaming": True,
                "annotated_response": {
                    "model": "stream-model",
                    "usage": {"prompt_tokens": 2, "completion_tokens": 3},
                },
            },
        )
    )

    operation = _ready_operation(result)
    audr = encode_audr(operation)
    assert audr.usage.llm is not None
    assert audr.usage.llm.requests == 1


def test_missing_start_is_skipped_instead_of_using_static_defaults() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    result = tracker.consume(_end(_LLM_ID, category="llm", name="provider", profile=_llm_profile()))
    assert result == EventSkipped("/scope/start")


def test_untracked_end_does_not_use_metadata_or_static_defaults() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    result = tracker.consume(
        _end(
            _LLM_ID,
            category="llm",
            name="provider",
            metadata={
                "audr": {
                    "subscription_id": "attacker-subscription",
                    "labels": {"project": "should-not-apply"},
                }
            },
            profile=_llm_profile(),
        )
    )
    assert result == EventSkipped("/scope/start")


def test_completed_child_keeps_root_start_attribution_not_end_metadata() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(
        _start(
            _ROOT_ID,
            category="agent",
            metadata={"audr": {"subscription_id": "root-subscription"}},
        )
    )
    tracker.consume(_start(_LLM_ID, category="llm", parent_id=_ROOT_ID, offset_ms=5))
    result = tracker.consume(
        _end(
            _LLM_ID,
            category="llm",
            name="provider",
            metadata={"audr": {"subscription_id": "attacker-subscription"}},
            profile=_llm_profile(),
        )
    )
    operation = _ready_operation(result)
    assert operation.attribution.subscription_id == "root-subscription"


def test_unobserved_parent_applies_static_defaults() -> None:
    """Every real Relay root names a parent the subscriber never sees."""
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(_start(_ROOT_ID, category="agent", parent_id=_AMBIENT_ID))
    tracker.consume(_start(_LLM_ID, category="llm", parent_id=_ROOT_ID, offset_ms=5))

    result = tracker.consume(_end(_LLM_ID, category="llm", name="provider", profile=_llm_profile()))

    operation = _ready_operation(result)
    assert operation.attribution.subscription_id == "default-subscription"
    assert operation.run_id == _ROOT_ID


def test_billing_root_reports_no_parent_span() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(_start(_LLM_ID, category="llm", parent_id=_AMBIENT_ID))

    result = tracker.consume(
        _end(
            _LLM_ID,
            category="llm",
            name="provider",
            parent_id=_AMBIENT_ID,
            profile=_llm_profile(),
        )
    )

    operation = _ready_operation(result)
    assert operation.parent_span_id is None
    assert operation.run_id == _LLM_ID


def test_defaults_without_subscription_still_bill_without_one() -> None:
    """`subscription_id` is a Chargebee sink rule, not an AUDR core one."""
    tracker = ScopeTracker(defaults=Attribution(environment="test"), max_scopes=10)
    tracker.consume(_start(_ROOT_ID, category="agent"))
    tracker.consume(_start(_LLM_ID, category="llm", parent_id=_ROOT_ID, offset_ms=5))

    result = tracker.consume(_end(_LLM_ID, category="llm", name="provider", profile=_llm_profile()))

    operation = _ready_operation(result)
    assert operation.attribution.subscription_id is None


def test_scope_state_is_bounded_and_reports_eviction() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=1)
    first = tracker.consume(_start(_ROOT_ID, category="agent"))
    second = tracker.consume(_start(_LLM_ID, category="llm", parent_id=_ROOT_ID))

    assert first == EventIgnored(evicted=0)
    assert second == EventIgnored(evicted=1)


def test_child_of_evicted_parent_cannot_fall_back_to_default_attribution() -> None:
    tracker = ScopeTracker(
        defaults=_defaults(subscription_id="default-subscription"),
        max_scopes=1,
    )
    tracker.consume(
        _start(
            _ROOT_ID,
            category="agent",
            metadata={"audr": {"subscription_id": "root-subscription"}},
        )
    )
    tracker.consume(_start(_LLM_ID, category="llm", parent_id=_ROOT_ID, offset_ms=1))
    tracker.consume(_start(_TOOL_ID, category="llm", parent_id=_ROOT_ID, offset_ms=2))

    result = tracker.consume(
        _end(
            _TOOL_ID,
            category="llm",
            name="provider",
            parent_id=_ROOT_ID,
            offset_ms=3,
            profile=_llm_profile(),
        )
    )

    assert result == EventSkipped("/scope/parent_uuid")


def test_child_of_completed_parent_cannot_fall_back_to_default_attribution() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(
        _start(
            _ROOT_ID,
            category="agent",
            metadata={"audr": {"subscription_id": "root-subscription"}},
        )
    )
    tracker.consume(_end(_ROOT_ID, category="agent", name="agent", parent_id=_AMBIENT_ID))
    tracker.consume(_start(_LLM_ID, category="llm", parent_id=_ROOT_ID, offset_ms=5))

    result = tracker.consume(_end(_LLM_ID, category="llm", name="provider", profile=_llm_profile()))

    assert result == EventSkipped("/scope/parent_uuid")


def test_scope_declaring_its_own_attribution_overrides_lost_lineage() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=1)
    tracker.consume(_start(_ROOT_ID, category="agent"))
    tracker.consume(_start(_TOOL_ID, category="agent", parent_id=_ROOT_ID))
    tracker.consume(
        _start(
            _LLM_ID,
            category="llm",
            parent_id=_ROOT_ID,
            metadata={"audr": {"subscription_id": "declared-subscription"}},
        )
    )

    result = tracker.consume(_end(_LLM_ID, category="llm", name="provider", profile=_llm_profile()))

    operation = _ready_operation(result)
    assert operation.attribution.subscription_id == "declared-subscription"


def test_scope_tracker_serializes_concurrent_subscriber_callbacks() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=100)
    scope_ids = [str(UUID(int=index)) for index in range(1, 51)]
    starts = [_start(scope_id, category="llm", parent_id=None) for scope_id in scope_ids]

    with ThreadPoolExecutor(max_workers=8) as executor:
        start_results = list(executor.map(tracker.consume, starts))

    assert all(isinstance(result, EventIgnored) for result in start_results)
    ends = [
        _end(
            scope_id,
            category="llm",
            name="provider",
            parent_id=None,
            profile=_llm_profile(),
        )
        for scope_id in scope_ids
    ]
    with ThreadPoolExecutor(max_workers=8) as executor:
        end_results = list(executor.map(tracker.consume, ends))

    assert all(isinstance(result, OperationReady) for result in end_results)


def test_scope_tracker_clear_drops_incomplete_starts() -> None:
    tracker = ScopeTracker(defaults=_defaults(), max_scopes=10)
    tracker.consume(_start(_ROOT_ID, category="agent"))
    tracker.consume(_start(_LLM_ID, category="llm", parent_id=_ROOT_ID))
    tracker.clear()
    result = tracker.consume(_end(_LLM_ID, category="llm", name="provider", profile=_llm_profile()))
    assert result == EventSkipped("/scope/start")


# --- structurally malformed events ---------------------------------------------------
#
# Relay hands the subscriber arbitrary JSON. Every rejection below must name the exact
# field so an operator can fix the producer, and none may raise into Relay's dispatcher.


def _tracker() -> ScopeTracker:
    return ScopeTracker(defaults=_defaults(), max_scopes=10)


def test_a_non_scope_event_is_ignored_rather_than_rejected() -> None:
    assert isinstance(_tracker().consume({"kind": "log", "message": "hello"}), EventIgnored)
    assert isinstance(_tracker().consume({}), EventIgnored)


@pytest.mark.parametrize(
    ("event", "path"),
    [
        pytest.param(
            {"kind": "scope", "scope_category": "middle", "uuid": _ROOT_ID},
            "/scope_category",
            id="unknown-scope-category",
        ),
        pytest.param(
            {"kind": "scope", "uuid": _ROOT_ID},
            "/scope_category",
            id="missing-scope-category",
        ),
        pytest.param(
            {"kind": "scope", "scope_category": "start", "uuid": "not-a-uuid"},
            "/uuid",
            id="uuid-is-not-a-uuid",
        ),
        pytest.param(
            {"kind": "scope", "scope_category": "start", "uuid": _ROOT_ID, "timestamp": None},
            "/timestamp",
            id="timestamp-missing",
        ),
        pytest.param(
            {"kind": "scope", "scope_category": "start", "uuid": _ROOT_ID, "timestamp": 1700000000},
            "/timestamp",
            id="timestamp-is-a-number",
        ),
        pytest.param(
            {
                "kind": "scope",
                "scope_category": "start",
                "uuid": _ROOT_ID,
                "timestamp": "yesterday",
            },
            "/timestamp",
            id="timestamp-unparseable",
        ),
        pytest.param(
            {
                "kind": "scope",
                "scope_category": "start",
                "uuid": _ROOT_ID,
                "timestamp": "2026-09-21T10:00:00",
            },
            "/timestamp",
            id="timestamp-has-no-timezone",
        ),
    ],
)
def test_a_malformed_event_names_the_offending_field(event: dict[str, object], path: str) -> None:
    result = _tracker().consume(event)

    assert isinstance(result, EventMalformed)
    assert result.path == path


@pytest.mark.parametrize("parent", ["not-a-uuid", 42, ""])
def test_a_malformed_parent_uuid_is_rejected(parent: object) -> None:
    result = _tracker().consume(
        {
            "kind": "scope",
            "scope_category": "start",
            "uuid": _ROOT_ID,
            "parent_uuid": parent,
            "timestamp": _timestamp(),
            "category": "agent",
            "name": "agent",
        }
    )

    assert isinstance(result, EventMalformed)
    assert result.path == "/parent_uuid"


def test_an_uppercase_uuid_is_accepted() -> None:
    """Relay may emit either case; only a non-UUID is malformed."""
    result = _tracker().consume(
        {
            "kind": "scope",
            "scope_category": "start",
            "uuid": _ROOT_ID.upper(),
            "timestamp": _timestamp(),
        }
    )

    assert isinstance(result, EventIgnored)  # a start event completes nothing yet


# --- names and counters --------------------------------------------------------------


def _completed(tracker: ScopeTracker, end: dict[str, object]) -> object:
    tracker.consume(_start(_ROOT_ID, category="agent", metadata={"audr": {"subscription_id": "s"}}))
    tracker.consume(_start(_LLM_ID, category="llm", parent_id=_ROOT_ID, offset_ms=5))
    return tracker.consume(end)


@pytest.mark.parametrize("name", ["", None, 0])
def test_an_llm_scope_without_a_usable_provider_name_is_malformed(name: object) -> None:
    result = _completed(
        _tracker(),
        _end(_LLM_ID, category="llm", name=cast(str, name), profile=_llm_profile()),
    )

    assert isinstance(result, EventMalformed)
    assert result.path == "/name"


def test_a_provider_name_of_only_punctuation_has_nothing_left_to_slugify() -> None:
    result = _completed(
        _tracker(), _end(_LLM_ID, category="llm", name="!!!", profile=_llm_profile())
    )

    assert isinstance(result, EventMalformed)
    assert result.path == "/name"


def test_a_provider_name_is_slugified_rather_than_rejected() -> None:
    result = _completed(
        _tracker(),
        _end(_LLM_ID, category="llm", name="Azure OpenAI (EU)", profile=_llm_profile()),
    )

    assert _ready_operation(result).provider == "azure-openai-eu"


@pytest.mark.parametrize("value", [-1, "12", 1.5, True])
def test_a_usage_counter_that_is_not_a_non_negative_int_is_malformed(value: object) -> None:
    result = _completed(
        _tracker(),
        _end(
            _LLM_ID,
            category="llm",
            name="openai",
            profile={"annotated_response": {"model": "m", "usage": {"prompt_tokens": value}}},
        ),
    )

    assert isinstance(result, EventMalformed)
    assert result.path == "/category_profile/annotated_response/usage/prompt_tokens"


def test_a_tool_scope_without_a_name_is_malformed() -> None:
    tracker = _tracker()
    tracker.consume(_start(_ROOT_ID, category="agent", metadata={"audr": {"subscription_id": "s"}}))
    tracker.consume(_start(_TOOL_ID, category="tool", parent_id=_ROOT_ID, offset_ms=5))

    result = tracker.consume(_end(_TOOL_ID, category="tool", name=""))

    assert isinstance(result, EventMalformed)
    assert result.path == "/name"


# --- cache arithmetic per codec ------------------------------------------------------


_CACHED_USAGE = {
    "prompt_tokens": 100,
    "completion_tokens": 5,
    "cache_read_tokens": 30,
    "cache_write_tokens": 20,
}


def _llm_with_api(api: str | None) -> LlmOperation:
    profile = _llm_profile(usage=_CACHED_USAGE)
    if api is not None:
        profile["annotated_response"]["api_specific"] = {"api": api}  # type: ignore[index]
    operation = _ready_operation(
        _completed(_tracker(), _end(_LLM_ID, category="llm", name="p", profile=profile))
    )
    assert isinstance(operation, LlmOperation)
    return operation


def test_anthropic_prompt_tokens_already_exclude_cache_and_are_kept() -> None:
    """Anthropic reports uncached input only; subtracting the cache again under-counts."""
    operation = _llm_with_api("anthropic_messages")

    assert operation.input_tokens == 100
    assert operation.cache_read_tokens == 30
    assert operation.cache_write_tokens == 20


@pytest.mark.parametrize("api", ["openai_chat", "openai_responses", None])
def test_inclusive_prompt_tokens_have_the_cache_subtracted(api: str | None) -> None:
    assert _llm_with_api(api).input_tokens == 50


def test_a_non_mapping_api_specific_is_treated_as_inclusive() -> None:
    profile = _llm_profile(usage=_CACHED_USAGE, api_specific="anthropic_messages")
    operation = _ready_operation(
        _completed(_tracker(), _end(_LLM_ID, category="llm", name="p", profile=profile))
    )

    assert isinstance(operation, LlmOperation)
    assert operation.input_tokens == 50


# --- emitter -------------------------------------------------------------------------


@pytest.mark.parametrize("category", ["llm", "tool"])
def test_the_emitter_is_this_adapter_at_its_own_release(category: str) -> None:
    scope_id = _LLM_ID if category == "llm" else _TOOL_ID
    tracker = _tracker()
    tracker.consume(_start(_ROOT_ID, category="agent", metadata={"audr": {"subscription_id": "s"}}))
    tracker.consume(_start(scope_id, category=category, parent_id=_ROOT_ID, offset_ms=5))
    profile = _llm_profile() if category == "llm" else None

    result = tracker.consume(_end(scope_id, category=category, name="p", profile=profile))

    emitter = encode_audr(_ready_operation(result)).emitter
    assert emitter is not None
    assert emitter.name == "audr-adapter-nemo-relay"
    assert emitter.version == __version__
    assert emitter.component == "harness"


# --- provider-reported cost ----------------------------------------------------------


def _llm_cost(cost: object) -> LlmOperation:
    usage: dict[str, object] = {"prompt_tokens": 1}
    if cost is not None:
        usage["cost"] = cost
    operation = _ready_operation(
        _completed(
            _tracker(),
            _end(_LLM_ID, category="llm", name="p", profile=_llm_profile(usage=usage)),
        )
    )
    assert isinstance(operation, LlmOperation)
    return operation


@pytest.mark.parametrize("total", [0.00042, 0, 3])
def test_a_provider_reported_cost_is_carried_as_total_and_currency(total: float) -> None:
    operation = _llm_cost(
        {
            "total": total,
            "currency": "USD",
            "source": "provider_reported",
            "input": 0.0001,
            "pricing_provider": "openrouter",
        }
    )

    audr = encode_audr(operation)
    assert audr.validate() == []
    assert audr.cost is not None
    assert audr.cost.total_cost == total
    assert audr.cost.currency == "USD"
    assert audr.cost.llm is None


@pytest.mark.parametrize(
    "cost",
    [
        pytest.param(None, id="absent"),
        pytest.param({"total": 0.1, "currency": "USD", "source": "model_pricing"}, id="estimate"),
        pytest.param({"total": 0.1, "currency": "USD"}, id="no-source"),
        pytest.param("0.1", id="not-a-mapping"),
    ],
)
def test_a_cost_that_is_not_provider_reported_is_left_to_rating(cost: object) -> None:
    operation = _llm_cost(cost)

    assert operation.cost is None
    assert encode_audr(operation).cost is None


@pytest.mark.parametrize(
    ("total", "currency"),
    [
        pytest.param(None, "USD", id="no-total"),
        pytest.param(-0.1, "USD", id="negative"),
        pytest.param(True, "USD", id="bool"),
        pytest.param("0.1", "USD", id="string-total"),
        pytest.param(float("nan"), "USD", id="nan"),
        pytest.param(float("inf"), "USD", id="infinite"),
        pytest.param(0.1, None, id="no-currency"),
        pytest.param(0.1, "usd", id="lowercase-currency"),
        pytest.param(0.1, "US", id="short-currency"),
    ],
)
def test_an_unusable_provider_cost_is_omitted_and_the_record_still_emitted(
    total: object, currency: object
) -> None:
    operation = _llm_cost({"total": total, "currency": currency, "source": "provider_reported"})

    assert operation.cost is None
    assert encode_audr(operation).validate() == []


def test_a_tool_record_carries_no_cost() -> None:
    tracker = _tracker()
    tracker.consume(_start(_ROOT_ID, category="agent", metadata={"audr": {"subscription_id": "s"}}))
    tracker.consume(_start(_TOOL_ID, category="tool", parent_id=_ROOT_ID, offset_ms=5))

    result = tracker.consume(_end(_TOOL_ID, category="tool", name="lookup"))

    assert encode_audr(_ready_operation(result)).cost is None
