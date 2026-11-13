# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release: an OpenTelemetry span processor that turns Langfuse generation,
  embedding, tool and retriever observations into AUDR records for an existing
  `audr.Client`.
- `docs/reference.md` documents every option, the span metadata, record fields, the
  shutdown order, log messages and operational bounds.
