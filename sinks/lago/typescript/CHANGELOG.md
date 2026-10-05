# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-05

### Added

- Initial package, `@openaudr/audr-sink-lago`: `LagoSink`, an implementation of the
  `@openaudr/audr` core `Sink` interface that delivers each batch to Lago's batch event
  endpoint as one event per record, routed on `attribution.subscription_id`, de-duplicated
  on `record_id` and billed against `metricCode`; and `flattenRecord`, the
  record-to-properties mapping it uses, which joins nested names with `__` (for example
  `usage__llm__input_tokens`).
- `metricCode` is one code for every record or a function that chooses the code for each
  record, typed `MetricCode`, so one sink can bill records of different kinds to different
  metrics. A record for which the function chooses no valid code is rejected
  (`missing_metric_code`, `invalid_metric_code`) and never sent.
- The sink splits a batch into requests of at most 100 events, settles the events that a
  `422` response names and resends the rest, retries transient failures with an identical
  request body inside `deliver()`, and reports a mixed batch as `accepted` with `rejected`
  and `unknown` records. It rejects a record without `attribution.subscription_id`
  (`missing_subscription_id`) or with `corrects` (`unsupported_correction`) by name, and it
  logs nothing unless given a `logger`.
- `docs/reference.md` documents every option, the event mapping, response outcomes,
  idempotency on both Lago event stores, retries and log messages.
- `examples/deliver.ts`, a runnable delivery against a stand-in endpoint; CI runs it.
