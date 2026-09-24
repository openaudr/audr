# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `usage.llm.input_tokens` for Relay's `AnthropicMessagesCodec` is the reported prompt count
  unchanged. That count already excludes cache reads and writes, and subtracting them again
  under-counted Anthropic calls with prompt caching.
- `emitter.name` is `audr-adapter-nemo-relay` and `emitter.version` is this package's
  release, as the specification defines them. Records previously carried `nemo-relay` and
  the installed Relay version.

### Security

- An unrecognised key under the `audr` scope metadata namespace is reported as
  `/metadata/audr` instead of being included in the logged pointer.

## [0.1.0] - 2026-09-22

### Added

- Initial release: a NeMo Relay plugin that turns completed Relay LLM and tool scopes
  into AUDR records for an existing `audr.Client`.
