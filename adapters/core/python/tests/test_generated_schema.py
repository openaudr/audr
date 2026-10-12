import json
import subprocess
import sys
from pathlib import Path
from typing import get_args

import pytest
from pydantic import BaseModel

from audr.record import _schema as gen
from audr.record._base import ExtensibleBase, FrozenBase

ROOT = Path(__file__).resolve().parents[4]
SCHEMA = json.loads((ROOT / "spec/audr.schema.json").read_text())
FIXTURES = ROOT / "conformance" / "fixtures"

# Invalid fixtures the raw generated model cannot reject: they break cross-field rules that live
# in the schema's `allOf` (or in prose) and are enforced by the hand-written layer instead.
CROSS_FIELD_ONLY = {
    "empty-usage-llm.json",
    "model-op-with-cost-tool.json",
    "model-op-with-namespace.json",
    "model-op-with-tool-type.json",
    "tool-op-with-cost-llm.json",
    "tool-op-with-usage-llm.json",
    "usage-both-blocks.json",
}


def test_generated_file_is_fresh() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/gen_models.py", "--check"],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "cls, section",
    [
        (gen.Emitter, "emitter"),
        (gen.Timing, "timing"),
        (gen.Resource, "resource"),
        (gen.Run, "run"),
        (gen.Attribution, "attribution"),
        (gen.Usage, "usage"),
        (gen.Cost, "cost"),
    ],
)
def test_every_schema_property_has_a_field(cls: type[BaseModel], section: str) -> None:
    assert set(SCHEMA["properties"][section]["properties"]) == set(cls.model_fields)


def test_root_fields_match_schema() -> None:
    assert set(SCHEMA["properties"]) == set(gen.AUDR.model_fields)
    assert set(SCHEMA["required"]) == {
        n for n, f in gen.AUDR.model_fields.items() if f.is_required()
    }


def test_extensible_blocks() -> None:
    for extensible in (gen.LlmUsage, gen.ToolUsage, gen.ToolCost):
        assert issubclass(extensible, ExtensibleBase)
    for frozen in (
        gen.Emitter,
        gen.Timing,
        gen.Resource,
        gen.Run,
        gen.Attribution,
        gen.Usage,
        gen.LlmCost,
        gen.Cost,
        gen.AUDR,
    ):
        assert issubclass(frozen, FrozenBase)


def test_operation_literal_matches_schema_enum() -> None:
    annotation = gen.Resource.model_fields["operation"].annotation
    assert set(get_args(annotation)) == set(
        SCHEMA["properties"]["resource"]["properties"]["operation"]["enum"]
    )


def test_extension_keys_accepted_and_others_rejected() -> None:
    assert gen.LlmUsage(input_tokens=1, x_anthropic_thinking_blocks=3).extensions == {
        "x_anthropic_thinking_blocks": 3
    }
    with pytest.raises(ValueError):
        gen.LlmUsage(input_tokens=1, bogus=3)
    with pytest.raises(ValueError):
        gen.LlmUsage(x_a_b=-1)


def _fixtures(kind: str) -> list[Path]:
    paths = sorted((FIXTURES / kind).glob("*.json"))
    assert paths, f"no {kind} fixtures found"
    return paths


ALL_FIXTURES = [
    pytest.param(p, id=f"{p.parent.name}/{p.name}")
    for p in _fixtures("valid") + _fixtures("invalid")
]


@pytest.mark.parametrize("path", ALL_FIXTURES)
def test_generated_model_matches_fixture_expectations(path: Path) -> None:
    payload = json.loads(path.read_text())
    # `received_time` is set by the receiver, never by an emitter, so the SDK model omits it.
    timing = payload.get("timing")
    if isinstance(timing, dict):
        timing.pop("received_time", None)

    if path.parent.name == "valid":
        gen.AUDR.model_validate(payload)
        return

    if path.name in CROSS_FIELD_ONLY:
        # Accepted here; rejected by the hand-written cross-field validation layer.
        gen.AUDR.model_validate(payload)
    else:
        with pytest.raises(ValueError):
            gen.AUDR.model_validate(payload)
