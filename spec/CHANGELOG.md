# Changelog

All notable changes to the AUDR specification are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the specification adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
A published version is immutable; a defect is corrected by a new version.

## [1.1.0] - 2026-10-12

### Added

- `attribution.feature_id`, an optional host-defined identifier of the product
  feature the operation served, used by a sink or rating component to select the
  meter, metric or price the usage is billed against.
- `resource.namespace`, an optional host-configured name of the source within the
  provider that defines a tool, such as a toolkit, an action group or an MCP server
  configuration key, so that `provider`, `namespace` and `name` together identify a
  tool. Permitted only for tool operations.

## [1.0.0] - 2026-09-22

### Added

- Initial release. Published at
  [https://openaudr.dev/spec/v1.0.0/](https://openaudr.dev/spec/v1.0.0/) and
  tagged `spec/v1.0.0`.
