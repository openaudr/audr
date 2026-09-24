"""Per-request attribution: static defaults merged with Relay's `audr` metadata.

When attribution cannot be resolved the integration skips the record and reports a
JSON Pointer instead. That pointer is what an operator sees when a Relay deployment
is misconfigured, so it must name the exact thing that is wrong — a pointer that
degrades to `/metadata` when it could have said `/metadata/audr/account_id` turns a
one-line fix into a hunt.
"""

from __future__ import annotations

import pytest
from audr import Attribution

from audr_adapter_nemo_relay._attribution import resolve_attribution

_DEFAULTS = Attribution(environment="production", account_id="acct_default")


def test_absent_metadata_falls_back_to_the_static_defaults() -> None:
    attribution, issue = resolve_attribution(defaults=_DEFAULTS, metadata=None)

    assert issue is None
    assert attribution == _DEFAULTS


def test_metadata_without_the_audr_namespace_falls_back_to_the_defaults() -> None:
    attribution, issue = resolve_attribution(
        defaults=_DEFAULTS, metadata={"tracing": {"trace_id": "t-1"}}
    )

    assert issue is None
    assert attribution == _DEFAULTS


def test_namespace_values_override_the_defaults_field_by_field() -> None:
    attribution, issue = resolve_attribution(
        defaults=_DEFAULTS,
        metadata={"audr": {"account_id": "acct_override", "subscription_id": "sub_1"}},
    )

    assert issue is None
    assert attribution is not None
    assert attribution.account_id == "acct_override"
    assert attribution.subscription_id == "sub_1"
    assert attribution.environment == "production"  # untouched by the override


def test_default_labels_survive_a_partial_override() -> None:
    defaults = Attribution(environment="production", account_id="a", labels={"team": "billing"})

    attribution, issue = resolve_attribution(
        defaults=defaults, metadata={"audr": {"account_id": "b"}}
    )

    assert issue is None
    assert attribution is not None
    assert attribution.labels == {"team": "billing"}
    assert attribution.account_id == "b"


@pytest.mark.parametrize(
    ("metadata", "pointer"),
    [
        pytest.param(["not", "a", "mapping"], "/metadata", id="metadata-not-a-mapping"),
        pytest.param("a string", "/metadata", id="metadata-is-a-string"),
        pytest.param({"audr": "a string"}, "/metadata/audr", id="namespace-not-a-mapping"),
        pytest.param({"audr": ["a", "list"]}, "/metadata/audr", id="namespace-is-a-list"),
        pytest.param(
            {"audr": {"account_id": 123}},
            "/metadata/audr/account_id",
            id="wrong-type-for-a-known-field",
        ),
        pytest.param(
            {"audr": {"not_a_field": "x"}},
            "/metadata/audr",
            id="unknown-field-in-the-namespace",
        ),
        pytest.param(
            {"audr": {"account_id": ""}},
            "/metadata/audr/account_id",
            id="empty-string-cannot-be-billed-on",
        ),
        pytest.param(
            {"audr": {"user_id": "person@example.com"}},
            "/metadata/audr/user_id",
            id="user-id-must-stay-pseudonymous",
        ),
    ],
)
def test_unresolvable_attribution_names_the_exact_field(metadata: object, pointer: str) -> None:
    attribution, issue = resolve_attribution(defaults=_DEFAULTS, metadata=metadata)

    assert attribution is None
    assert issue == pointer


def test_incomplete_attribution_is_reported_against_the_record_not_the_metadata() -> None:
    """Nothing supplied `environment`, so the pointer names the record's field."""
    attribution, issue = resolve_attribution(defaults=Attribution(), metadata=None)

    assert attribution is None
    assert issue == "/attribution/environment"


def test_a_production_record_still_needs_an_account_id() -> None:
    attribution, issue = resolve_attribution(
        defaults=Attribution(environment="production"), metadata=None
    )

    assert attribution is None
    assert issue == "/attribution/account_id"


def test_subscription_id_is_not_required_here() -> None:
    """Requiring it is a Chargebee sink rule; the adapter must not invent it."""
    attribution, issue = resolve_attribution(defaults=_DEFAULTS, metadata=None)

    assert issue is None
    assert attribution is not None
    assert attribution.subscription_id is None
