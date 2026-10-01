# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-01

### Added

- Initial release, published as `@openaudr/audr-sink-chargebee`: `ChargebeeSink`, an
  implementation of the `@openaudr/audr` core `Sink` interface that delivers each batch to a
  Chargebee site's usage-ingest batch endpoint, owns its own bounded retry policy, and leaves
  the request-size limit to the destination; and `flattenRecord`, the record-to-properties
  mapping it uses, which joins nested names with `__` by default (for example
  `usage__llm__input_tokens`). The sink logs nothing unless given a `logger`.
