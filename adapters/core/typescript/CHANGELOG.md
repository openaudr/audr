# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-30

### Added

- Initial release: the AUDR v1.0.0 record types and `createRecord`,
  schema and cross-field validation, JSON encoding and decoding, the batching delivery
  pipeline behind `Client`, the sink contract, `FileSink` (`audr/file`), and the sink test
  harness (`audr/testing`). Structural validation and the record types are generated from
  the AUDR JSON Schema and committed, and `uuidv7` is built on `uuid`, the one runtime
  dependency. `Client` logs nothing unless given a `logger`.
