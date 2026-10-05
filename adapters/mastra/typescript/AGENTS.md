# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this adapter into an application, see [`README.md`](README.md); this file
covers changes to the package itself.

## What this is

`adapters/mastra/typescript` is the `@openaudr/audr-adapter-mastra` npm package: a Mastra
`ObservabilityExporter` that turns ended `model_inference`, `rag_embedding`, `tool_call`
and `mcp_tool_call` spans into attributed AUDR records for an `@openaudr/audr` `Client` the
host application owns.

Keep public exports covered by `tests/public-api.test.ts`. Examples must use mock models and
run without credentials or network access.

## Rules

1. `@mastra/*` packages are peer dependencies. Import only their types (`import type`); ESLint
   rejects a value import in `src/`, and `tests/public-api.test.ts` checks the emitted
   JavaScript. This package imports no `node:` modules in `src/`.
2. Meter only `model_inference`, `rag_embedding`, `tool_call` and `mcp_tool_call` on
   `span_ended`. Ignore `model_generation`, `model_step`, `model_chunk` and every other
   span type so usage is not double-counted. A `tool_call` with a direct `agent_run` or
   `workflow_run` child is a Mastra delegation and is not separate tool usage.
3. Read no payloads. Never read prompts, instructions, messages, content, tool inputs, tool
   outputs or error messages. `tests/privacy.test.ts` plants a sentinel in every payload
   position.
4. Resolve attribution per span from `metadata.audr` merged over `attributionDefaults`. A span
   without a resolved `environment` is skipped with `ATTRIBUTION_UNRESOLVED`.
5. Never create a `Client` or a sink. `shutdown()` on the exporter does not shut down the
   client; `flush()` delegates to `client.flush()`.
6. Diagnostics go through `Diagnostics` with a `DiagnosticCode` and the fixed field set in
   `src/diagnostics.ts`. Add a code for every new diagnostic. Never log a record value, an id,
   a model name, a tool name or an error message; error class names only. A new code gets a
   row in the diagnostics table of `docs/reference.md`.
7. Write `requests: 1` for each model inference and embedding call. Never write `cost` or
   `totalTokens`. `input_tokens` excludes cache reads and writes; `output_tokens` excludes
   reasoning.
8. A behaviour change updates its one home: `README.md` for installation, usage and
   attribution, `docs/reference.md` for everything else. Neither repeats the other.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Peer dependencies:** `@mastra/core`, `@mastra/observability` and `@openaudr/audr`, each
  also a development dependency pinned to the lowest supported release. Raise the ranges
  and pins together.
- **`ai` is a dev dependency only**, for the mock models in `ai/test`.
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

`tools/verify-npm-package.mjs` installs the packed adapter and core with Mastra into an
empty project and runs `scripts/package-smoke.mjs`, which meters one call. It does not
require an exact installed set, because this package's peer dependencies are intended.
