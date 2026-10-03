# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared Python toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To emit records from an application, see [`README.md`](README.md); this file covers
changes to the package itself.

## What this is

`adapters/core/python` is the `audr` distribution: the reference Python implementation of
the Agent Usage Detail Record (AUDR) standard, and the package every adapter and sink
depends on. It is destination-neutral: a sink plugs into this package, never the reverse,
and this package must not depend on a particular destination or runtime.

## Layout

| Path | Owns |
| --- | --- |
| `src/audr/record/` | The AUDR Pydantic models, encoding, and validation |
| `src/audr/sinks/` | The sink contract (`Sink`, `BatchResult`, `BatchOutcome`) and the one bundled implementation, `FileSink` |
| `src/audr/client.py`, `src/audr/_pipeline.py` | The bounded, batching async delivery pipeline behind `Client` |
| `src/audr/testing.py` | `MemorySink`, `make_record`, and `assert_sink_contract`: a harness for testing sinks |
| `tests/` | The pytest suite for this distribution |
| `examples/` | Runnable examples; no credentials or network calls required; `make examples` and CI run them |
| `docs/reference.md` | The API reference the README links to; update it with any public behaviour change |
| `scripts/gen_models.py` | Generates `src/audr/record/_schema.py` from the spec |
| `scripts/verify_distribution.py` | The isolation check `make isolation` runs against the built wheel |
| `../../../spec/` | The normative schema and prose; not packaged into the wheel |
| `../../../conformance/` | Shared fixtures `tests/test_conformance.py` runs |

## Rules

1. `audr.__all__`, `audr.sinks.__all__` and `audr.testing.__all__` define the public API,
   and `tests/test_public_api.py` pins them. Adding a name to any of these lists is a
   public API change; make such additions deliberately and update the test. Keep the
   surface small, and prefer keyword-only constructors and explicit types.
2. Runtime dependencies are `pydantic` and `uuid6`. Do not add `httpx`, an adapter
   runtime, or a sink for a specific destination. Those belong in their own package under
   `adapters/` or `sinks/`. `make isolation` builds the wheel and checks that it installs
   and runs without them.
3. `record()` is the only entry point to the delivery pipeline. It is synchronous and
   non-blocking and returns a `SubmitResult`. A change that lets a caller await the
   delivery of a single record requires an agreed issue first.
4. Every record admitted through `record()` ends in exactly one terminal state: `sent`,
   `dropped` or `unknown`. The states are defined in
   [`../README.md`](../README.md#delivery-states). `unknown` is terminal; never relabel it.
5. `src/audr/record/_schema.py` is generated. Do not edit it by hand. Edit
   `scripts/gen_models.py`, or `spec/` if the schema itself is wrong, then run
   `make models`. `make models-check` fails CI when the file drifts. Do not package the
   JSON Schema into the wheel.
6. Diagnostics carry field names and JSON-pointer paths, never values. `ValidationIssue`
   carries a code and a path, never a value.
7. `Sink` is a structural `Protocol`. A third-party sink imports `BatchResult` and
   `RejectedRecord` and subclasses nothing. Treat `audr.testing` as a test harness, not as
   delivery-pipeline API.
8. `shutdown()` closes the sink, including one the caller supplied. `owns_sink=False` opts
   out for a sink that outlives the client.
9. Reading is more tolerant than writing. Read the specification's versioning rules before
   loosening a validation rule.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-python-toolchain). The version lives in
`src/audr/_version.py`. Targets beyond the shared `install / lint / test / build`:

```bash
make models          # regenerate src/audr/record/_schema.py from spec/
make models-check    # fail if the generated models drift from spec/
make conformance     # the shared fixtures only (tests/test_conformance.py)
make isolation       # build, then verify the wheel installs and runs with no extra deps
make verify          # lint + models-check + test + isolation
```
