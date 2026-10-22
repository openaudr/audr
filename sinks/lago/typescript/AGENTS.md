# AGENTS.md

Guidance for working in this package. Rules for every sink are in
[`sinks/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this sink into an application, see [`README.md`](README.md); this file covers
changes to the package itself.

## What this is

`sinks/lago/typescript` is the `@openaudr/audr-sink-lago` npm package: an HTTP sink that
delivers record batches from the [`@openaudr/audr`](../../../adapters/core/typescript/) core
SDK to Lago's batch event endpoint for usage-based billing. It implements the sink contract
defined in [`adapters/core/README.md`](../../../adapters/core/README.md#the-sink-contract).

Update [`docs/reference.md`](docs/reference.md) when public behaviour changes.
Examples must stub `fetch` and run without credentials or network access.

## Rules

1. `apiKey` is always required. The event code is the record's `attribution.feature_id`.
   Reject a record without one as `missing_metric_code`, and one whose
   `feature_id` has surrounding whitespace as `invalid_metric_code`. Lago accepts an event
   whose code matches no active metric and then skips it silently. Explicit options take
   precedence over `LAGO_API_KEY` and `LAGO_API_URL`. The key is sent only to the validated
   endpoint, and redirects are never followed.
2. Lago routes on `attribution.subscription_id`. Return a record without one as rejected
   with detail `missing_subscription_id`; never send it. Return a record that carries
   `corrects` as rejected with detail `unsupported_correction`, because Lago cannot
   restate an event.
3. `record_id` is `transaction_id`, and `timing.event_time` is `timestamp`. Serialize each
   request body once and resend those bytes on retry. On a ClickHouse event store the
   timestamp is part of the de-duplication key, so a retry with another timestamp is a
   second billable event.
4. Send one event per record, under the code its `feature_id` names.
   Do not fan a record out to several codes or invent transaction identifiers: the
   Postgres event store de-duplicates on `transaction_id` and subscription, without the
   code.
5. Flatten and forward every field of the record, including `attribution.labels` and `x_*`
   extensions. Property values are strings and finite numbers. Keep property names
   reversible; the `__` separator is fixed, because billable metrics refer to these names.
6. Record outcomes are never relabelled. A record that Lago confirmed or refused, or that
   was rejected locally, keeps that outcome when a later request fails; the batch is
   answered `accepted`, the records of a request that failed permanently are `rejected`
   with the failure's detail, and the records without an outcome are `unknown`
   ([`src/tally.ts`](src/tally.ts)). The `Tally` derives `unknown` from the outcomes it
   recorded, so an unexpected error mid-batch is reported the same way. Only a `200`
   confirms a request; another `2xx` leaves its records `unknown`.
7. Act on a `422` only when `parseValidationErrors` can match every named position to an
   event of the request, and bound the resends of one request. An entry that is a message
   rather than field codes refuses its event; never read the message. A change to the
   status-to-outcome mapping in `src/sink.ts` or `src/response.ts` must update the
   [Responses table](docs/reference.md#responses) in the same change.
8. `deliver()` and `close()` never throw. Diagnostics and error messages carry field
   names, JSON pointers, status codes and counts, never a record value, a response body or
   a credential. Rejection details are built from allowlisted names.
9. `src/index.ts` is the only entry point and `tests/public-api.test.ts` pins its runtime
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
  with one that fails and clears the `LAGO_*` variables; every test injects its own
  `fetch`.

```bash
make format        # prettier --write
make typecheck     # tsc --noEmit over src, tests and scripts
make isolation     # build, lint the package metadata, install beside @openaudr/audr and deliver a batch
make verify        # lint + test + examples + isolation
```
