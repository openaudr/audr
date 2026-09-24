# AGENTS.md

Guidance for anyone working in this repository, whether a coding agent or a maintainer.
A nearer `AGENTS.md` takes precedence for work under its directory; this file covers
everything else. The contribution process is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## What this repository is

AUDR is an open standard: one JSON record per metered agent operation, carrying enough
identity and attribution that records from different systems join.

| Tree | Holds |
| --- | --- |
| `spec/` | The normative schema, the prose, and the generated `SPEC.md` |
| `conformance/` | Language-neutral fixtures every implementation must reproduce |
| `adapters/` | Packages that produce records — the core SDK and runtime adapters |
| `sinks/` | Packages that consume records and deliver them to a destination |
| `tools/` | The specification generator and the repository checks |

## Nearer directives

| Working in | Read |
| --- | --- |
| `adapters/` | [`adapters/AGENTS.md`](adapters/AGENTS.md) |
| `adapters/core/python/` | [`adapters/core/python/AGENTS.md`](adapters/core/python/AGENTS.md) |
| `adapters/nemo-relay/python/` | [`adapters/nemo-relay/python/AGENTS.md`](adapters/nemo-relay/python/AGENTS.md) |
| `sinks/` | [`sinks/AGENTS.md`](sinks/AGENTS.md) |
| `sinks/chargebee/python/` | [`sinks/chargebee/python/AGENTS.md`](sinks/chargebee/python/AGENTS.md) |

## Invariants

1. `spec/SPEC.md` is generated. Edit `spec/audr.schema.json`, `spec/prose/` or the outline
   and run `make spec`. Never hand-edit the rendered specification.
2. A published specification version is immutable. A defect is corrected by publishing a
   new version, never by editing published artefacts.
3. No AUDR record field *value* may appear in a log message, an exception or a
   representation. Names and JSON-pointer paths only.
4. Records carry no prompt content, no key material and no PII. [`SECURITY.md`](SECURITY.md)
   holds the full rules.
5. Never commit credentials, real site names or `.env` files.
6. No Markdown file states a distribution version. Use a badge.
7. Do not weaken or skip a lint, type-check or coverage gate to make a change pass.

## Process

- Before changing the specification or adding an adapter or sink, confirm that an accepted
  issue exists. If none exists, stop and report it.
  [`CONTRIBUTING.md`](CONTRIBUTING.md#classes-of-change) defines which changes require an
  issue.
- Record every user-visible change to a package under `[Unreleased]` in its
  `CHANGELOG.md`.

## Verification

```bash
make install   # tooling dependencies
make check     # schema, examples, conformance, cross-references, staleness, links, versions, tools
make python    # lint and test every Python package
make all       # check + python
```

A change to `spec/`, `conformance/` or `tools/` is done when `make check` passes. A change
to a package is done when that package's `make verify` passes. A change touching both is
done when `make all` passes.

## Documentation

`README.md` is for users; a `CONTRIBUTING.md` is for contributors and
exists only at the repository root and in `adapters/` and `sinks/`; an `AGENTS.md` is for
whoever works inside its tree. A `*/python/README.md` is a PyPI long description and must
stay self-contained with absolute URLs. The full table of where each fact lives is the
Documentation section of [`CONTRIBUTING.md`](CONTRIBUTING.md#documentation).
