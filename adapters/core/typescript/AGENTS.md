# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To emit records from an application, see [`README.md`](README.md); this file covers
changes to the package itself.

## What this is

`adapters/core/typescript` is the `audr` npm package: the TypeScript implementation of the
Agent Usage Detail Record (AUDR) standard, behaviourally equivalent to the Python
reference in [`../python/`](../python/). It is destination-neutral: a sink plugs into this
package, never the reverse, and this package must not depend on a particular destination
or runtime.

## Layout

| Path | Owns |
| --- | --- |
| `src/schema.ts` | The vocabularies (`as const` arrays) and the Zod schemas transcribed from the JSON Schema (`SHAPES`) |
| `src/record.ts` | The record types, inferred from `src/schema.ts`, and `createRecord` |
| `src/validate.ts` | Zod issues mapped to AUDR issues, and the cross-field rules |
| `src/codec.ts`, `src/errors.ts` | `parseRecord` / `decodeRecord` / `encodeRecord`, error codes and error classes |
| `src/sink.ts` | The sink contract: `Sink`, `BatchResult`, `RejectedRecord` |
| `src/client.ts`, `src/pipeline.ts`, `src/results.ts` | The bounded, batching delivery pipeline behind `Client` |
| `src/file-sink.ts` | `FileSink`, exported from `audr/file` (the only `node:fs` import) |
| `src/testing.ts` | `MemorySink`, `makeRecord`, `assertSinkContract`, exported from `audr/testing` |
| `tests/` | The Vitest suite, including `conformance.test.ts` and the schema drift check `schema.test.ts` |
| `examples/` | Runnable examples; no credentials or network calls required |
| `scripts/verify-package.ts` | The isolation check `make isolation` runs against the packed tarball |
| `../../../spec/`, `../../../conformance/` | The schema and shared fixtures the tests read; not packaged |

## Rules

1. `src/index.ts`, `src/file-sink.ts` and `src/testing.ts` are the three entry points
   (`audr`, `audr/file`, `audr/testing`), and `tests/public-api.test.ts` pins their
   runtime exports. Adding an export is a public API change; make it deliberately and
   update the test. Keep the surface small.
2. Runtime dependencies are `zod` (imported only as `zod/mini`) and `uuid`, neither with
   dependencies of its own. Add another only by agreement. The root entry point imports
   nothing from `node:` so it runs in any modern JavaScript runtime. Node-only code lives
   behind a subpath export; ESLint rejects `node:` imports and Node globals elsewhere in
   `src/`. `make isolation` packs the tarball and checks that it installs exactly the
   declared dependencies and loads through both `import` and `require`.
3. Records are plain objects in the wire format (snake_case). API options and results are
   camelCase. Do not add record classes or a mapping layer.
4. `record()` is the only entry point to the delivery pipeline. It is synchronous, never
   throws, queues its own copy of the record, and returns a `SubmitResult`. A change that lets a caller await the delivery of
   a single record requires an agreed issue first.
5. Every record admitted through `record()` ends in exactly one terminal state: `sent`,
   `dropped` or `unknown`. The states are defined in
   [`../README.md`](../README.md#delivery-states). `unknown` is terminal; never relabel it.
6. The Zod schemas in `src/schema.ts` mirror `spec/audr.schema.json` by hand, and every
   Zod error they raise is an `ErrorCode`. `tests/schema.test.ts` fails when a property,
   required list, vocabulary, or length or numeric bound drifts, and the conformance
   fixtures must all pass. String lengths count code points, as JSON Schema does. Do not
   package the JSON Schema.
7. Diagnostics carry field names and JSON-pointer paths, never values. `ValidationIssue`
   carries a code and a path, and log lines carry error class names, never messages.
8. `Sink` is a structural interface. A third-party sink imports `BatchResult` and
   implements `deliver` and `close`; it extends nothing.
9. `shutdown()` closes the sink, including one the caller supplied. `ownsSink: false` opts
   out for a sink that outlives the client.
10. Exhaustive `switch` statements over unions end in a `never` check, so a new variant
    fails to compile until it is handled.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). The version lives
in `package.json` and `src/version.ts`; `tests/public-api.test.ts` keeps them equal.
Targets beyond the shared `install / lint / test / build`:

```bash
make format        # prettier --write
make typecheck     # tsc --noEmit over src, tests, examples and scripts
make conformance   # the shared fixtures only (tests/conformance.test.ts)
make examples      # build, then run every example against dist/
make isolation     # build, lint the package metadata, verify the tarball installs cleanly
make verify        # lint + test + examples + isolation
```
