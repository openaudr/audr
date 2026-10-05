# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this adapter into an application, see [`README.md`](README.md); this file
covers changes to the package itself. The adapter is tracked in
[openaudr/audr#50](https://github.com/openaudr/audr/issues/50).

## What this is

`adapters/openrouter/typescript` is the `@openaudr/audr-adapter-openrouter` npm package: a
non-mutating facade over an `@openrouter/sdk` `OpenRouter` that turns every `chat.send()`,
`responses.send()` (both streaming or not) and `embeddings.generate()` into an attributed
AUDR record for an `@openaudr/audr` `Client` the host application owns, plus `withAudr()`,
which scopes attribution and an optional host run over every call an instrumented client
makes.

Keep public exports covered by `tests/public-api.test.ts`. Tests and examples must run
without credentials or network access; stub `fetch` for SDK calls.

## Rules

1. `@openrouter/sdk` is a peer dependency. Import only its types (`import type`); ESLint
   rejects a value import in `src/`, and `tests/public-api.test.ts` checks the emitted
   JavaScript. The only Node API is `AsyncLocalStorage`, imported in `src/attribution.ts`
   alone and instantiated once per process: under Node 22 every instance that has ever run
   stays registered and slows every async operation, so never create another.
2. Never modify the native client, its resources or its streams. Wrap them in a `Proxy`
   (`forward()` in `src/proxy.ts`) that overrides only what is metered and forwards
   everything else bound to the target. A metered method passes every argument to the
   native method unchanged.
3. Read no payloads. The fields the adapter reads are listed in the Privacy section of
   `docs/reference.md`; `tests/privacy.test.ts` plants a sentinel in every other position
   and records every property the adapter reads. Never read a message, prompt, completion,
   tool, embedding vector, `user`, `sessionId`, `metadata` or an error. A new read needs the
   documentation and the test updated together.
4. Attribution comes from `attributionDefaults` (copied when instrumenting) under the
   innermost `withAudr` scope, merged by `mergeAttribution`, which copies only AUDR's
   attribution fields. Scopes are process-wide. Attribution and the run are resolved once
   when a native call starts and never changed afterwards. A call without a resolved
   `environment` is not metered and logs `ATTRIBUTION_UNRESOLVED`. `withAudr` propagates
   only what its body throws: a context it cannot read is ignored.
5. Never change, delay beyond the lookup budget, or fail a native call. A native rejection
   propagates untouched and is never logged; every metering step after the call, including
   stream inspection, is guarded. `instrumentOpenRouter` throws only when `client` has no
   `record()` or an `openrouter` is already a facade, which would record every call twice.
   Other options use their TypeScript types as the contract.
6. Leave value validation to the `Client`. Do not re-check what `Client.record()` already
   validates (types, ranges, the provider slug, id lengths); a record it rejects is
   reported as `RECORD_NOT_QUEUED` with each issue as `<code>@<path>`. The adapter checks
   only what it needs to build a record at all: an `environment` and a model name
   (`MODEL_UNREPORTED`).
7. The vendor comes from router metadata first, then from `generations.getGeneration()`
   through the host's own client (`src/lookup.ts`), and only for an id that matches
   `getGeneration`'s `gen-` pattern. The lookup retries a `404`, `408`, `429`, `5xx` and a
   failure with no status, within `lookup.maxWaitMs`, and stops at once on anything else.
   Every attempt passes `retries: { strategy: 'none' }`: the SDK's default policy retries
   the budget's own timeout for up to an hour. It reads `providerName`,
   `responseCacheSourceId`, `isByok` and `upstreamInferenceCost` only. Slugs are made
   mechanically (`Amazon Bedrock` becomes `amazon-bedrock`); do not add an alias table.
   A vendor that stays unknown is recorded as `openrouter` with `PROVIDER_UNRESOLVED`,
   never inferred from the model author, and never a reason to drop the record.
8. Record a stream only from its terminal frame (Chat: the chunk with `usage`; Responses:
   `response.completed`, `.failed` or `.incomplete`), before yielding it, and report any
   other ending once as `STREAM_INCOMPLETE` with its `reason`. Only async iteration is
   metered.
9. Diagnostics go through `Diagnostics` with a `DiagnosticCode` and the fixed field set in
   `src/diagnostics.ts`. Add a code for every new diagnostic. Never log a record value, an
   id, a model name, a vendor name, a mutable error name or an error message; fixed error
   categories only.
10. `emitter` is always the adapter as a `router`. `input_tokens` excludes cache reads and
    writes, which OpenRouter's prompt count includes, and `output_tokens` excludes
    reasoning; `total_tokens` is never copied. `cost` is `total_cost` in `USD`: `usage.cost`
    for a call that is not BYOK; for BYOK `usage.cost` plus the provider's charge, and no
    cost (with `BYOK_COST_INCOMPLETE`) when either part or the BYOK status is unknown.
    `serverToolCost` is never added. Never write `run.step`, `run.trace_id` or
    `run.outcome`.
11. A behaviour change updates its one home: `README.md` for installation, usage and
    attribution, `docs/reference.md` for everything else. Neither repeats the other's
    detail.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Peer dependencies:** `@openrouter/sdk` and `@openaudr/audr`, both also development
  dependencies. npm installs the runtime and links `@openaudr/audr` from the local
  workspace. The dev dependency on `@openrouter/sdk` is pinned exactly to the floor of the
  peer range, so CI runs the suite against the oldest release the package claims to
  support. Raise the two together.
- **Version:** `package.json` and `src/version.ts`; `tests/public-api.test.ts` keeps them
  equal.
- **Examples** share `examples/stand-in.ts`, which replaces `fetch`. The package's
  `tsconfig.json` allows importing `.ts` files for them; `tsconfig.build.json` turns that
  off.

```bash
make install     # install every TypeScript package from the root lockfile, then build the core
make lint        # eslint, prettier --check and tsc --noEmit
make test        # vitest with the 90% coverage gate
make examples    # build, then run every example against dist/
make isolation   # build, publint --strict and attw, then tools/verify-npm-package.mjs
make verify      # lint + test + examples + isolation
```

`tools/verify-npm-package.mjs` installs the packed adapter and core with the OpenRouter SDK
into an empty project and runs `scripts/package-smoke.mjs`, which meters one call. It does
not require an exact installed set, because this package's peer dependencies are intended.
