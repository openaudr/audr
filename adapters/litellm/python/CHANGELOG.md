# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-03

### Added

- `docs/reference.md` documents every option, the request metadata, record fields, the
  shutdown order, log messages and operational bounds.

### Changed

- Request `labels` merge with `attribution_defaults.labels` key by key, the request's value
  winning for a shared key. A request that set any label previously replaced the default
  labels entirely. A merged map above the 20-label limit skips the record.
- `examples/` run on LiteLLM mock responses, without network access or provider keys, and
  CI runs them.
- The README follows the layout shared by the other AUDR packages.

## [0.1.0] - 2026-09-24

### Added

- Initial release: a LiteLLM custom callback that turns model usage into AUDR
  records for an existing `audr.Client`.
