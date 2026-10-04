# Contributing a sink

A sink receives batches of AUDR records from a `Client` and delivers them to a destination.
[`README.md`](README.md) defines the kind; this document describes how to propose and build
one. Repository-wide process — issues, pull requests, naming, the shared Python toolchain,
licensing — is in the top-level [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Before writing code

Open an issue naming the destination, its ingest API, and how it identifies and
de-duplicates an event. The routing key and the de-duplication key are agreed before code
is written, because a change to either after release changes what customers are billed.

A sink maintained outside this repository is welcome too. Open an issue and it will be
linked from [`README.md`](README.md).

## The contract

A sink implements the contract defined in
[`adapters/core/README.md`](../adapters/core/README.md#the-sink-contract): two asynchronous
methods, `deliver(batch) -> BatchResult` and `close()`, and a typed outcome for every
batch. The rules a sink must hold to:

- **Report, never raise.** `deliver()` returns `BatchResult.failed(retryable=...)` for a
  whole-batch failure and names individual records in `rejected` or `unknown` on an
  accepted batch. `close()` is idempotent and never raises. An exception escaping either
  method is a defect.
- **Retry inside `deliver()`, or not at all.** The pipeline never retries a batch. A sink
  that wants retries implements them itself, bounded by a policy the host configures, and
  reports `RETRYABLE_FAILURE` only once that budget is spent.
- **Be conservative about acceptance.** A record the destination did not confirm is
  `unknown`, never assumed `sent`. `record_id` is the de-duplication key, so a replay of an
  `unknown` record is safe.
- **Forward the whole record.** Every field, including `attribution.labels` and `x_*`
  extensions, reaches the destination. The sink adds nothing and removes nothing.
- **Hold credentials privately.** They are taken as constructor arguments, optionally
  backed by environment variables at the call site, and never appear in logs, errors or
  `repr()`.
- **Keep record values out of diagnostics.** Log and error messages carry field names,
  JSON-pointer paths and outcome codes. They MUST NOT contain record field values,
  including record identifiers.

`audr.testing.assert_sink_contract(sink)` exercises these rules. It runs in every sink's
test suite; a sink that does not pass it is not accepted.

## Python specifics

```python
class Sink(Protocol):
    async def deliver(self, batch: Sequence[AUDR]) -> BatchResult: ...
    async def close(self) -> None: ...
```

`Sink` is a structural `Protocol`. A sink imports `BatchResult` and `RejectedRecord` from
`audr` and subclasses nothing. HTTP sinks use `httpx` with an explicit timeout and a
bounded retry policy; the transport, the encoding of a record into the destination's event
shape, and the response-to-`BatchResult` mapping are separate modules, each tested on its
own. `make isolation` builds the wheel and proves it installs and runs with only its
declared dependencies.

The [Chargebee sink](chargebee/python/README.md) is the reference implementation.

## What a new sink ships

Directory `sinks/<target>/<language>/`, distribution `audr-sink-<target>`, import package
`audr_sink_<target>`. The package contains:

| Path | Purpose |
| --- | --- |
| `pyproject.toml`, `uv.lock` | Build metadata and locked environment, on the shared toolchain |
| `Makefile` | `install`, `lint`, `test`, `build`, `isolation`, `verify` |
| `src/audr_sink_<target>/` | The package, with `_version.py` as the single version source and `py.typed` |
| `tests/` | The suite, at 90% coverage or above, including `assert_sink_contract` and a test that no live network call is made |
| `scripts/verify_distribution.py` | The isolation check `make isolation` runs |
| `README.md` | The PyPI long description: install, configure, routing and delivery semantics, data handling; absolute URLs only |
| `AGENTS.md` | How to work inside this package |
| `CHANGELOG.md`, `LICENSE`, `NOTICE` | Release history and licensing |

Outside the package: a workflow `.github/workflows/sink-<target>-python-verify.yml` for
Python, or a filter in `.github/workflows/typescript-verify.yml` for TypeScript, a root
`Makefile` target, a `CODEOWNERS` line, a row in the table in [`README.md`](README.md),
and a component `README.md` at `sinks/<target>/` indexing the languages.

## Data handling

A sink is the last component to touch a record before it leaves the trust boundary, and
nothing downstream re-checks it. The README of every sink restates, at the point where a
reader configures it, that `attribution.labels` MUST NOT contain PII and that
`resource.key_name` is a label, never key material, and links to
[`SECURITY.md`](../SECURITY.md) for the full rules.

## Before opening a pull request

`make verify` passes in the package. Every code block in the README has been executed. The
README contains no version number.
