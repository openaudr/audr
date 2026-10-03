# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-03

### Added

- `docs/reference.md` documents the entry points, client options, submission outcomes,
  failure reasons, the sink contract, `FileSink`, validation codes and testing helpers.

### Changed

- The README follows the layout shared by the other AUDR packages, and every snippet in it
  runs as written.

## [0.1.0] - 2026-09-30

### Added

- Initial release: the AUDR v1.0.0 record types and `createRecord`,
  schema and cross-field validation, JSON encoding and decoding, the batching delivery
  pipeline behind `Client`, the sink contract, `FileSink` (`@openaudr/audr/file`), and the sink test
  harness (`@openaudr/audr/testing`). Structural validation and the record types are generated from
  the AUDR JSON Schema and committed, and `uuidv7` is built on `uuid`, the one runtime
  dependency. `Client` logs nothing unless given a `logger`.
