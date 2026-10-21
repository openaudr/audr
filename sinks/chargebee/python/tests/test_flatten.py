"""Flattening decides what actually leaves the process for Chargebee.

Every AUDR field ends up here, so the rules are load-bearing: the destination accepts
scalars only, a container must survive as canonical JSON rather than as a repr, and a
value that cannot be encoded must be refused loudly with a pointer naming it — never
silently coerced into something a billing system would read as a number.
"""

from __future__ import annotations

import pytest
from audr import Attribution
from audr.testing import make_record

from audr_sink_chargebee._event_validation import InvalidUsageEventError
from audr_sink_chargebee._flatten import flatten, flatten_audr


def test_nested_objects_become_double_underscore_joined_scalars() -> None:
    flattened = flatten({"a": {"b": {"c": 1}}, "d": "x"})

    assert flattened == {"a__b__c": 1, "d": "x"}


def test_the_separator_is_configurable() -> None:
    assert flatten({"a": {"b": 1}}, separator="_") == {"a_b": 1}


@pytest.mark.parametrize("value", [1, 1.5, "text", True, False, None], ids=str)
def test_json_scalars_pass_through_unchanged(value: object) -> None:
    assert flatten({"field": value}) == {"field": value}


def test_a_list_is_stored_as_canonical_json_under_a_json_suffix() -> None:
    flattened = flatten({"items": [3, 1, 2]})

    assert flattened == {"items__json": "[3,1,2]"}


def test_a_tuple_is_treated_as_a_list() -> None:
    assert flatten({"items": (1, 2)}) == {"items__json": "[1,2]"}


def test_each_label_becomes_its_own_property() -> None:
    flattened = flatten({"labels": {"team": "core", "cost-center": "r1", "env.tier": "gold"}})

    assert flattened == {
        "labels__team": "core",
        "labels__cost_center": "r1",
        "labels__env_tier": "gold",
    }


def test_label_keys_that_collide_after_rewriting_reject_the_record() -> None:
    with pytest.raises(InvalidUsageEventError) as excinfo:
        flatten({"attribution": {"labels": {"a.b": "1", "a-b": "2"}}})

    assert "/attribution/labels" in str(excinfo.value)
    assert "1" not in str(excinfo.value) and "2" not in str(excinfo.value)


def test_canonical_json_is_stable_across_input_ordering() -> None:
    one = flatten({"items": [{"a": 1, "b": 2}]})
    other = flatten({"items": [{"b": 2, "a": 1}]})

    assert one == other


def test_non_ascii_values_are_not_escaped() -> None:
    flattened = flatten({"labels": {"team": "Ümlaut"}, "items": ["Ümlaut"]})

    assert flattened["labels__team"] == "Ümlaut"
    assert flattened["items__json"] == '["Ümlaut"]'


def test_an_empty_nested_object_contributes_no_properties() -> None:
    assert flatten({"a": {}, "b": 1}) == {"b": 1}


# --- refusals -----------------------------------------------------------------------


def test_a_non_mapping_record_is_refused() -> None:
    with pytest.raises(InvalidUsageEventError, match="must encode to a JSON object"):
        flatten(["not", "a", "mapping"])  # type: ignore[arg-type]


def test_a_value_that_is_not_json_encodable_names_its_pointer() -> None:
    with pytest.raises(InvalidUsageEventError, match="/outer/inner"):
        flatten({"outer": {"inner": object()}})


def test_a_non_encodable_value_inside_a_list_names_the_list_pointer() -> None:
    with pytest.raises(InvalidUsageEventError, match="/outer/items"):
        flatten({"outer": {"items": [object()]}})


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")], ids=str)
def test_non_finite_numbers_are_refused_inside_containers(value: float) -> None:
    """`json.dumps` would happily emit `NaN`, which is not JSON and which a billing
    system must never receive."""
    with pytest.raises(InvalidUsageEventError, match="not JSON-encodable"):
        flatten({"items": [value]})


def test_a_pointer_escapes_the_characters_rfc_6901_reserves() -> None:
    with pytest.raises(InvalidUsageEventError, match=r"/a~1b/c~0d"):
        flatten({"a/b": {"c~d": object()}})


# --- whole records ------------------------------------------------------------------


def test_a_real_record_flattens_to_scalars_only() -> None:
    record = make_record(
        attribution=Attribution(
            environment="production",
            account_id="acct_1",
            subscription_id="sub_1",
            labels={"team": "billing"},
        )
    )

    flattened = flatten_audr(record)

    assert flattened
    assert all(
        value is None or isinstance(value, str | int | float | bool) for value in flattened.values()
    ), flattened


def test_a_real_record_keeps_every_property_name_addressable_by_chargebee() -> None:
    """Chargebee property names must match `[a-zA-Z][a-zA-Z0-9_]*`."""
    import re

    pattern = re.compile(r"[a-zA-Z][a-zA-Z0-9_]*")
    flattened = flatten_audr(make_record())

    assert [key for key in flattened if not pattern.fullmatch(key)] == []


def test_record_labels_become_one_property_each() -> None:
    record = make_record(
        attribution=Attribution(
            environment="test",
            subscription_id="s",
            labels={"team": "billing", "cost-center": "r1"},
        )
    )

    flattened = flatten_audr(record)

    assert flattened["attribution__labels__team"] == "billing"
    assert flattened["attribution__labels__cost_center"] == "r1"


def test_absent_optional_fields_produce_no_properties() -> None:
    """The encoder drops `None` before flattening, so an unset field is absent
    rather than present-and-null."""
    flattened = flatten_audr(
        make_record(attribution=Attribution(environment="test", subscription_id="s"))
    )

    assert "attribution__account_id" not in flattened
    assert [key for key in flattened if key.startswith("attribution__labels__")] == []
