#!/usr/bin/env python3
"""Reference conformance runner for AUDR.

Validates every fixture in ../../cases.json against the AUDR JSON Schema and
checks that each produced the outcome the manifest declares.

    python3 conformance/runner/python/run.py           # run the suite
    python3 conformance/runner/python/run.py -v        # show every case

An implementation is schema-conformant when it agrees with this runner on all
38 cases. The fixtures are plain JSON with no Python in them, so a runner in any
language can read cases.json and reproduce these results.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:  # pragma: no cover
    sys.exit("conformance runner needs jsonschema: pip install -r requirements.txt")

HERE = Path(__file__).resolve()
CONFORMANCE = HERE.parent.parent.parent
FIXTURES = CONFORMANCE / "fixtures"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    manifest = json.loads((CONFORMANCE / "cases.json").read_text())
    schema_path = (CONFORMANCE / manifest["schema"]).resolve()
    schema = json.loads(schema_path.read_text())

    Draft202012Validator.check_schema(schema)
    # `format` is annotation-only unless a checker is supplied; AUDR asserts it.
    validator = Draft202012Validator(schema, format_checker=FormatChecker())

    failures = []
    for case in manifest["cases"]:
        record = json.loads((FIXTURES / case["file"]).read_text())
        try:
            errors = list(validator.iter_errors(record))
        except Exception as exc:  # a malformed schema crashes the validator
            failures.append((case, f"validator raised {type(exc).__name__}: {exc}"))
            continue

        actual = "invalid" if errors else "valid"
        ok = actual == case["expect"]
        if not ok:
            detail = errors[0].message if errors else "accepted, expected rejection"
            failures.append((case, detail))
        if args.verbose or not ok:
            mark = "ok  " if ok else "FAIL"
            print(f"  {mark} [{case['rule']:>6}] {case['file']}")

    total = len(manifest["cases"])
    if failures:
        print(f"\n{len(failures)} of {total} conformance cases failed:\n")
        for case, detail in failures:
            print(f"  {case['file']}")
            print(f"    rule {case['rule']}: {case['note']}")
            print(f"    {detail[:160]}\n")
        return 1

    print(f"  {total} conformance cases passed "
          f"({sum(1 for c in manifest['cases'] if c['expect'] == 'valid')} valid, "
          f"{sum(1 for c in manifest['cases'] if c['expect'] == 'invalid')} invalid)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
