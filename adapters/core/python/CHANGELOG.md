# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-03

### Added

- Package metadata links to this changelog, shown on PyPI as the Changelog URL.
- `docs/reference.md` documents client options, submission outcomes, failure reasons, the
  sink contract, `FileSink`, validation codes, testing helpers and loggers.

### Changed

- The README follows the layout shared by the other AUDR packages, and every snippet in it
  runs as written.
- CI runs the examples on every supported Python version.

## [0.1.0] - 2026-09-22

### Added

- Initial release: the AUDR v1.0.0 record model, validation,
  the batching delivery pipeline, the sink contract, and `FileSink`.
