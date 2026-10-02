# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this adapter into an application, see [`README.md`](README.md); this file
covers changes to the package itself. The adapter is tracked in
[openaudr/audr#20](https://github.com/openaudr/audr/issues/20).

## What this is

`adapters/merge-gateway/typescript` is the `@openaudr/audr-adapter-merge-gateway` npm package: a
non-mutating facade over a `merge-gateway-sdk` `MergeGateway` that turns every
`responses.create()` (streaming or not) and `embeddings.create()` into an attributed AUDR
record for an `@openaudr/audr` `Client` the host application owns, plus `withAudr()`, which
scopes attribution and an optional host run over every call an instrumented client makes.

## Layout

| Path | Owns |
| --- | --- |
| `src/index.ts` | The public exports, pinned by `tests/public-api.test.ts` |
| `src/gateway.ts` | `instrumentMergeGateway`, the `Proxy` facade, requested modality, the metered stream and record building |
| `src/attribution.ts` | `withAudr`, scope nesting, the attribution merge and the one process-wide `AsyncLocalStorage` |
| `src/mapping.ts` | `GatewayResult`, the only response fields the adapter reads, and pure functions over it: token arithmetic, cost, run id length |
| `src/diagnostics.ts` | `DiagnosticCode`, value-free formatting and fixed error categories |
| `docs/reference.md` | The full reference: options, agent runs, Merge tracing, streams, record fields, diagnostics, bounds |
| `tests/` | The Vitest suite, run against the real SDK with `fetch` stubbed; one file per behaviour area, named for it |
| `examples/` | Runnable examples with `fetch` answered locally; no credentials or network calls |

## Rules

1. `merge-gateway-sdk` is a peer dependency. Import only its types
   (`import type`); ESLint rejects a value import in `src/`, and `tests/public-api.test.ts`
   checks the emitted JavaScript. The only Node API is `AsyncLocalStorage`, imported in
   `src/attribution.ts` alone and instantiated once per process: under Node 22 every instance
   that has ever run stays registered and slows every async operation, so never create
   another.
2. Never modify the native client, its resources or its streams. Wrap them in a `Proxy`
   that overrides only what is metered and forwards everything else bound to the target.
   A metered `create()` passes every argument to the native method unchanged.
3. Read no payloads. From a response or stream frame read only the fields `GatewayResult`
   declares: `id`, `object`, `model`, `vendor`, `status` and `usage`. From request parameters
   read only `modalities`, which determines `resource.modality`; a stream is recognised by
   the result being async-iterable. Never read `input`, `output`, `tools`, `tags`, `customer`,
   `project_id`, `session_id`, `routing`, `guardrails`, `warnings` or an error.
   `tests/privacy.test.ts` plants a sentinel in every payload position.
4. Attribution comes from `attributionDefaults` (copied when instrumenting) under the
   innermost `withAudr` scope, merged by `mergeAttribution`, which copies only AUDR's
   attribution fields. Scopes are process-wide: one applies to every instrumented client,
   so a per-run client created inside it is covered. Attribution and the run are resolved
   once when a native call starts and never changed afterwards. A call without a resolved
   `environment` is not metered and logs `ATTRIBUTION_UNRESOLVED`. `withAudr` propagates
   only what its body throws: a context it cannot read is ignored.
5. Never change, delay or fail a native call. A native rejection propagates untouched and
   is never logged; every metering step after the call, including stream-shape inspection,
   is guarded. `instrumentMergeGateway` throws only when `client` has no `record()` or a
   gateway is already a facade, which would record every call twice. Other options use their
   TypeScript types as the contract.
6. Leave value validation to the `Client`. Do not re-check what `Client.record()` already
   validates (types, ranges, the provider slug, id lengths); a record it rejects is
   reported as `RECORD_NOT_QUEUED` with each issue as `<code>@<path>`. The adapter checks
   only what it needs to build a record at all: an `environment`, and a model name
   (`MODEL_UNREPORTED`).
7. Record a stream only from its `response.done` frame, before yielding it, and report any
   other ending once as `STREAM_INCOMPLETE` with its `reason`.
8. Diagnostics go through `Diagnostics` with a `DiagnosticCode` and the fixed field set in
   `src/diagnostics.ts`. Add a code for every new diagnostic. Never log a record value, an
   id, a model name, a mutable error name or an error message; fixed error categories only.
9. `emitter` is always the adapter as a `router`. `cost` is `total_cost` in `USD` from
   `usage.cost` only, never a `cost.llm` breakdown. `input_tokens` excludes cache reads and
   writes; `output_tokens` excludes reasoning. A `null` cache-read counter omits
   `input_tokens`, because the schema requires it to exclude cache reads. A `null`
   cache-write counter keeps those tokens in `input_tokens`, because Gateway bills
   unreported writes at the input rate. A `null` reasoning counter leaves
   `output_tokens` whole, because the schema excludes reasoning only when `reasoning_tokens`
   is present. `resource.modality` comes from requested `modalities`, defaulting to `text`.
   Never write `total_tokens`, `run.outcome` (the harness owns it), `run.trace_id` (it is a
   W3C trace id, which `X-Merge-Trace-Id` is not) or `run.step` (a call's position is
   undefined across scopes, processes and concurrent calls).
10. A behaviour change updates its one home: `README.md` for installation, usage and
    attribution, `docs/reference.md` for everything else. Neither repeats the other's
    detail.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Peer dependencies:** `merge-gateway-sdk` and `@openaudr/audr`, both also development
  dependencies from npm. The dev dependency on `merge-gateway-sdk` is pinned exactly to the
  floor of the peer range, so CI runs the suite against the oldest release the package
  claims to support. Raise the two together. The 0.4 type declarations omit fields Gateway
  returns (`usage.cost`, the cache and reasoning counters, `vendor`), so `GatewayResult` in
  `src/mapping.ts` declares the documented shape.
- **Version:** `package.json` and `src/version.ts`; `tests/public-api.test.ts` keeps them
  equal.

```bash
make install     # install dependencies from the lockfile
make lint        # eslint, prettier --check and tsc --noEmit
make test        # vitest with the 90% coverage gate
make examples    # build, then run every example against dist/
make isolation   # build, then publint --strict and attw
make verify      # lint + test + examples + isolation
```

`make isolation` does not run the core's `scripts/verify-package.ts`: this package's peer
dependencies are intended.
