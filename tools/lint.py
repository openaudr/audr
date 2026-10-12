#!/usr/bin/env python3
"""Cross-reference checks the schema and the prose cannot make about themselves.

A schema's $id names the URL the schema is published at, and implementations
resolve it at runtime. Checks that the two agree.

    python3 tools/lint.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def check_version_claims() -> list[str]:
    """
    $id names the URL the schema is published at, and openaudr.dev serves the
    schema verbatim at that path. `pattern` states the range of spec_version
    values a record may carry; `examples[0]` states the one concrete version
    this schema is.
    """
    schema = json.loads((ROOT / "spec/audr.schema.json").read_text())
    spec_version = schema["properties"]["spec_version"]
    version = spec_version["examples"][0]
    pattern = spec_version["pattern"]

    problems = []
    # The working draft on main carries a -dev suffix; check_release.py rejects it at tag time.
    expected = f"https://openaudr.dev/spec/v{version}/audr.schema.json"
    draft = f"https://openaudr.dev/spec/v{version}-dev/audr.schema.json"
    if schema["$id"] not in (expected, draft):
        problems.append(
            f"$id is {schema['$id']!r}, but the site publishes it at {expected!r}"
        )
    if not re.fullmatch(pattern, version):
        problems.append(
            f"spec_version example {version!r} does not match its own "
            f"pattern {pattern}"
        )
    return problems


def main() -> int:
    problems = check_version_claims()
    if problems:
        print(f"{len(problems)} cross-reference problem(s):")
        for p in problems:
            print(f"  {p}")
        return 1
    print("  version claims agree across the schema")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
