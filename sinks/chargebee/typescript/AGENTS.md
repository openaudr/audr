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

## Layout

| Path | Owns |
| --- | --- |
| `src/sink.ts` | `ChargebeeSink`: `deliver()`, `close()`, the retry loop, and the HTTP-response-to-`BatchResult` mapping |
| `src/transport.ts` | `Transport`: one `fetch` per attempt with a per-request deadline; `close()` aborts requests in flight |
| `src/retry.ts` | `RetryPolicy`: failure classification, full-jitter backoff and `Retry-After` |
| `src/flatten.ts` | `flattenRecord`: reversible flattening of a nested record into scalar Chargebee properties |
| `src/event.ts` | The ingest event shape and its validation |
| `src/credentials.ts` | `site` / `apiKey` / ingest URL resolution from options and environment |
| `scripts/verify-package.ts` | The isolation check `make isolation` runs against the packed tarballs |
| `examples/deliver.ts` | A delivery against a stand-in `fetch`; `make examples` and CI run it |
| `docs/reference.md` | The reference the README links to: options, flattening, responses, retries, diagnostics |
| `tests/` | The Vitest suite; `setup.ts` blocks the global `fetch` and clears the `CHARGEBEE_*` variables for every test |

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
5. A change to the status-to-outcome mapping in `src/sink.ts` must be reflected in the
   README table in the same change. When a `207` failure cannot be matched to a record,
   mark every non-rejected record in the batch `unknown`. Retries are bounded by `retry`.
6. `deliver()` and `close()` never throw. Diagnostics and error messages carry field
   names, JSON pointers, status codes and counts, never a record value or a credential.
7. `src/index.ts` is the only entry point and `tests/public-api.test.ts` pins its runtime
   exports. Keep the surface small.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Dependencies:** `@openaudr/audr` is a peer dependency. Until it is published, the dev copy is
  linked from `../../../adapters/core/typescript`, and `make install` builds the core
  first.
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
