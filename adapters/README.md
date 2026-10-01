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

| Adapter | Directory | Distribution | CI |
| --- | --- | --- | --- |
| Core (null adapter) | [`core/`](core/) | [![PyPI](https://img.shields.io/pypi/v/audr?include_prereleases&label=audr)](https://pypi.org/project/audr/) [![npm](https://img.shields.io/npm/v/@openaudr/audr?include_prereleases&label=%40openaudr%2Faudr)](https://www.npmjs.com/package/@openaudr/audr) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/adapter-core-python-verify.yml?branch=main&label=ci%20python)](https://github.com/openaudr/audr/actions/workflows/adapter-core-python-verify.yml) [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/adapter-core-typescript-verify.yml?branch=main&label=ci%20typescript)](https://github.com/openaudr/audr/actions/workflows/adapter-core-typescript-verify.yml) |
| NVIDIA NeMo Relay | [`nemo-relay/`](nemo-relay/) | [![PyPI](https://img.shields.io/pypi/v/audr-adapter-nemo-relay?include_prereleases&label=audr-adapter-nemo-relay)](https://pypi.org/project/audr-adapter-nemo-relay/) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/adapter-nemo-relay-python-verify.yml?branch=main&label=ci)](https://github.com/openaudr/audr/actions/workflows/adapter-nemo-relay-python-verify.yml) |
| LiteLLM | [`litellm/`](litellm/) | [![PyPI](https://img.shields.io/pypi/v/audr-adapter-litellm?include_prereleases&label=audr-adapter-litellm)](https://pypi.org/project/audr-adapter-litellm/) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/adapter-litellm-python-verify.yml?branch=main&label=ci)](https://github.com/openaudr/audr/actions/workflows/adapter-litellm-python-verify.yml) |
| Vercel AI SDK | [`vercel-ai/`](vercel-ai/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-vercel-ai?include_prereleases&label=%40openaudr%2Faudr-adapter-vercel-ai)](https://www.npmjs.com/package/@openaudr/audr-adapter-vercel-ai) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/adapter-vercel-ai-typescript-verify.yml?branch=main&label=ci)](https://github.com/openaudr/audr/actions/workflows/adapter-vercel-ai-typescript-verify.yml) |

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) describes how to propose and build a new adapter.
[`AGENTS.md`](AGENTS.md) holds the invariants for work in this tree and a brief for
creating an adapter.
