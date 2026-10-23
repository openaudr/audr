# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-23

### Added

- `metadata.audr` and `attributionDefaults` accept `feature_id`, the specification 1.1.0
  identifier of the product feature the span served, which a sink uses to select the meter
  the usage is billed against.
- An `mcp_tool_call` record carries `resource.namespace`, the MCP server configuration key
  from the span's `mcpServer` attribute, so that `provider`, `namespace` and `name`
  together identify the tool.

### Changed

- Requires `@openaudr/audr` 0.2, which emits specification 1.1.0 records.

## [0.1.0] - 2026-10-05

### Added

- Initial release, published as `@openaudr/audr-adapter-mastra`: `AudrExporter`, a Mastra
  `ObservabilityExporter` that submits one AUDR record per provider model call
  (`model_inference`), embedding call (`rag_embedding`) and tool call (`tool_call`,
  `mcp_tool_call`) to a host-owned `@openaudr/audr` `Client`. Model and embedding records
  include `requests: 1`. The tool call through which an agent invokes a sub-agent or a
  workflow is not recorded; the sub-agent's own calls are. Attribution is read from
  `metadata.audr` over configurable defaults. Diagnostics go to the `logger` option or to
  the Mastra instance's logger, carry stable codes and no record values. `@mastra/core`,
  `@mastra/observability` and `@openaudr/audr` are peer dependencies.
