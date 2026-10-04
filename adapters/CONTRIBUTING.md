# Contributing an adapter

An adapter observes an agent runtime and turns its events into AUDR records, which it hands
to a `Client` from the core SDK. [`README.md`](README.md) defines the kind; this document
describes how to propose and build one. Repository-wide process — issues, pull requests,
naming, the shared Python toolchain, licensing — is in the top-level
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Before writing code

Open an issue describing the runtime, the events it exposes, and the record shape each
event maps to. The record shape and the runtime hook are agreed before code is written,
because both are hard to change once a package is published.

An adapter maintained outside this repository is welcome too. Open an issue and it will be
linked from [`README.md`](README.md).

## What an adapter does

- **Observes one runtime** through that runtime's own extension mechanism — a plugin, a
  callback, a middleware — and builds one `AUDR` record per metered operation.
- **Hands every record to `client.record()`** on a `Client` the host application owns. The
  host constructs the client and its sink and controls startup and shutdown; the adapter
  never creates a sink and never talks to a destination.
- **Resolves attribution** from the runtime's own context — a scope, a request, a session —
  and applies the host's configured defaults where the runtime carries none. A record that
  cannot be attributed is skipped, with a value-free warning, rather than billed to a guess.
- **Mints identifiers the standard requires.** `record_id` is minted fresh by the SDK; the
  runtime's own identifiers are carried on `run.run_id` and `run.span_id`.
- **Reads no payloads.** Prompts, completions, tool arguments and tool results are never
  read, and never appear in a record, a log or an exception.

The [NeMo Relay adapter](nemo-relay/python/README.md) is the reference for all five.

## Python specifics

`client.record()` is synchronous and non-blocking, and must be called on the event loop that
owns the client. Runtimes commonly fire callbacks on their own worker threads, so an adapter
for such a runtime:

- captures the client's running loop at construction, or accepts `loop=` explicitly;
- hands each record across with `loop.call_soon_threadsafe(...)`, bounding the number of
  pending handoffs and dropping with a warning on overflow rather than blocking the
  runtime;
- exposes a `drain()` the host awaits after the runtime has stopped producing work and
  before `client.shutdown()`, so every accepted handoff reaches `client.record()`.

`adapters/nemo-relay/python/src/audr_adapter_nemo_relay/_bridge.py` implements this
pattern. Shutdown order matters: stop producing, exit the runtime's context, drain the
adapter, then shut down the client.

The runtime itself is an optional dependency, installed through an extra, and imported at
activation rather than at import of the adapter package, so that installing the adapter
does not pull the runtime into processes that do not use it.

## TypeScript specifics

`client.record()` is synchronous, never throws, and runs on the single event loop the
runtime's callbacks already run on, so a TypeScript adapter needs no cross-thread handoff
and no `drain()`. Each hook submits its record before it returns. The host's shutdown
order is: stop starting runtime calls, await the ones in flight, then
`await client.shutdown()`.

The runtime and `@openaudr/audr` are peer dependencies, so the adapter uses the
application's own copies, and the adapter imports only the runtime's types. Enforce the
type-only rule with ESLint's `@typescript-eslint/no-restricted-imports` and
`allowTypeImports`. Declare both as development dependencies. npm installs the runtime
and links `@openaudr/audr` from the local workspace. The
[Vercel AI adapter](vercel-ai/typescript/AGENTS.md) implements all of this.

## What a new adapter ships

Directory `adapters/<target>/<language>/`. A Python distribution is `audr-adapter-<target>`
with the import package `audr_adapter_<target>`; a TypeScript package is
`@openaudr/audr-adapter-<target>`. The [naming rules](../CONTRIBUTING.md#naming) apply to
both. A Python package contains:

| Path | Purpose |
| --- | --- |
| `pyproject.toml`, `uv.lock` | Build metadata and locked environment, on the shared toolchain |
| `Makefile` | `install`, `lint`, `test`, `build`, `verify` |
| `src/audr_adapter_<target>/` | The package, with `_version.py` as the single version source and `py.typed` |
| `tests/` | The suite, at 90% coverage or above, with runtime-dependent tests behind a pytest marker |
| `README.md` | The PyPI long description: install, activate, attribute, shut down; absolute URLs only |
| `AGENTS.md` | How to work inside this package |
| `CHANGELOG.md`, `LICENSE`, `NOTICE` | Release history and licensing |

A TypeScript package contains the same `tests/`, `README.md` (the npm page), `AGENTS.md`,
`CHANGELOG.md`, `LICENSE` and `NOTICE`, and in place of the Python build files:

| Path | Purpose |
| --- | --- |
| `package.json` | Package metadata, on the shared toolchain; dependencies are locked in the repository's root `package-lock.json` |
| `Makefile` | `install`, `lint`, `test`, `build`, `examples`, `isolation`, `verify` |
| `src/`, with `src/version.ts` | The package; `tests/public-api.test.ts` pins its exports and keeps the version equal to `package.json` |
| `examples/` | Runnable examples on mock models, run by `make examples` |
| `scripts/package-smoke.mjs` | The smoke test `make isolation` runs against the installed tarball, through `tools/verify-npm-package.mjs` |

Outside the package: a workflow `.github/workflows/adapter-<target>-python-verify.yml` for
Python, or a filter in `.github/workflows/typescript-verify.yml` for TypeScript, a root
`Makefile` target, a `CODEOWNERS` line, a row in the table in [`README.md`](README.md),
and a component `README.md` at `adapters/<target>/` indexing the languages.

## Before opening a pull request

`make verify` passes in the package. Every code block in the README has been executed. The
README contains no version number.
