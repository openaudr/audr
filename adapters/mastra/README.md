# Mastra

An [adapter](../README.md) that registers as a Mastra `ObservabilityExporter` and turns each
ended `model_generation` span and each `tool_call` / `mcp_tool_call` span into an
[AUDR](../../spec/SPEC.md) record for an `@openaudr/audr` `Client` the host application owns.
Attribution is read from span `metadata.audr`, with configurable defaults; the adapter reads no
prompts, completions, tool inputs or tool outputs.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [TypeScript](typescript/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-mastra?include_prereleases&label=%40openaudr%2Faudr-adapter-mastra)](https://www.npmjs.com/package/@openaudr/audr-adapter-mastra) | [`typescript/README.md`](typescript/README.md) — install, usage, attribution; the full reference is [`typescript/docs/reference.md`](typescript/docs/reference.md) |

To contribute a change, see [`typescript/AGENTS.md`](typescript/AGENTS.md). To contribute a
new adapter, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
