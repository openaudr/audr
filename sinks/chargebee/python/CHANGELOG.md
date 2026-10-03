# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-03

### Added

- Package metadata links to this changelog, shown on PyPI as the Changelog URL.
- `docs/reference.md` documents every option, the flattening rules, response outcomes,
  retries, transport settings and log messages.
- `examples/deliver.py`, a runnable delivery example that uses a mock ingest endpoint.

### Changed

- **Breaking:** the default `separator` is `__`, matching the TypeScript sink. Properties
  are named `usage__llm__input_tokens` and `attribution__labels__json` instead of
  `usage_llm_input_tokens` and `attribution_labels_json`. Update metered features that
  filter on the previous names, or pass `separator="_"` to keep them.
- The README follows a new layout that includes `reference.md`.

## [0.1.0] - 2026-09-22

### Added

- Initial release: `ChargebeeSink`, an implementation of the `audr` core `Sink`
  protocol that owns its own retry policy and leaves the request-size limit to
  the destination.
