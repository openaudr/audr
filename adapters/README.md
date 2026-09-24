# Adapters

An adapter observes a harness, router, or other agent runtime and turns its own events into
[AUDR](../spec/SPEC.md) records, which it hands to a `Client` built on the
[core SDK](core/README.md). It never talks to a destination directly — that is a
[sink's](../sinks/README.md) job.

```
runtime events ──▶ adapter ──▶ client.record() ──▶ Client ──▶ sink
```

The core SDK is located here because every adapter depends on it, and because an
application that emits records directly uses the core alone: the null adapter.

## Adapters

| Adapter | Directory | Distribution |
| --- | --- | --- |
| Core (null adapter) | [`core/`](core/) | [![PyPI](https://img.shields.io/pypi/v/audr?include_prereleases&label=audr)](https://pypi.org/project/audr/) [![npm](https://img.shields.io/npm/v/audr?include_prereleases&label=audr)](https://www.npmjs.com/package/audr) |
| NVIDIA NeMo Relay | [`nemo-relay/`](nemo-relay/) | [![PyPI](https://img.shields.io/pypi/v/audr-adapter-nemo-relay?include_prereleases&label=audr-adapter-nemo-relay)](https://pypi.org/project/audr-adapter-nemo-relay/) |

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) describes how to propose and build a new adapter.
[`AGENTS.md`](AGENTS.md) holds the invariants for work in this tree and a brief for
creating an adapter.
