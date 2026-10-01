# Vercel AI SDK

An [adapter](../README.md) that registers as a Vercel AI SDK 7 telemetry integration and
turns every provider model call, client-side tool execution, embedding call and rerank call
into an [AUDR](../../spec/SPEC.md) record for an `@openaudr/audr` `Client` the host application owns.
Attribution is read from the call's `runtimeContext.audr`, with configurable defaults; the
adapter reads no prompts, completions, tool inputs or tool outputs.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [TypeScript](typescript/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-vercel-ai?include_prereleases&label=%40openaudr%2Faudr-adapter-vercel-ai)](https://www.npmjs.com/package/@openaudr/audr-adapter-vercel-ai) | [`typescript/README.md`](typescript/README.md) — install, usage, attribution; the full reference is [`typescript/docs/reference.md`](typescript/docs/reference.md) |

To contribute a change, see [`typescript/AGENTS.md`](typescript/AGENTS.md). To contribute a
new adapter, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
