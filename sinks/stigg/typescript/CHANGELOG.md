# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-16

### Added

- Initial package, `@openaudr/audr-sink-stigg`: `StiggSink`, an implementation of the
  `@openaudr/audr` core `Sink` interface that delivers each batch to Stigg's raw events
  endpoint, `POST /api/v1/events`, as one event per record for the customer
  `attribution.account_id` names, de-duplicated on `record_id`; and `flattenRecord`,
  the record-to-dimensions mapping it uses, which joins nested names with `__` (for example
  `usage__llm__input_tokens`).
- `eventName` is the one Stigg event name every record is sent under, validated at
  construction.
- The sink converts `timing.event_time` to the UTC timestamp Stigg accepts, rejects by name
  a record Stigg would refuse (`missing_customer_id`, `invalid_customer_id`,
  `invalid_timestamp`, `unencodable_field`, `dimensions_too_large`,
  `unsupported_correction`, `duplicate_record_id`), rejects the events a `400` names and
  resends the rest, retries transient failures with an identical request body inside
  `deliver()`, and reports a mixed batch as `accepted` with `rejected` and `unknown`
  records. It logs nothing unless given a `logger`.
- `docs/reference.md` documents every option, the event mapping, response outcomes,
  idempotency, retries and log messages.
- `examples/deliver.ts`, a runnable delivery against a stand-in endpoint; CI runs it.
