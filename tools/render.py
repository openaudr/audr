#!/usr/bin/env python3
"""Render the AUDR specification from its schema, outline and prose partials.

Usage:
    python3 tools/render.py [--check]

Writes:
    spec/SPEC.md

With --check, renders to memory and exits non-zero if any output on disk
differs. That is what CI runs, so a hand-edited generated file fails the build.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
import schema_model as sm  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BANNER = "GENERATED FILE -- field semantics are derived from audr.schema.json."
VERSION_IN_ID = re.compile(r"/spec/v(\d+\.\d+\.\d+)/")


# --------------------------------------------------------------------------
# sources
# --------------------------------------------------------------------------


def load_sources():
    base = ROOT / "spec"
    outline = yaml.safe_load((base / "outline.yaml").read_text())
    schema = sm.load(base / outline["schema"])
    return base, outline, schema


def version_of(schema: dict) -> str:
    """The document version, derived from the schema's $id."""
    match = VERSION_IN_ID.search(schema["$id"])
    if not match:
        raise SystemExit(f"$id {schema['$id']!r} carries no /spec/vX.Y.Z/ version")
    return match.group(1)


def substitute(text: str, version: str) -> str:
    """Resolve the {version} placeholder in authored text."""
    return text.replace("{version}", version)


def read_prose(base: Path, rel: str, version: str) -> tuple[dict, str]:
    """Split a prose partial into its YAML front matter and body."""
    text = (base / rel).read_text()
    if text.startswith("---\n"):
        _, fm, body = text.split("---\n", 2)
        return yaml.safe_load(fm) or {}, substitute(body.strip(), version)
    return {}, substitute(text.strip(), version)


def read_example(base: Path, rel: str) -> str:
    return (base / rel).read_text().strip()


# --------------------------------------------------------------------------
# field tables
# --------------------------------------------------------------------------


def table_rows(schema: dict, spec: dict) -> list[dict]:
    rows = sm.fields(schema, spec["pointer"], spec.get("prefix", ""))
    if "only" in spec:
        keep = {f"{spec.get('prefix', '')}{n}" for n in spec["only"]}
        rows = [r for r in rows if r["name"] in keep]
    if "order" in spec:
        rank = {f"{spec.get('prefix', '')}{n}": i for i, n in enumerate(spec["order"])}
        rows.sort(key=lambda r: rank.get(r["name"], len(rank)))
    return rows


def md_cell(text: str) -> str:
    """Escape a schema summary for a Markdown table cell.

    Angle brackets are escaped because these cells are rendered as HTML, where
    a placeholder such as ``x_<provider>_<name>`` would otherwise be eaten as a
    tag.
    """
    return text.replace("|", r"\|").replace("<", "&lt;").replace(">", "&gt;")


def md_table(rows: list[dict]) -> str:
    out = [
        "| Field Name | Type | Required | Description |",
        "| --- | --- | --- | --- |",
    ]
    for r in rows:
        out.append(
            f"| `{md_cell(r['name'])}` | {md_cell(r['type'])} "
            f"| {r['requirement']} | {md_cell(r['summary'])} |"
        )
    return "\n".join(out)


# --------------------------------------------------------------------------
# document metadata (derived from the schema, never authored)
# --------------------------------------------------------------------------


def metadata(schema: dict) -> list[tuple[str, str]]:
    return [
        ("Schema ID", f"`{schema['$id']}`"),
        ("Root type", f"JSON {schema['type']}"),
        ("Schema dialect", f"`{schema['$schema']}`"),
        ("Version pattern", f"`{schema['properties']['spec_version']['pattern']}`"),
    ]


# --------------------------------------------------------------------------
# markdown document
# --------------------------------------------------------------------------


def render_markdown(base: Path, outline: dict, schema: dict) -> str:
    version = version_of(schema)
    p = [f"<!-- {BANNER} -->", ""]
    p.append(f"# {outline['title']}")
    p.append("")
    p.append(f"**{substitute(outline['subtitle'], version)}**")
    p.append("")
    p.append(outline["tagline"])
    p.append("")

    for rel in outline["front"]:
        fm, body = read_prose(base, rel, version)
        if fm.get("title"):
            num = f"{fm['number']}. " if fm.get("number") else ""
            p.extend(anchor(fm.get("id")))
            p.append(f"## {num}{fm['title']}")
            p.append("")
        p.append(body)
        p.append("")
        if fm.get("id") == "introduction":
            for k, v in metadata(schema):
                p.append(f"**{k}**: {v}")
                p.append("")

    for sec in outline["sections"]:
        h = heading(sec["number"])
        sub_h = h + "#"
        p.extend(anchor(sec.get("id")))
        p.append(f"{h} {sec['number']} {heading_text(sec)}")
        p.append("")
        if sec.get("heading_only"):
            continue
        if sec.get("prose"):
            _, body = read_prose(base, sec["prose"], version)
            p.append(body)
            p.append("")
        n = 1
        if sec.get("example"):
            p.append(f"{sub_h} {sec['number']}.{n} JSON Example")
            p.append("")
            p.append("```json")
            p.append(read_example(base, sec["example"]))
            p.append("```")
            p.append("")
            n += 1
        if sec.get("examples"):
            p.append(f"{sub_h} {sec['number']}.{n} JSON Examples")
            p.append("")
            n += 1
        for ex in sec.get("examples", []):
            p.append("```json")
            p.append(read_example(base, ex["path"]))
            p.append("```")
            p.append("")
        if sec.get("table"):
            p.append(f"{sub_h} {sec['number']}.{n} Field Descriptions")
            p.append("")
            p.append(md_table(table_rows(schema, sec["table"])))
            p.append("")
        for sub in sec.get("subtables", []):
            p.append(f"{sub_h} {sub['number']} {sub['title']}")
            p.append("")
            if sub.get("example"):
                p.append("```json")
                p.append(read_example(base, sub["example"]))
                p.append("```")
                p.append("")
            p.append(md_table(table_rows(schema, sub)))
            p.append("")

    for rel in outline["back"]:
        _, body = read_prose(base, rel, version)
        p.append("---")
        p.append("")
        p.append(body)
        p.append("")

    p.append(f"Agent Usage Detail Record · Specification v{version}")
    p.append("")
    return "\n".join(p).rstrip() + "\n"


def anchor(ident: str | None) -> list[str]:
    """A stable link target for a heading."""
    return [f'<a id="{ident}"></a>', ""] if ident else []


def heading(number: str) -> str:
    """Markdown heading marks for a section number: `3` is `##`, `3.4.1` is `####`."""
    return "#" * min(6, number.count(".") + 2)


def heading_text(sec: dict) -> str:
    if sec.get("code", True) and sec["title"].islower():
        return f"`{sec['title']}`"
    return sec["title"]


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def outputs() -> dict[Path, str]:
    base, outline, schema = load_sources()
    return {base / "SPEC.md": render_markdown(base, outline, schema)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if outputs are stale")
    args = ap.parse_args()

    stale = []
    for path, content in outputs().items():
        rel = path.relative_to(ROOT)
        if args.check:
            if not path.exists() or path.read_text() != content:
                stale.append(rel)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            print(f"  wrote {rel}")

    if args.check:
        if stale:
            print("Generated files are stale. Run `make spec` and commit the result:")
            for rel in stale:
                print(f"  {rel}")
            return 1
        print("  generated files are up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
