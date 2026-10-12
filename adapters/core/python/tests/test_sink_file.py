from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from audr import SPEC_VERSION, ConfigurationError, FileSink
from audr.sinks import BatchOutcome
from audr.testing import assert_sink_contract, make_record


async def test_writes_one_json_object_per_line(tmp_path: Path) -> None:
    path = tmp_path / "out.jsonl"
    sink = FileSink(path)
    await sink.deliver([make_record(), make_record()])
    await sink.close()
    lines = path.read_text().splitlines()
    assert len(lines) == 2
    assert all(json.loads(line)["spec_version"] == SPEC_VERSION for line in lines)


async def test_append_and_overwrite(tmp_path: Path) -> None:
    path = tmp_path / "o.jsonl"
    for _ in range(2):
        s = FileSink(path)
        await s.deliver([make_record()])
        await s.close()
    assert len(path.read_text().splitlines()) == 2
    s = FileSink(path, append=False)
    await s.deliver([make_record()])
    await s.close()
    assert len(path.read_text().splitlines()) == 1


async def test_stream_target_not_closed() -> None:
    buf = io.StringIO()
    s = FileSink(buf)
    await s.deliver([make_record()])
    await s.close()
    assert not buf.closed and buf.getvalue().endswith("\n")


def test_unknown_format() -> None:
    with pytest.raises(ConfigurationError):
        FileSink("x.csv", format="csv")  # type: ignore[arg-type]


async def test_directory_target_is_a_retryable_failure(tmp_path: Path) -> None:
    sink = FileSink(tmp_path)
    result = await sink.deliver([make_record()])
    assert result.outcome is BatchOutcome.RETRYABLE_FAILURE
    assert result.detail == "IsADirectoryError"


async def test_closed_sink(tmp_path: Path) -> None:
    s = FileSink(tmp_path / "a.jsonl")
    await s.close()
    assert (await s.deliver([make_record()])).outcome is BatchOutcome.CLOSED


async def test_contract(tmp_path: Path) -> None:
    await assert_sink_contract(FileSink(tmp_path / "c.jsonl"))
