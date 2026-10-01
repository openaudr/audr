# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this adapter into an application, see [`README.md`](README.md); this file
covers changes to the package itself.

## What this is

`adapters/mastra/typescript` is the `@openaudr/audr-adapter-mastra` npm package: a Mastra
`ObservabilityExporter` that turns ended `model_generation`, `tool_call` and `mcp_tool_call`
spans into attributed AUDR records for an `@openaudr/audr` `Client` the host application
owns.

## Layout

| Path | Owns |
| --- | --- |
| `src/index.ts` | The public exports, pinned by `tests/public-api.test.ts` |
| `src/exporter.ts` | `AudrExporter`, lifecycle, span handling and `client.record()` |
| `src/attribution.ts` | The `metadata.audr` reader and the merge over defaults |
| `src/mapping.ts` | Token arithmetic, provider slugs, timing helpers, error codes |
| `src/diagnostics.ts` | `DiagnosticCode`, the message format, `errorName`, the silent default logger |
| `docs/reference.md` | The full reference: options, record fields, provider slugs, diagnostics, bounds |
| `tests/` | The Vitest suite |
| `examples/` | Runnable examples on mock models; no credentials or network calls |

## Rules

1. `@mastra/*` packages are peer dependencies. Import only their types (`import type`); ESLint
   rejects a value import in `src/`, and `tests/public-api.test.ts` checks the emitted
   JavaScript. This package imports no `node:` modules in `src/`.
2. Meter only `model_generation`, `tool_call` and `mcp_tool_call` on `span_ended`. Ignore
   `model_step`, `model_chunk` and every other span type so usage is not double-counted.
3. Read no payloads. Never read prompts, instructions, messages, content, tool inputs, tool
   outputs or error messages. `tests/privacy.test.ts` plants a sentinel in every payload
   position.
4. Resolve attribution per span from `metadata.audr` merged over `attributionDefaults`. A span
   without a resolved `environment` is skipped with `ATTRIBUTION_UNRESOLVED`.
5. Never create a `Client` or a sink. `shutdown()` on the exporter does not shut down the
   client; `flush()` delegates to `client.flush()`.
6. Diagnostics go through `Diagnostics` with a `DiagnosticCode` and the fixed field set in
   `src/diagnostics.ts`. Add a code for every new diagnostic. Never log a record value, an id,
   a model name, a tool name or an error message; error class names only.
7. Never write `requests`, `cost` or `totalTokens`. `input_tokens` excludes cache reads and
   writes; `output_tokens` excludes reasoning.
8. A behaviour change updates its one home: `README.md` for installation, usage and
   attribution, `docs/reference.md` for everything else. Neither repeats the other's
   detail. A new diagnostic code gets a row in the diagnostics table of `docs/reference.md`.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Peer dependencies:** `@mastra/core`, `@mastra/observability` and `@openaudr/audr`, each
  also a development dependency pinned to the lowest supported release. The
  `@mastra/observability` floor is the first release that emits `span_ended` once per span
  and stops re-adding Anthropic cache tokens to `inputTokens`; the `@mastra/core` floor is the
  release that one was built against. Raise them together.
- **`ai` is a dev dependency only**, for the mock models in `ai/test`.
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
