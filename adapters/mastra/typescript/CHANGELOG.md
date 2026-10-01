# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release: `AudrExporter`, a Mastra `ObservabilityExporter` that submits one AUDR
  record per `model_generation` span and per `tool_call` / `mcp_tool_call` span to a
  host-owned `@openaudr/audr` `Client`. Attribution is read from `metadata.audr` over
  configurable defaults. Diagnostics go to an optional `logger`, carry stable codes and never
  include record values. `@mastra/core`, `@mastra/observability` and `@openaudr/audr` are
  peer dependencies.
