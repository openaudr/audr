# Adapters

An adapter observes a harness, router, or other agent runtime and turns its own events into
[AUDR](../spec/SPEC.md) records, which it hands to a `Client` built on the
[core SDK](core/README.md). It never talks to a destination directly — that is a
[sink's](../sinks/README.md) job.

The host application owns the `Client` and its sink; the adapter receives the client and
feeds it one record per metered operation. A record that cannot be attributed is skipped
rather than billed to a guess.

```mermaid
sequenceDiagram
    participant H as Host application
    participant A as Adapter
    participant R as Runtime (harness or router)
    participant C as Client (core SDK)

    Note over H,C: Setup
    H->>C: construct Client with a sink and an emitter
    H->>A: install adapter with the Client and attribution defaults
    A->>R: register through the runtime's plugin, callback or middleware

    Note over H,C: One metered operation
    H->>R: run an agent step with per-request attribution
    R->>R: model or tool call
    R-->>H: result
    R-)A: runtime event: identifiers, usage and timings, no payloads
    A->>A: resolve attribution from runtime context over host defaults
    alt attribution unresolved
        A->>A: skip the record, log a value-free warning
    else attribution resolved
        A->>A: build AUDR record: run_id and span_id from the runtime, normalized usage
        A->>C: client.record(record)
        C->>C: add the client's emitter if the record has none, validate
        C-->>A: SubmitResult: queued or rejected, no I/O
    end

    Note over H,C: Shutdown
    H->>R: stop producing work
    H->>A: drain() (Python adapters that bridge runtime threads)
    H->>C: shutdown(): flush the queue, close the sink
```

TypeScript adapters have no `drain()`: stop the runtime, then await `client.shutdown()`. The
SDK mints each record's `record_id`; the client batches queued records and delivers them
through the sink, as the [sink workflow](../sinks/README.md) shows.

The core SDK is located here because every adapter depends on it, and because an
application that emits records directly uses the core alone: the null adapter.

## Adapters

| Adapter | Directory | Distribution | CI |
| --- | --- | --- | --- |
| Core (null adapter) | [`core/`](core/) | [![PyPI](https://img.shields.io/pypi/v/audr?include_prereleases&label=audr)](https://pypi.org/project/audr/) [![npm](https://img.shields.io/npm/v/@openaudr/audr?include_prereleases&label=%40openaudr%2Faudr)](https://www.npmjs.com/package/@openaudr/audr) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/adapter-core-python-verify.yml?branch=main&label=ci%20python)](https://github.com/openaudr/audr/actions/workflows/adapter-core-python-verify.yml) [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/typescript-verify.yml?branch=main&label=ci%20typescript)](https://github.com/openaudr/audr/actions/workflows/typescript-verify.yml) |
| NVIDIA NeMo Relay | [`nemo-relay/`](nemo-relay/) | [![PyPI](https://img.shields.io/pypi/v/audr-adapter-nemo-relay?include_prereleases&label=audr-adapter-nemo-relay)](https://pypi.org/project/audr-adapter-nemo-relay/) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/adapter-nemo-relay-python-verify.yml?branch=main&label=ci)](https://github.com/openaudr/audr/actions/workflows/adapter-nemo-relay-python-verify.yml) |
| LiteLLM | [`litellm/`](litellm/) | [![PyPI](https://img.shields.io/pypi/v/audr-adapter-litellm?include_prereleases&label=audr-adapter-litellm)](https://pypi.org/project/audr-adapter-litellm/) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/adapter-litellm-python-verify.yml?branch=main&label=ci)](https://github.com/openaudr/audr/actions/workflows/adapter-litellm-python-verify.yml) |
| Merge Gateway | [`merge-gateway/`](merge-gateway/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-merge-gateway?include_prereleases&label=%40openaudr%2Faudr-adapter-merge-gateway)](https://www.npmjs.com/package/@openaudr/audr-adapter-merge-gateway) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/typescript-verify.yml?branch=main&label=ci)](https://github.com/openaudr/audr/actions/workflows/typescript-verify.yml) |
| Vercel AI SDK | [`vercel-ai/`](vercel-ai/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-vercel-ai?include_prereleases&label=%40openaudr%2Faudr-adapter-vercel-ai)](https://www.npmjs.com/package/@openaudr/audr-adapter-vercel-ai) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/typescript-verify.yml?branch=main&label=ci)](https://github.com/openaudr/audr/actions/workflows/typescript-verify.yml) |
| Mastra | [`mastra/`](mastra/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-mastra?include_prereleases&label=%40openaudr%2Faudr-adapter-mastra)](https://www.npmjs.com/package/@openaudr/audr-adapter-mastra) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/typescript-verify.yml?branch=main&label=ci)](https://github.com/openaudr/audr/actions/workflows/typescript-verify.yml) |

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) describes how to propose and build a new adapter.
[`AGENTS.md`](AGENTS.md) holds the invariants for work in this tree and a brief for
creating an adapter.
