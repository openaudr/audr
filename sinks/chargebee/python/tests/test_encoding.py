"""Flattening and event encoding must be deterministic and cached."""

import pytest
from audr import Attribution, ConfigurationError
from audr.testing import make_record

from audr_sink_chargebee import ChargebeeSink
from audr_sink_chargebee._flatten import flatten_audr


def test_flatten_audr_produces_double_underscore_names() -> None:
    record = make_record(
        attribution=Attribution(
            environment="production",
            account_id="acct_1",
            subscription_id="sub_123",
            feature_id="support-chat",
            labels={"team": "billing", "a": "z"},
        ),
    )

    assert record.usage.llm is not None
    properties = flatten_audr(record)

    assert properties["usage__llm__input_tokens"] == record.usage.llm.input_tokens
    assert properties["resource__name"] == record.resource.name
    assert properties["attribution__subscription_id"] == "sub_123"
    assert properties["attribution__feature_id"] == "support-chat"
    assert properties["attribution__labels__team"] == "billing"
    assert properties["attribution__labels__a"] == "z"


def test_flatten_audr_accepts_a_configurable_separator() -> None:
    record = make_record(
        attribution=Attribution(environment="production", subscription_id="sub_123"),
    )

    properties = flatten_audr(record, separator="_")

    assert record.usage.llm is not None
    assert properties["usage_llm_input_tokens"] == record.usage.llm.input_tokens
    assert "usage__llm__input_tokens" not in properties


def test_flatten_audr_uses_the_separator_for_label_names() -> None:
    record = make_record(
        attribution=Attribution(
            environment="production",
            subscription_id="sub_123",
            labels={"team": "billing"},
        ),
    )

    properties = flatten_audr(record, separator="_")

    assert properties["attribution_labels_team"] == "billing"
    assert "attribution__labels__team" not in properties


def test_sink_accepts_a_configurable_separator() -> None:
    sink = ChargebeeSink(ingest_url="https://acme.ingest.chargebee.com", api_key="k", separator="_")

    assert sink is not None


@pytest.mark.parametrize("separator", ["-", "", "_a", "a_", " "])
def test_sink_rejects_invalid_separators(separator: str) -> None:
    with pytest.raises(ConfigurationError, match="separator"):
        ChargebeeSink(
            ingest_url="https://acme.ingest.chargebee.com",
            api_key="k",
            separator=separator,
        )
