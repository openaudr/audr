# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-21

### Changed

- **Breaking:** each `attribution.labels` entry is sent as its own property,
  `attribution__labels__<key>`, instead of one JSON string under
  `attribution__labels__json`. A `.` or `-` in a label key becomes `_`, and a record whose
  label keys collide after that rewrite is rejected as invalid. Update metered features
  that filter on `attribution__labels__json`.
- Requires `@openaudr/audr` 0.2, which emits specification 1.1.0 records:
  `attribution.feature_id` and `resource.namespace` arrive as `attribution__feature_id`
  and `resource__namespace`.

## [0.1.1] - 2026-10-03

### Added

- `docs/reference.md` documents every option, the flattening rules, response outcomes,
  retries and log messages.
- `examples/deliver.ts`, a runnable delivery against a stand-in ingest endpoint; CI runs it.

### Changed

- The README follows the layout shared by the other AUDR packages.

## [0.1.0] - 2026-10-01

### Added

- Initial release, published as `@openaudr/audr-sink-chargebee`: `ChargebeeSink`, an
  implementation of the `@openaudr/audr` core `Sink` interface that delivers each batch to a
  Chargebee site's usage-ingest batch endpoint, owns its own bounded retry policy, and leaves
  the request-size limit to the destination; and `flattenRecord`, the record-to-properties
  mapping it uses, which joins nested names with `__` by default (for example
  `usage__llm__input_tokens`). The sink logs nothing unless given a `logger`.
