# LiteLLM

An [adapter](../README.md) that registers as a LiteLLM callback and turns every
provider-reported completion, Responses API, embedding and rerank call made through the
LiteLLM Python SDK or `Router` into an [AUDR](../../spec/SPEC.md) record for an
`audr.Client` the host application owns. Attribution is read from each call's
`metadata["audr"]`, with configurable defaults; the adapter reads no prompts, messages or
responses.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [Python](python/) | [![PyPI](https://img.shields.io/pypi/v/audr-adapter-litellm?include_prereleases&label=audr-adapter-litellm)](https://pypi.org/project/audr-adapter-litellm/) | [`python/README.md`](python/README.md) — setup, usage, attribution, records; the full reference is [`python/docs/reference.md`](python/docs/reference.md) |

To contribute a change, see [`python/AGENTS.md`](python/AGENTS.md). To contribute a new
adapter, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
