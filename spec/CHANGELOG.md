# Changelog

All notable changes to the AUDR specification are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the specification adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
A published version is immutable; a defect is corrected by a new version.

## [Unreleased]

The schema `$id` and the `spec_version` pattern remain at 1.0.0 until the next
version is published. Records that use the fields below do not validate against
the published 1.0.0 schema.

### Added

- `attribution.feature_id`, an optional host-defined identifier of the product
  feature the operation served, used by a sink or rating component to select the
  meter, metric or price the usage is billed against.

## [1.0.0] - 2026-09-22

### Added

- Initial release. Published at
  [https://openaudr.dev/spec/v1.0.0/](https://openaudr.dev/spec/v1.0.0/) and
  tagged `spec/v1.0.0`.
