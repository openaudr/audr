# NVIDIA NeMo Relay

An [adapter](../README.md) that observes completed NVIDIA NeMo Relay LLM and tool scopes
and turns them into [AUDR](../../spec/SPEC.md) records for an `audr.Client` the host
application owns. Attribution is read from the root Relay scope's metadata, with
configurable defaults; the adapter reads no prompts, responses, tool arguments or tool
results.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [Python](python/) | [![PyPI](https://img.shields.io/pypi/v/audr-adapter-nemo-relay?include_prereleases&label=audr-adapter-nemo-relay)](https://pypi.org/project/audr-adapter-nemo-relay/) | [`python/README.md`](python/README.md) — setup, usage, attribution, records; the full reference is [`python/docs/reference.md`](python/docs/reference.md) |

To contribute a change, see [`python/AGENTS.md`](python/AGENTS.md). To contribute a new
adapter, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
