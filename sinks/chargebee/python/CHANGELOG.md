# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Package metadata links to this changelog, shown on PyPI as the Changelog URL.

## [0.1.0] - 2026-09-22

### Added

- Initial release: `ChargebeeSink`, an implementation of the `audr` core `Sink`
  protocol that owns its own retry policy and leaves the request-size limit to
  the destination.
