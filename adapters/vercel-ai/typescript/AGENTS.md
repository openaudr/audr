# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this adapter into an application, see [`README.md`](README.md); this file
covers changes to the package itself.

## What this is

`adapters/vercel-ai/typescript` is the `@openaudr/audr-adapter-vercel-ai` npm package: a Vercel
AI SDK 7 `Telemetry` integration that turns provider model calls, client-side tool
executions, embedding calls and rerank calls into attributed `AUDR` records for an
`@openaudr/audr` `Client` the host application owns.

## Layout

| Path | Owns |
| --- | --- |
| `src/index.ts` | The public exports, pinned by `tests/public-api.test.ts` |
| `src/telemetry.ts` | `audrTelemetry`, option validation, and every `Telemetry` hook |
| `src/attribution.ts` | The `runtimeContext.audr` reader and the merge over defaults |
| `src/runs.ts` | `CallTracker`, the one module-level `AsyncLocalStorage` of active tool spans each tracker filters by owner, per-call state and unique tool span allocation |
| `src/mapping.ts` | Pure functions: token arithmetic, provider slugs, span ids, run type, supported operations |
| `src/diagnostics.ts` | `DiagnosticCode`, the message format, `errorName`, the silent default logger |
| `docs/reference.md` | The full reference: options, record fields, provider slugs, diagnostics, bounds |
| `tests/` | The Vitest suite |
| `examples/` | Runnable examples on mock models; no credentials or network calls |

## Rules

1. `ai` is a peer dependency. Import only its types (`import type`); ESLint
   rejects a value import in `src/`, and `tests/public-api.test.ts` checks the emitted
   JavaScript. The only Node API is `AsyncLocalStorage`, imported in `src/runs.ts` alone
   and instantiated once per process: under Node 22 every instance that has ever run stays
   registered and slows every async operation, so never create one per integration.
2. Read no payloads. Never read prompts, instructions, messages, content, provider
   metadata, tool inputs, tool outputs, tool errors, embeddings, documents, queries or
   rankings. From a tool's result read only the `toolOutput.type` discriminator.
   `tests/privacy.test.ts` plants a sentinel in every payload position.
3. Resolve attribution once, at `onStart`, and never change the snapshot afterwards. An
   operation without a resolved `environment` is skipped with `ATTRIBUTION_UNRESOLVED`. An
   operation started inside a tracked tool's `execute` inherits the parent's attribution,
   `run_id` and step counter and ignores its own `runtimeContext`.
4. A call is tracked from `onStart` until `onEnd`, `onAbort` or `onError`. An event for a
   `callId` that is not tracked produces no record and no log line; it is never
   re-attributed to defaults.
5. Every hook body runs inside `#guard` and never throws into the AI SDK. `executeTool`
   returns exactly what `execute` returns and never catches its rejection: the AI SDK
   turns that rejection into the tool's `tool-error` result. The constructor's `client`
   check is the only place the package throws.
6. Diagnostics go through `Diagnostics` with a `DiagnosticCode` and the fixed field set in
   `src/diagnostics.ts`. Add a code for every new diagnostic. The `operation` field is
   always the AI SDK `operationId`. Never log a record value, an id, a model name, a tool
   name or an error message; error class names only. A new code gets a row in the
   diagnostics table of `docs/reference.md`.
7. A behaviour change updates its one home: `README.md` for installation, usage and
   attribution, `docs/reference.md` for everything else. Neither repeats the other.
8. Never write `cost`, `run.outcome`, `run.trace_id`, `emitter` or `totalTokens`.
   `input_tokens` excludes cache reads and writes; `output_tokens` excludes reasoning.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Peer dependencies:** `ai` and `@openaudr/audr`, both also development dependencies
  from npm. The dev dependency on `ai` is pinned exactly to the floor of the `ai` peer
  range, so CI runs the suite against the oldest release the package claims to support.
  Raise the two together, and only when the adapter needs a newer `ai`. The floor is where
  `embed`, `embedMany` and `rerank` gained `runtimeContext`; earlier 7.x releases drop
  per-call attribution on those calls.
- **Version:** `package.json` and `src/version.ts`; `tests/public-api.test.ts` keeps them
  equal.

```bash
make install     # npm ci
make lint        # eslint, prettier --check and tsc --noEmit
make test        # vitest with the 90% coverage gate
make examples    # build, then run every example against dist/
make isolation   # build, then publint --strict and attw
make verify      # lint + test + examples + isolation
```

`make isolation` does not run the core's `scripts/verify-package.ts`: this package's peer
dependencies are intended.
