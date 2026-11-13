# Langfuse

An [adapter](../README.md) that adds an OpenTelemetry span processor beside the Langfuse
SDK's own and turns every generation, embedding, tool and retriever observation recorded
through the Langfuse Python SDK into an [AUDR](../../spec/SPEC.md) record for an
`audr.Client` the host application owns. Attribution is read from `audr_*` observation and
trace metadata, with configurable defaults; the adapter reads no observation input or
output.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [Python](python/) | [![PyPI](https://img.shields.io/pypi/v/audr-adapter-langfuse?include_prereleases&label=audr-adapter-langfuse)](https://pypi.org/project/audr-adapter-langfuse/) | [`python/README.md`](python/README.md) — setup, usage, attribution, records; the full reference is [`python/docs/reference.md`](python/docs/reference.md) |

To contribute a change, see [`python/AGENTS.md`](python/AGENTS.md). To contribute a new
adapter, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
