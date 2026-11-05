# OpenAI SDK

An [adapter](../README.md) that wraps an OpenAI SDK client and turns every chat completion
and Responses call, streamed or not, and every embeddings call into an
[AUDR](../../spec/SPEC.md) record for an `@openaudr/audr` `Client` the host application
owns. It serves any endpoint that speaks the OpenAI wire format: the provider is read from the
client's `baseURL`, so the same package meters OpenAI, Azure OpenAI, Groq, Mistral, Together,
Fireworks, DeepSeek, OpenRouter and a local Ollama, and `mapResource` names any other host.
Token counts come from the provider's own usage report and attribution from `withAudr` scopes
with configurable defaults. The adapter never reads messages, input, output, tools or error
messages.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [TypeScript](typescript/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-openai?include_prereleases&label=%40openaudr%2Faudr-adapter-openai)](https://www.npmjs.com/package/@openaudr/audr-adapter-openai) | [`typescript/README.md`](typescript/README.md) — install, usage, attribution, providers; the full reference is [`typescript/docs/reference.md`](typescript/docs/reference.md) |

To contribute a change, see [`typescript/AGENTS.md`](typescript/AGENTS.md). To contribute a
new adapter, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
