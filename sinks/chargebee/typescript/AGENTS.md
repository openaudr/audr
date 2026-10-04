# AGENTS.md

Guidance for working in this package. Rules for every sink are in
[`sinks/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this sink into an application, see [`README.md`](README.md); this file covers
changes to the package itself.

## What this is

`sinks/chargebee/typescript` is the `@openaudr/audr-sink-chargebee` npm package: an HTTP
sink that delivers record batches from the
[`@openaudr/audr`](../../../adapters/core/typescript/) core SDK to a
Chargebee site's usage-ingest batch endpoint for Usage-Based Billing. It implements the
sink contract defined in
[`adapters/core/README.md`](../../../adapters/core/README.md#the-sink-contract) and
matches the behaviour of the Python sink in [`../python/`](../python/).

Update [`docs/reference.md`](docs/reference.md) when public behaviour changes.
Examples must stub `fetch` and run without credentials or network access.

## Rules

1. `apiKey` is always required. Explicit options take precedence over `CHARGEBEE_SITE`,
   `CHARGEBEE_API_KEY`, `CHARGEBEE_INGEST_DOMAIN` and `CHARGEBEE_INGEST_URL`. `ingestUrl`
   is mutually exclusive with `site` and `ingestDomain`. The key is sent only to the
   validated origin, and redirects are never followed.
2. Chargebee routes on `attribution.subscription_id`. Return a record without one as
   rejected with detail `missing_subscription_id`; never send it.
3. `record_id` is Chargebee's `deduplication_id`, and `timing.event_time` in milliseconds
   is `usage_timestamp`. A replay keyed on `record_id` is idempotent.
4. Flatten and forward every field of the record, including `attribution.labels` and
   `x_*` extensions. Keep property names reversible; the separator is one or more
   underscores, `__` by default.
5. A change to the status-to-outcome mapping in `src/sink.ts` must update the
   [Responses table](docs/reference.md#responses) in the same change. When a `207`
   failure cannot be matched to a record, mark every non-rejected record in the batch
   `unknown`. Retries are bounded by `retry`.
6. `deliver()` and `close()` never throw. Diagnostics and error messages carry field
   names, JSON pointers, status codes and counts, never a record value or a credential.
7. `src/index.ts` is the only entry point and `tests/public-api.test.ts` pins its runtime
   exports. Keep the surface small.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Dependencies:** `@openaudr/audr` is a peer dependency. The dev dependency on the same range
  links the repository's core through the root npm workspace, and `make install` builds
  the core first.
- **Version:** `package.json` and `src/version.ts`; `tests/public-api.test.ts` keeps them
  equal.
- **Tests:** no test reaches the network. `tests/setup.ts` replaces the global `fetch`
  with one that fails, and every test injects its own `fetch`.

```bash
make format        # prettier --write
make typecheck     # tsc --noEmit over src, tests and scripts
make isolation     # build, lint the package metadata, install beside @openaudr/audr and deliver a batch
make verify        # lint + test + isolation
```
