# Contributing to AUDR

AUDR is an open specification with reference packages that implement it. This document
describes how the repository is set up, where each kind of change belongs, and how a
change is proposed, reviewed, and accepted. Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting an issue

Use one of two channels:

- **[GitHub issues](https://github.com/openaudr/audr/issues)** — the default.
  Public discussion is preferred, because it records the reasoning behind a
  decision where the next implementer will find it.
- **<audr@chargebee.com>** — for matters that do not belong in a public tracker,
  such as those disclosing commercial pricing or volume data.

Do not report a suspected vulnerability through either channel. Follow
[SECURITY.md](SECURITY.md).

The most valuable report is a cost model that AUDR cannot express. State the
operation to be metered, the record that was attempted, and the constraint that
prevented it.

## Repository setup

Prerequisites: Python 3.11 or later, and [`uv`](https://docs.astral.sh/uv/) for the
Python packages; Node.js 22.18 or later, with `npm`, for the TypeScript packages.

```bash
git clone https://github.com/openaudr/audr.git
cd audr
make install     # tooling for the specification: jsonschema, PyYAML
make check       # schema, examples, conformance fixtures, cross-references, staleness, docs
make python      # lint and test every Python package
make typescript  # lint, test and package-check every TypeScript package
make all         # check + python + typescript: everything CI runs
```

| Target | Does |
| --- | --- |
| `make spec` | Regenerate `spec/SPEC.md` from the schema, the outline and the prose |
| `make schema` | Meta-validate `spec/audr.schema.json` against JSON Schema Draft 2020-12 |
| `make examples` | Validate every specification example against the schema |
| `make conformance` | Run the shared conformance fixtures |
| `make lint` | Check that `$id` cross-references resolve |
| `make fresh` | Fail if any generated file is stale |
| `make links` | Check that every relative link in the repository resolves |
| `make versions` | Fail if a distribution version is written into any Markdown file |
| `make core-python` | `make verify` in `adapters/core/python` |
| `make adapter-nemo-relay-python` | `make lint test` in `adapters/nemo-relay/python` |
| `make sink-chargebee-python` | `make lint test` in `sinks/chargebee/python` |
| `make core-typescript` | `make install verify` in `adapters/core/typescript` |

## Where a change belongs

| To change | Read |
| --- | --- |
| The specification, schema or conformance fixtures | The classes of change below |
| An existing package | That package's `AGENTS.md`, for example [`adapters/core/python/AGENTS.md`](adapters/core/python/AGENTS.md) |
| A new adapter | [`adapters/CONTRIBUTING.md`](adapters/CONTRIBUTING.md) |
| A new sink | [`sinks/CONTRIBUTING.md`](sinks/CONTRIBUTING.md) |
| Any `README.md`, `CONTRIBUTING.md` or `AGENTS.md` | The Documentation section below |

## Classes of change

### Editorial changes

_Examples: correcting a typographical error, repairing a broken link, rewording
a sentence without altering its meaning, correcting an example._

Submit a pull request directly. No issue is required.

### Normative changes

_Examples: adding, removing, or renaming a field; changing a type, requirement
level, or constraint; adding a value to a closed enumeration; altering the
meaning of an existing requirement._

Open an issue describing the problem and wait for it to be accepted before
submitting a pull request. A normative change alters what conformant
implementations are required to do, so the problem is agreed before a solution
is evaluated. A pull request opened without an accepted issue may be closed
without review.

A draft pull request may accompany the issue to illustrate a proposal, but it
does not substitute for one.

## Published versions

A published version of the specification is immutable. Its schema is served at a
permanent `$id` URL that implementations resolve at runtime, and records already
written declare that version.

No change is therefore made to the contents of a published version, however
trivial. A defect in a published version is corrected by publishing a new
version and recording what was wrong; it is never corrected by editing the
published artefacts in place.

## Packages

The reference implementations live under `adapters/<name>/<language>/` (things that
produce records) and `sinks/<name>/<language>/` (things that consume records).
[`adapters/README.md`](adapters/README.md) and [`sinks/README.md`](sinks/README.md) define
the two kinds; their `CONTRIBUTING.md` files describe how to build one.

### Naming

A package is named `audr-<kind>-<target>` (for example `audr-sink-chargebee`,
`audr-adapter-nemo-relay`), kind before target, so tooling, `CODEOWNERS`, and alphabetical
listings group every sink together and every adapter together. The import package is the
distribution name with hyphens replaced by underscores. Its CI workflow is
`.github/workflows/<kind>-<target>-<language>-verify.yml`. The core is the one exception:
`audr`, not `audr-adapter-core`.

### Shared Python toolchain

Each package directory is a standalone project with its own lockfile, tests, and release
cadence — there is no repository-wide workspace. Every Python package uses the same
toolchain, and a new one matches it rather than adding another:

| Concern | Choice |
| --- | --- |
| Python | 3.11 or later |
| Layout and build | `src/` layout, Hatchling; version in `src/<import_package>/_version.py` |
| Environment | `uv`, with `uv.lock` committed |
| Formatter and linter | Ruff, `line-length = 100` |
| Types | mypy `strict`; `py.typed` ships in the wheel |
| Tests | pytest with `asyncio_mode = "auto"`; coverage gated at 90% |

Every package `Makefile` provides the same targets:

```bash
make install   # uv sync --locked --group dev
make lint      # ruff check, ruff format --check, mypy
make test      # pytest --cov
make build     # uv build
make verify    # everything that package's CI runs
```

Run `make verify` in the package before opening a pull request. Do not weaken or skip a
lint, type-check or coverage gate to make a change pass.

### Shared TypeScript toolchain

TypeScript packages follow the same rules: a standalone project per directory, the same
`Makefile` targets, and one toolchain shared by every package:

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 22.12 or later for users; 22.18 or later to develop (examples run with type stripping) |
| Module format | ESM only, `"type": "module"`; `exports` map with one entry per public subpath |
| Build | `tsc` to `dist/` with declarations; no bundler; version in `package.json` |
| Environment | `npm`, with `package-lock.json` committed |
| Formatter and linter | Prettier, `printWidth` 100; ESLint with typescript-eslint `strictTypeChecked` |
| Types | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Tests | Vitest with v8 coverage gated at 90% |
| Package checks | `publint --strict` and `attw`, plus an install-from-tarball isolation check |

The `make install / lint / test / build / verify` targets mean the same as for Python;
`make install` runs `npm ci`.

## Documentation

Every fact has one home. A document states a fact if and only if it is that fact's home;
every other document links to it.

| Document | Audience | Depth |
| --- | --- | --- |
| `README.md` | A reader who uses the software | Repository, tier, component, language package |
| `CONTRIBUTING.md` | A reader who wants a change accepted | Repository and tier only |
| `AGENTS.md` | Anyone working inside that tree — a coding agent or a maintainer | Repository, tier, language package |
| `docs/*.md` | A reader who uses the software and needs the full reference | Language package |

| Fact | Home |
| --- | --- |
| What an adapter is; what a sink is | `adapters/README.md`; `sinks/README.md` |
| The sink contract and delivery states | `adapters/core/README.md` |
| Package naming, repository setup, the shared toolchain | This document |
| Implementing a new adapter or sink | `adapters/CONTRIBUTING.md`; `sinks/CONTRIBUTING.md` |
| How to work inside one package | That package's `AGENTS.md` |
| Data-handling prohibitions | `SECURITY.md` |
| The example AUDR record | `README.md` |
| Reference detail a package's README is too long to carry | That package's `docs/` |

Rules that follow from the table:

- A `*/python/README.md` is the distribution's long description on PyPI, and a
  `*/typescript/README.md` is the package's page on npm. Each is self-contained,
  user-facing only, and links outward with absolute `https://github.com/openaudr/audr/...`
  URLs.
- No Markdown file states a distribution version. Use a PyPI or npm badge;
  `make versions` enforces this.
- Every code block in a `README.md` is either runnable exactly as shown, or visibly elided
  with `...` and a comment naming where the full form lives. No code block appears in two
  READMEs.
- Every relative link resolves; `make links` enforces this.

## Pull requests

- Address one concern per pull request.
- Describe the problem being solved, not only the change being made.
- Reference the issue the pull request resolves, where one exists.
- Where the change affects [`audr.schema.json`](spec/audr.schema.json),
  state which records become valid, or invalid, that were not before.

[`SPEC.md`](spec/SPEC.md) is a generated document: the field tables are
derived from the schema. Propose a change to a field's type, requirement level,
or description in [`audr.schema.json`](spec/audr.schema.json) rather than
in the rendered specification.

## Licensing

Contributions are accepted under the [Apache License 2.0](LICENSE), which covers
this repository. By submitting a contribution you certify that you have the
right to submit it under that licence.
