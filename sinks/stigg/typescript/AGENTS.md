# AGENTS.md

Guidance for working in this package. Rules for every sink are in
[`sinks/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this sink into an application, see [`README.md`](README.md); this file covers
changes to the package itself.

## What this is

`sinks/stigg/typescript` is the `@openaudr/audr-sink-stigg` npm package: an HTTP sink that
delivers record batches from the [`@openaudr/audr`](../../../adapters/core/typescript/) core
SDK to Stigg's raw events endpoint, `POST /api/v1/events`, for metering, entitlements and
credits. It implements the sink contract defined in
[`adapters/core/README.md`](../../../adapters/core/README.md#the-sink-contract).

Update [`docs/reference.md`](docs/reference.md) when public behaviour changes.
Examples must stub `fetch` and run without credentials or network access.

## Rules

1. `apiKey` and `eventName` are always required. `eventName` is one name for every record,
   validated at construction: not empty, not surrounded by whitespace, at most 255
   characters and not reserved by Stigg.
   `attribution.feature_id` is not the event name: Stigg meters select events by name, and
   one name may feed several features. Explicit options take precedence over
   `STIGG_API_KEY` and `STIGG_API_URL`. The key is sent only in the `X-API-KEY` header to
   the validated endpoint, and redirects are never followed.
2. Stigg routes on `attribution.account_id` as `customerId`; return a record without one
   as rejected with `missing_customer_id`, and check it against Stigg's customer ID pattern
   before sending (`invalid_customer_id`), because Stigg refuses the whole request for one
   bad event. Never send `resourceId`: a Stigg resource is not an AUDR subscription, so
   `attribution.subscription_id` is only a dimension. Return
   a record that carries `corrects` as rejected with `unsupported_correction`: Stigg usage
   is append-only.
3. `record_id` is `idempotencyKey`, and `timing.event_time`, converted to UTC, is
   `timestamp`. Stigg accepts only a `Z` timestamp, so an offset is converted, and it
   de-duplicates on the timestamp, customer, resource, event name and key together, so a
   timestamp is always sent. Serialize each request body once and resend those bytes on
   retry.
4. Send one event per record. Do not fan a record out to several events or invent
   idempotency keys. Stigg accepts duplicate keys inside one request, so `preflight`
   collapses identical records and rejects differing ones that share a `record_id`.
5. Flatten and forward every field of the record, including `attribution.labels` and `x_*`
   extensions, as dimensions. Dimension values are strings, finite numbers and booleans.
   The `__` separator is fixed, because meters and credit formulas refer to these names.
6. Record outcomes are never relabelled. A record that Stigg confirmed or refused, or that
   was rejected locally, keeps that outcome when a later request fails; the batch is
   answered `accepted`, the records of a request that failed permanently are `rejected`
   with the failure's detail, and the records without an outcome are `unknown`
   ([`src/tally.ts`](src/tally.ts)). Only a `202` or `200` confirms a request; another
   `2xx` leaves its records `unknown`.
7. Act on a `400` only when `parseValidationErrors` finds code `BadUserInput` and every
   `events[N]` the message names falls inside the request, and bound the resends of one
   request. The message is prose, not a contract: never surface it, and build details from
   allowlisted field names. A change to the status-to-outcome mapping in `src/sink.ts` or
   `src/response.ts` must update the [Responses table](docs/reference.md#responses) in the
   same change.
8. `deliver()` and `close()` never throw. Diagnostics and error messages carry field
   names, JSON pointers, status codes and counts, never a record value, a response body, an
   event name or a credential.
9. `src/index.ts` is the only entry point and `tests/public-api.test.ts` pins its runtime
   exports. Keep the surface small.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Dependencies:** `@openaudr/audr` is a peer dependency. The dev dependency on the same range
  links the repository's core through the root npm workspace, and `make install` builds
  the core first. The sink calls Stigg with `fetch`; it does not depend on a Stigg SDK.
- **Version:** `package.json`. `src/version.ts` is generated from it by `npm version`;
  never edit it by hand. `tests/public-api.test.ts` keeps them equal.
- **Tests:** no test reaches the network. `tests/setup.ts` replaces the global `fetch`
  with one that fails and clears the `STIGG_*` variables; every test injects its own
  `fetch`.

```bash
make format        # prettier --write
make typecheck     # tsc --noEmit over src, tests and scripts
make isolation     # build, lint the package metadata, install beside @openaudr/audr and deliver a batch
make verify        # lint + test + examples + isolation
```
