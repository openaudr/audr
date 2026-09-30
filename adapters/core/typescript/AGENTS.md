# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To emit records from an application, see [`README.md`](README.md); this file covers
changes to the package itself.

## What this is

`adapters/core/typescript` is the `@openaudr/audr` npm package: the TypeScript implementation of the
Agent Usage Detail Record (AUDR) standard, behaviourally equivalent to the Python
reference in [`../python/`](../python/). It is destination-neutral: a sink plugs into this
package, never the reverse, and this package must not depend on a particular destination
or runtime.

## Layout

| Path | Owns |
| --- | --- |
| `src/generated-schema.ts` | Generated: the record types, rendered by quicktype, and `SPEC_VERSION` |
| `src/generated-validator.ts` | Generated: the JSON Schema compiled by Ajv into standalone code |
| `src/record.ts` | `AudrRecord`, `RecordInput` and `createRecord`, over the generated types |
| `src/validate.ts` | Schema failures mapped to AUDR error codes, and the rules the specification states only in prose |
| `src/codec.ts`, `src/errors.ts` | `parseRecord` / `decodeRecord` / `encodeRecord`, error codes and error classes |
| `src/sink.ts` | The sink contract: `Sink`, `BatchResult`, `RejectedRecord` |
| `src/client.ts`, `src/pipeline.ts`, `src/results.ts` | The bounded, batching delivery pipeline behind `Client` |
| `src/file-sink.ts` | `FileSink`, exported from `audr/file` (the only `node:fs` import) |
| `src/testing.ts` | `MemorySink`, `makeRecord`, `assertSinkContract`, exported from `audr/testing` |
| `tests/` | The Vitest suite, including `conformance.test.ts` and `schema.test.ts`, which holds the generated validator's bounds and the generated types to the schema |
| `examples/` | Runnable examples; no credentials or network calls required |
| `scripts/gen-schema.ts` | Generates `src/generated-schema.ts` and `src/generated-validator.ts` from the spec |
| `scripts/verify-package.ts` | The isolation check `make isolation` runs against the packed tarball |
| `../../../spec/`, `../../../conformance/` | The schema and shared fixtures the tests read; not packaged |

## Rules

1. `src/index.ts`, `src/file-sink.ts` and `src/testing.ts` are the three entry points
   (`@openaudr/audr`, `@openaudr/audr/file`, `@openaudr/audr/testing`), and `tests/public-api.test.ts` pins their
   runtime exports. Adding an export is a public API change; make it deliberately and
   update the test. Keep the surface small.
2. The one runtime dependency is `uuid`, which has none of its own. Add another only by
   agreement; Ajv and quicktype are development dependencies and stay so. The root entry
   point imports nothing from `node:` so it runs in any modern JavaScript runtime.
   Node-only code lives behind a subpath export; ESLint rejects `node:` imports and Node
   globals elsewhere in `src/`. `make isolation` packs the tarball and checks that it
   installs exactly the declared dependencies and loads through both `import` and
   `require`.
3. Records are plain objects in the wire format (snake_case). API options and results are
   camelCase. Do not add record classes or a mapping layer.
4. `record()` is the only entry point to the delivery pipeline. It is synchronous, never
   throws, queues its own copy of the record, and returns a `SubmitResult`. A change that
   lets a caller await the delivery of a single record requires an agreed issue first.
5. Every record admitted through `record()` ends in exactly one terminal state: `sent`,
   `dropped` or `unknown`. The states are defined in
   [`../README.md`](../README.md#delivery-states). `unknown` is terminal; never relabel it.
6. `src/generated-schema.ts` and `src/generated-validator.ts` are generated. Do not edit
   them by hand. Edit `scripts/gen-schema.ts`, or `spec/` if the schema itself is wrong,
   then run `make schema`. `make schema-check` fails CI when either file drifts. quicktype
   renders the types; it drops `patternProperties`, so `gen-schema.ts` adds each `x_*`
   index signature itself. The validator enforces the conditional rules; the types do not.
   The schema's prose is stripped before compiling, so it is never packaged.
   `src/validate.ts` maps each schema failure to an AUDR error code by its keyword
   (`codeFor`), with the field-specific exceptions in `FIELD_CODES`, and holds the rules the
   specification states only in prose. A schema keyword `codeFor` does not know reports
   `INVALID_STRUCTURE`, so a new keyword in the spec needs a case there. The conformance
   fixtures must all pass.
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
make schema        # regenerate src/generated-*.ts from spec/
make schema-check  # fail if the generated files drift from spec/
make conformance   # the shared fixtures only (tests/conformance.test.ts)
make examples      # build, then run every example against dist/
make isolation     # build, lint the package metadata, verify the tarball installs cleanly
make verify        # lint + schema-check + test + examples + isolation
```
