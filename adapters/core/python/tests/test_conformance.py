"""The cross-language conformance gate: `conformance/cases.json` is the contract."""

import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from audr.errors import ValidationError
from audr.record import AUDR

ROOT = Path(__file__).resolve().parents[4]
CASES: list[dict[str, Any]] = json.loads((ROOT / "conformance/cases.json").read_text())["cases"]
SCHEMA = json.loads((ROOT / "spec/audr.schema.json").read_text())
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA, format_checker=jsonschema.FormatChecker())


def load(case: dict[str, Any]) -> dict[str, Any]:
    """Fixture paths in the manifest are relative to `conformance/fixtures/`."""
    payload = json.loads((ROOT / "conformance" / "fixtures" / case["file"]).read_text())
    # `received_time` is stamped by the sink, so an emitter SDK never round-trips it.
    timing = payload.get("timing")
    if isinstance(timing, dict):
        timing.pop("received_time", None)
    return payload  # type: ignore[no-any-return]


def sdk_accepts(data: dict[str, Any]) -> bool:
    try:
        AUDR.from_dict(data)
    except ValidationError:
        return False
    return True


def test_manifest_is_the_expected_size() -> None:
    assert len(CASES) == 42
    assert sum(c["expect"] == "valid" for c in CASES) == 17


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["file"])
def test_agrees_with_manifest(case: dict[str, Any]) -> None:
    assert sdk_accepts(load(case)) is (case["expect"] == "valid"), case.get("note")


@pytest.mark.parametrize(
    "case", [c for c in CASES if c["expect"] == "valid"], ids=lambda c: c["file"]
)
def test_valid_records_round_trip_and_stay_schema_valid(case: dict[str, Any]) -> None:
    data = load(case)
    out = AUDR.from_dict(data).to_dict()
    VALIDATOR.validate(out)
