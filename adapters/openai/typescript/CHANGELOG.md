# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release, published as `@openaudr/audr-adapter-openai`: `instrumentOpenAI()`, a
  non-mutating facade over an `openai` client that submits one AUDR record per
  `chat.completions.create()` (`generation`, from the chunk carrying `usage` when streamed),
  `responses.create()` (`generation`, from the terminal event when streamed) and
  `embeddings.create()` (`embedding`) to a host-owned `@openaudr/audr` `Client`, passing every
  argument to the native method unchanged. Token counters are made cache- and
  reasoning-exclusive.
- `resource.provider` resolved from the client's `baseURL`: OpenAI, Azure OpenAI, Groq,
  Mistral, Together, Fireworks, DeepSeek, OpenRouter, and a loopback host as self-hosted
  Ollama. Any other host is named through `mapResource`, never guessed.
- `withAudr()`, which applies attribution and an optional host run to every call any
  instrumented client starts inside it, over each client's `attributionDefaults`.
- Value-free diagnostics with stable codes: `ATTRIBUTION_UNRESOLVED`, `PROVIDER_UNRESOLVED`,
  `MODEL_UNREPORTED`, `STREAM_INCOMPLETE`, `RECORD_NOT_QUEUED` and `HOOK_FAILED`. Nothing is
  logged unless a `logger` is given. `openai` and `@openaudr/audr` are peer dependencies.
