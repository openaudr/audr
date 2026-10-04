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

Keep public exports covered by `tests/public-api.test.ts`. Examples must use mock
models and run without credentials or network access.

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

- **Peer dependencies:** `ai` and `@openaudr/audr`, both also development dependencies.
  npm installs the runtime and links `@openaudr/audr` from the local workspace.
  The dev dependency on `ai` is pinned exactly to the floor of the `ai` peer
  range, so CI runs the suite against the oldest release the package claims to support.
  Raise the two together, and only when the adapter needs a newer `ai`. The floor is where
  `embed`, `embedMany` and `rerank` gained `runtimeContext`; earlier 7.x releases drop
  per-call attribution on those calls.
- **Version:** `package.json` and `src/version.ts`; `tests/public-api.test.ts` keeps them
  equal.

```bash
make install     # install every TypeScript package from the root lockfile, then build the core
make lint        # eslint, prettier --check and tsc --noEmit
make test        # vitest with the 90% coverage gate
make examples    # build, then run every example against dist/
make isolation   # build, publint --strict and attw, then tools/verify-npm-package.mjs
make verify      # lint + test + examples + isolation
```

`tools/verify-npm-package.mjs` installs the packed adapter and core with the AI SDK into an
empty project and runs `scripts/package-smoke.mjs`, which meters one call. It does not
require an exact installed set, because this package's peer dependencies are intended.
