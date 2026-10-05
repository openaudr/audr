# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release, published as `@openaudr/audr-adapter-openrouter`
  ([openaudr/audr#50](https://github.com/openaudr/audr/issues/50)):
  `instrumentOpenRouter()`, a non-mutating facade over an `@openrouter/sdk` `OpenRouter`
  that submits one AUDR record per `chat.send()` and `responses.send()` (`generation`, from
  the usage chunk or terminal event when streamed) and per `embeddings.generate()`
  (`embedding`) to a host-owned `@openaudr/audr` `Client`, passing every argument to the
  native method unchanged. Token counters are made cache- and reasoning-exclusive, and the
  cost of a BYOK call is OpenRouter's fee plus the provider's charge.
- The serving vendor is read from router metadata, or from `generations.getGeneration()`
  through the host's own client, which is retried within the `lookup` bounds. A
  response-cache replay, and a call whose vendor cannot be resolved, are attributed to
  `openrouter`; `mapResource({ model, vendor })` can override either.
- `withAudr()`, which applies attribution and an optional host run to every call any
  instrumented client starts inside it, over each client's `attributionDefaults`.
- Value-free diagnostics with stable codes: `ATTRIBUTION_UNRESOLVED`,
  `PROVIDER_UNRESOLVED`, `LOOKUP_FAILED`, `BYOK_COST_INCOMPLETE`, `MODEL_UNREPORTED`,
  `USAGE_UNREPORTED`, `STREAM_INCOMPLETE`, `RECORD_NOT_QUEUED` and `HOOK_FAILED`. Nothing is
  logged unless a `logger` is given. `@openrouter/sdk` and `@openaudr/audr` are peer
  dependencies.
- `examples/` run against a local stand-in for the OpenRouter API, and
  `scripts/package-smoke.mjs` meters one call from the packed package; `make examples` and
  `make isolation` run them.
