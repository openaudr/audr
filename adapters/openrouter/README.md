# OpenRouter

An [adapter](../README.md) that wraps OpenRouter's native SDK client and turns every chat
completion and Responses call, streamed or not, and every embeddings call into an
[AUDR](../../spec/SPEC.md) record for an `@openaudr/audr` `Client` the host application
owns. Token counts and the per-call cost come from OpenRouter's own usage report, the
serving vendor from its router metadata or a generation lookup, and attribution from
`withAudr` scopes with configurable defaults. The adapter never reads prompts, completions,
tools, request `metadata` or error messages.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [TypeScript](typescript/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-openrouter?include_prereleases&label=%40openaudr%2Faudr-adapter-openrouter)](https://www.npmjs.com/package/@openaudr/audr-adapter-openrouter) | [`typescript/README.md`](typescript/README.md) — install, usage, attribution; the full reference is [`typescript/docs/reference.md`](typescript/docs/reference.md) |

To contribute a change, see [`typescript/AGENTS.md`](typescript/AGENTS.md). To contribute a
new adapter, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
