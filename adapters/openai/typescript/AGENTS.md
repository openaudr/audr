# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this adapter into an application, see [`README.md`](README.md); this file
covers changes to the package itself.

## What this is

`adapters/openai/typescript` is the `@openaudr/audr-adapter-openai` npm package: a
non-mutating facade over an `openai` client that turns every `chat.completions.create()` and
`responses.create()` (streaming or not) and `embeddings.create()` into an attributed AUDR
record for an `@openaudr/audr` `Client` the host application owns, plus `withAudr()`, which
scopes attribution and an optional host run over every call an instrumented client makes.
The provider is read from the client's `baseURL`, so the package serves every
OpenAI-compatible endpoint, not OpenAI alone.

Keep public exports covered by `tests/public-api.test.ts`. Tests and examples must run
without credentials or network access; stub `fetch` for SDK calls.

## Rules

1. `openai` is a peer dependency. `src/` imports nothing from it, not even types: the
   client is matched structurally by `OpenAILike`, so the adapter is independent of the SDK's
   type declarations across its supported majors. ESLint rejects a value import in `src/`,
   and `tests/public-api.test.ts` checks the emitted JavaScript. The only Node API is
   `AsyncLocalStorage`, imported in `src/attribution.ts` alone and instantiated once per
   process: under Node 22 every instance that has ever run stays registered and slows every
   async operation, so never create another.
2. Never modify the native client, its resources or its streams. Wrap them in a `Proxy`
   that overrides only what is metered and forwards everything else bound to the target.
   A metered `create()` passes every argument to the native method unchanged.
3. Read no payloads. From a response or stream frame read only `id`, `model`, `status`,
   `type`, `response` and `usage` with its detail objects. From request parameters read
   only `modalities`. From the client read only `baseURL`. Never read `messages`, `input`,
   `output`, `choices`, `tools`, `user`, `metadata`, `instructions` or an error.
   `tests/privacy.test.ts` plants a sentinel in every payload position.
4. Attribution comes from `attributionDefaults` (copied when instrumenting) under the
   innermost `withAudr` scope, merged by `mergeAttribution`, which copies only AUDR's
   attribution fields. Scopes are process-wide: one applies to every instrumented client.
   Attribution and the run are resolved once when a native call starts and never changed
   afterwards. A call without a resolved `environment` is not metered and logs
   `ATTRIBUTION_UNRESOLVED`.
5. Never change, delay or fail a native call. A native rejection propagates untouched and
   is never logged; every metering step after the call, including stream-shape inspection
   and the inspection of each frame, is guarded. `instrumentOpenAI` throws only when `client`
   has no `record()` or a client is already a facade.
6. Leave value validation to the `Client`. The adapter checks only what it needs to build a
   record at all: an `environment`, a model name (`MODEL_UNREPORTED`) and a provider
   (`PROVIDER_UNRESOLVED`).
7. The provider is never guessed. `providerFor` in `src/mapping.ts` knows a fixed set of
   hosts, matched by exact hostname or subdomain, plus loopback as self-hosted Ollama; every
   other host needs `mapResource`. Add a host only when its OpenAI-compatible endpoint is
   documented by the vendor, and add it to the README table in the same change.
8. Record a stream only from the frame that completes the call, before yielding it: the
   chunk carrying `usage` for chat, the terminal event for responses. Report any other ending
   once as `STREAM_INCOMPLETE` with its `reason`.
9. Diagnostics go through `Diagnostics` with a `DiagnosticCode` and the fixed field set in
   `src/diagnostics.ts`. Add a code for every new diagnostic. Never log a record value, an
   id, a model name, a URL, a mutable error name or an error message.
10. `emitter` is always the adapter as a `harness`. No `cost` is written. `input_tokens`
    excludes cache reads; `output_tokens` excludes reasoning. Never write `total_tokens`,
    `cache_write_tokens` (the wire format has none), `run.outcome`, `run.trace_id` or
    `run.step`.
11. A behaviour change updates its one home: `README.md` for installation, usage,
    attribution and the provider table, `docs/reference.md` for everything else. Neither
    repeats the other's detail.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Peer dependencies:** `openai` and `@openaudr/audr`, both also development dependencies.
  npm installs the SDK and links `@openaudr/audr` from the local workspace. The dev
  dependency on `openai` is pinned exactly to the floor of the peer range, so CI runs the
  suite against the oldest release the package claims to support. Raise the two together.
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

`tools/verify-npm-package.mjs` installs the packed adapter and core with the OpenAI SDK into
an empty project and runs `scripts/package-smoke.mjs`, which meters one call.
