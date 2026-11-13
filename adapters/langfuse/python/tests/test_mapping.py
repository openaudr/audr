"""Span-to-record mapping."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("langfuse")

from audr import Attribution

from audr_adapter_langfuse import LangfuseRunErrorCode
from audr_adapter_langfuse._mapping import RecordMalformed, RecordSkipped
from tests.helpers import generation_attributes, map_result, ready, span

USAGE = "langfuse.observation.usage_details"
TRACE_META = "langfuse.trace.metadata"
OBS_META = "langfuse.observation.metadata"

pytestmark = pytest.mark.langfuse


def _usage(details: object) -> dict[str, object]:
    return generation_attributes(**{USAGE: json.dumps(details)})


def test_generation_maps_identifiers_timing_and_usage() -> None:
    record = ready(map_result()).record

    assert record.resource.provider == "openai"
    assert record.resource.type == "model"
    assert record.resource.name == "gpt-5.6-luna"
    assert record.resource.operation == "generation"
    assert record.resource.modality == "text"
    assert record.usage.llm is not None
    assert record.usage.llm.input_tokens == 120
    assert record.usage.llm.output_tokens == 40
    assert record.usage.llm.requests == 1
    assert record.run.run_id == "0af7651916cd43dd8448eb211c80319c"
    assert record.run.trace_id == record.run.run_id
    assert record.run.span_id == "00f067aa0ba902b7"
    assert record.run.parent_span_id == "00000000000000aa"
    assert record.run.error_code is None
    assert record.cost is None
    assert record.timing.duration_ms == 125
    assert record.timing.event_time.microsecond == 248_000
    assert record.emitter is not None
    assert record.emitter.name == "audr-adapter-langfuse"


def test_record_never_carries_observation_input_or_output() -> None:
    serialized = json.dumps(ready(map_result()).record.model_dump(mode="json"))

    assert "SECRET" not in serialized


def test_root_span_has_no_parent() -> None:
    record = ready(map_result(span(parent=False))).record

    assert record.run.parent_span_id is None


# Each case is the `usage_details` an integration writes and the exclusive AUDR counts it
# must produce. The `lc-*` inputs are the output of the Langfuse LangChain handler's own
# `_parse_usage_model` for the raw provider usage named in the id.
_USAGE_CASES: list[tuple[str, dict[str, object], dict[str, int]]] = [
    (
        "manual-buckets",
        {
            "input": 100,
            "output": 30,
            "cache_read_input_tokens": 20,
            "cache_creation_input_tokens": 5,
            "output_reasoning_tokens": 7,
        },
        {
            "input_tokens": 100,
            "output_tokens": 30,
            "cache_read_tokens": 20,
            "cache_write_tokens": 5,
            "reasoning_tokens": 7,
        },
    ),
    (
        "manual-buckets-with-audio",
        {"input": 10, "input_audio": 4, "output": 6, "output_audio": 2, "input_cached_tokens": 3},
        {"input_tokens": 14, "output_tokens": 8, "cache_read_tokens": 3},
    ),
    (
        "manual-buckets-zero-cache",
        {"input": 10, "input_cached_tokens": 0},
        {"input_tokens": 10, "cache_read_tokens": 0},
    ),
    (
        "lc-vertex-modalities",
        {
            "input": 0,
            "output": 0,
            "total": 1050,
            "input_modality_TEXT": 400,
            "output_modality_TEXT": 50,
            "cached_modality_TEXT": 600,
        },
        {"input_tokens": 400, "output_tokens": 50, "cache_read_tokens": 600},
    ),
    (
        "lc-openai-audio-reasoning",
        {
            "input": 60,
            "output": 20,
            "total": 360,
            "input_audio": 200,
            "input_cache_read": 40,
            "output_audio": 30,
            "output_reasoning": 10,
        },
        {
            "input_tokens": 260,
            "output_tokens": 50,
            "cache_read_tokens": 40,
            "reasoning_tokens": 10,
        },
    ),
    (
        "lc-anthropic-cache-tiers",
        {
            "input": 0,
            "output": 80,
            "total": 1580,
            "input_cache_read": 1000,
            "input_cache_creation": 400,
            "input_ephemeral_5m_input_tokens": 400,
        },
        {
            "input_tokens": 100,
            "output_tokens": 80,
            "cache_read_tokens": 1000,
            "cache_write_tokens": 400,
        },
    ),
    (
        "lc-openai-priority",
        {"input": 70, "output": 20, "total": 120, "input_cache_read": 30, "input_priority": 100},
        {"input_tokens": 70, "output_tokens": 20, "cache_read_tokens": 30},
    ),
    (
        "raw-openai-chat",
        {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
            "prompt_tokens_details": {"cached_tokens": 40, "audio_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 20},
        },
        {
            "input_tokens": 60,
            "output_tokens": 30,
            "cache_read_tokens": 40,
            "reasoning_tokens": 20,
        },
    ),
    (
        "raw-openai-responses",
        {
            "input_tokens": 90,
            "output_tokens": 12,
            "input_tokens_details": {"cached_tokens": 80},
            "output_tokens_details": {"reasoning_tokens": 2},
        },
        {
            "input_tokens": 10,
            "output_tokens": 10,
            "cache_read_tokens": 80,
            "reasoning_tokens": 2,
        },
    ),
    (
        "raw-openai-compatible-cache-write",
        {
            "prompt_tokens": 1200,
            "completion_tokens": 10,
            "prompt_tokens_details": {"cached_tokens": 1000, "cache_creation_tokens": 150},
            "cache_creation_input_tokens": 150,
        },
        {
            "input_tokens": 50,
            "output_tokens": 10,
            "cache_read_tokens": 1000,
            "cache_write_tokens": 150,
        },
    ),
    (
        "raw-anthropic",
        {
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_read_input_tokens": 1000,
            "cache_creation_input_tokens": 200,
        },
        {
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_read_tokens": 1000,
            "cache_write_tokens": 200,
        },
    ),
    (
        "manual-total-disagreeing-with-buckets",
        {"input": 100, "output": 30, "cache_read_input_tokens": 20, "total": 130},
        {"input_tokens": 100, "output_tokens": 30, "cache_read_tokens": 20},
    ),
    ("openai-embedding", {"input": 5}, {"input_tokens": 5}),
]


@pytest.mark.parametrize(
    ("details", "expected"),
    [(details, expected) for _, details, expected in _USAGE_CASES],
    ids=[case_id for case_id, _, _ in _USAGE_CASES],
)
def test_usage_shapes(details: dict[str, object], expected: dict[str, int]) -> None:
    usage = ready(map_result(span(_usage(details)))).record.usage.llm

    assert usage is not None
    assert usage.model_dump(exclude_none=True) == {**expected, "requests": 1}


@pytest.mark.parametrize(
    ("details", "modality"),
    [
        ({"input": 10, "output": 5}, "text"),
        ({"input": 10, "input_modality_TEXT": 4, "cached_modality_TEXT": 2}, "text"),
        ({"input": 10, "input_audio": 4}, "multimodal"),
        ({"input": 10, "input_modality_IMAGE": 4}, "multimodal"),
        ({"input": 10, "output_audio": 0}, "text"),
        (
            {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "prompt_tokens_details": {"audio_tokens": 4},
            },
            "multimodal",
        ),
        (
            {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "prompt_tokens_details": {"audio_tokens": 0},
            },
            "text",
        ),
    ],
)
def test_modality_from_usage(details: dict[str, object], modality: str) -> None:
    assert ready(map_result(span(_usage(details)))).record.resource.modality == modality


def test_cost_only_generation_is_text() -> None:
    attributes = generation_attributes(
        **{USAGE: None, "langfuse.observation.cost_details": json.dumps({"total": 0.5})}
    )

    assert ready(map_result(span(attributes))).record.resource.modality == "text"


def test_embedding_maps_operation() -> None:
    attributes = _usage({"input": 8})
    attributes["langfuse.observation.type"] = "embedding"

    record = ready(map_result(span(attributes))).record

    assert record.resource.operation == "embedding"


@pytest.mark.parametrize(
    ("kind", "operation", "usage_type"),
    [("tool", "tool_execution", "invocation"), ("retriever", "retrieval", "retrieval")],
)
def test_tool_like_observations(kind: str, operation: str, usage_type: str) -> None:
    readable = span({"langfuse.observation.type": kind}, name="search_orders", error=True)

    record = ready(map_result(readable)).record

    assert record.resource.provider == "self-hosted"
    assert record.resource.type == "tool"
    assert record.resource.name == "search_orders"
    assert record.resource.operation == operation
    assert record.usage.tool is not None
    assert record.usage.tool.type == usage_type
    assert record.usage.tool.call_count == 1
    assert record.run.error_code == LangfuseRunErrorCode.OBSERVATION_ERROR


def test_tool_without_name_is_skipped() -> None:
    result = map_result(span({"langfuse.observation.type": "tool"}, name=""))

    assert result == RecordSkipped("/name")


@pytest.mark.parametrize("kind", ["span", "agent", "chain", "event", "evaluator", "guardrail", 7])
def test_unmetered_types_are_skipped(kind: object) -> None:
    result = map_result(span({"langfuse.observation.type": kind}))

    assert result == RecordSkipped("/attributes/langfuse.observation.type")


def test_span_without_langfuse_type_is_skipped() -> None:
    assert map_result(span({"gen_ai.usage.input_tokens": 3})) == RecordSkipped(
        "/attributes/langfuse.observation.type"
    )


def test_generation_without_usage_or_cost_is_skipped() -> None:
    result = map_result(span(generation_attributes(**{USAGE: None})))

    assert result == RecordSkipped(f"/attributes/{USAGE}")


def test_generation_with_only_unknown_usage_keys_is_skipped() -> None:
    result = map_result(span(_usage({"total": 10, "input_audio": 3})))

    assert result == RecordSkipped(f"/attributes/{USAGE}")


def test_cost_only_generation_counts_one_request() -> None:
    attributes = generation_attributes(
        **{USAGE: None, "langfuse.observation.cost_details": json.dumps({"total": 0.25})}
    )

    record = ready(map_result(span(attributes))).record

    assert record.usage.llm is not None
    assert record.usage.llm.requests == 1
    assert record.cost is not None
    assert record.cost.total_cost == 0.25
    assert record.cost.currency == "USD"


def test_cost_without_total_is_summed() -> None:
    attributes = generation_attributes(
        **{"langfuse.observation.cost_details": json.dumps({"input": 0.5, "output": 0.25})}
    )

    record = ready(map_result(span(attributes))).record

    assert record.cost is not None
    assert record.cost.total_cost == 0.75


def test_failed_generation_with_zero_cost_drops_cost_and_flags_error() -> None:
    attributes = generation_attributes(
        **{"langfuse.observation.cost_details": json.dumps({"input": 0, "output": 0, "total": 0})}
    )

    record = ready(map_result(span(attributes, error=True))).record

    assert record.cost is None
    assert record.run.error_code == LangfuseRunErrorCode.OBSERVATION_ERROR


def test_error_level_marks_failure() -> None:
    attributes = generation_attributes(**{"langfuse.observation.level": "ERROR"})

    record = ready(map_result(span(attributes))).record

    assert record.run.error_code == LangfuseRunErrorCode.OBSERVATION_ERROR


@pytest.mark.parametrize(
    ("attribute", "value"),
    [
        (USAGE, "not json"),
        (USAGE, json.dumps([1, 2])),
        (USAGE, json.dumps({"input": -1})),
        (USAGE, json.dumps({"input": True})),
        (USAGE, json.dumps({"input": 1.5})),
        ("langfuse.observation.cost_details", json.dumps({"total": "1"})),
        ("langfuse.observation.cost_details", json.dumps({"total": -0.1})),
        ("langfuse.observation.cost_details", '{"total": Infinity}'),
        ("langfuse.observation.cost_details", '{"input": NaN}'),
    ],
)
def test_malformed_usage_and_cost(attribute: str, value: str) -> None:
    result = map_result(span(generation_attributes(**{attribute: value})))

    assert result == RecordMalformed(f"/attributes/{attribute}")


@pytest.mark.parametrize(
    ("overrides", "config_provider", "expected"),
    [
        ({"gen_ai.provider.name": "Azure OpenAI", "gen_ai.system": "openai"}, None, "azure-openai"),
        ({"gen_ai.provider.name": None, "gen_ai.system": "anthropic"}, "openai", "anthropic"),
        (
            {"gen_ai.provider.name": None, f"{OBS_META}.ls_provider": json.dumps("bedrock")},
            "openai",
            "bedrock",
        ),
        ({"gen_ai.provider.name": None}, "mistral", "mistral"),
        ({"gen_ai.provider.name": "!!!"}, "mistral", "mistral"),
    ],
)
def test_provider_resolution(
    overrides: dict[str, object], config_provider: str | None, expected: str
) -> None:
    readable = span(generation_attributes(**overrides))

    record = ready(map_result(readable, provider=config_provider)).record

    assert record.resource.provider == expected


def test_unresolved_provider_is_skipped() -> None:
    result = map_result(span(), provider=None)

    assert result == RecordSkipped("/resource/provider")


def test_model_falls_back_to_gen_ai_attributes() -> None:
    attributes = generation_attributes(
        **{"langfuse.observation.model.name": None, "gen_ai.request.model": "claude-x"}
    )

    record = ready(map_result(span(attributes))).record

    assert record.resource.name == "claude-x"


def test_missing_model_is_skipped() -> None:
    attributes = generation_attributes(**{"langfuse.observation.model.name": None})

    result = map_result(span(attributes))

    assert result == RecordSkipped("/attributes/langfuse.observation.model.name")


def test_attribution_precedence_and_label_merge() -> None:
    attributes = generation_attributes(
        **{
            "langfuse.environment": "staging",
            f"{TRACE_META}.audr_environment": json.dumps("production"),
            f"{TRACE_META}.audr_account_id": json.dumps("acct_trace"),
            f"{TRACE_META}.audr_labels": json.dumps({"team": "support", "tier": "gold"}),
            f"{OBS_META}.audr_account_id": json.dumps("acct_obs"),
            f"{OBS_META}.audr_feature_id": json.dumps("support-chat"),
            f"{OBS_META}.audr_labels": json.dumps({"tier": "silver"}),
            "user.id": "someone@example.com",
        }
    )
    defaults = Attribution(environment="test", subscription_id="sub_7", labels={"region": "us"})

    attribution = ready(map_result(span(attributes), defaults=defaults)).record.attribution

    assert attribution.environment == "production"
    assert attribution.account_id == "acct_obs"
    assert attribution.subscription_id == "sub_7"
    assert attribution.feature_id == "support-chat"
    assert attribution.user_id is None
    assert attribution.labels == {"region": "us", "team": "support", "tier": "silver"}


def test_open_ancestor_metadata_applies_under_the_span_own() -> None:
    attributes = generation_attributes(**{f"{OBS_META}.audr_user_id": json.dumps("u_own")})
    nearest = {
        f"{OBS_META}.audr_feature_id": json.dumps("near"),
        f"{OBS_META}.audr_user_id": json.dumps("u_near"),
        f"{OBS_META}.audr_labels": json.dumps({"tier": "silver"}),
    }
    farthest = {
        f"{OBS_META}.audr_feature_id": json.dumps("far"),
        f"{OBS_META}.audr_account_id": json.dumps("acct_far"),
        f"{OBS_META}.audr_labels": json.dumps({"team": "support", "tier": "gold"}),
        f"{TRACE_META}.audr_subscription_id": json.dumps("sub_ignored"),
    }

    attribution = ready(
        map_result(span(attributes), ancestors=[nearest, farthest])
    ).record.attribution

    assert attribution.user_id == "u_own"
    assert attribution.feature_id == "near"
    assert attribution.account_id == "acct_far"
    assert attribution.subscription_id is None
    assert attribution.labels == {"team": "support", "tier": "silver"}


def test_langfuse_environment_used_only_when_it_is_an_audr_value() -> None:
    staging = generation_attributes(**{"langfuse.environment": "staging"})
    default = generation_attributes(**{"langfuse.environment": "default"})

    assert ready(map_result(span(staging))).record.attribution.environment == "staging"
    assert ready(map_result(span(default))).record.attribution.environment == "test"


def test_langfuse_experiment_environment_is_evaluation() -> None:
    attributes = generation_attributes(**{"langfuse.environment": "sdk-experiment"})
    defaults = Attribution(environment="production", account_id="acct_42")

    record = ready(map_result(span(attributes), defaults=defaults)).record

    assert record.attribution.environment == "evaluation"


def test_unencoded_metadata_string_is_accepted() -> None:
    attributes = generation_attributes(**{f"{TRACE_META}.audr_account_id": "acct_raw"})

    assert ready(map_result(span(attributes))).record.attribution.account_id == "acct_raw"


def test_missing_environment_is_skipped() -> None:
    result = map_result(span(), defaults=Attribution())

    assert result == RecordSkipped("/attribution/environment")


def test_email_user_id_in_metadata_is_skipped() -> None:
    attributes = generation_attributes(**{f"{OBS_META}.audr_user_id": json.dumps("a@b.example")})

    result = map_result(span(attributes))

    assert isinstance(result, RecordSkipped)
    assert result.path.startswith("/attribution/user_id")


def test_invalid_attribution_type_is_skipped() -> None:
    attributes = generation_attributes(**{f"{OBS_META}.audr_account_id": json.dumps(42)})

    assert map_result(span(attributes)) == RecordSkipped("/attribution/account_id")


def test_non_object_labels_are_malformed() -> None:
    attributes = generation_attributes(**{f"{OBS_META}.audr_labels": json.dumps(["x"])})

    assert map_result(span(attributes)) == RecordMalformed(f"/attributes/{OBS_META}.audr_labels")
