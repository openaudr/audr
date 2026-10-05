# Sinks

A sink receives [AUDR](../spec/SPEC.md) records from a `Client` built on the
[core SDK](../adapters/core/README.md) and delivers them to a destination: a file, a
warehouse, Chargebee. It owns encoding, transport, credentials, retries, and any
destination-specific byte limits. The core never talks to a destination directly, and a
sink never talks to a runtime — that is an [adapter's](../adapters/README.md) job.

The specification calls this ingest layer the sink: a conformant one de-duplicates on
`record_id` and merges records that share `(run_id, span_id)`. A sink package delivers each
batch to it and reports, per record, what the destination did.

```mermaid
sequenceDiagram
    participant H as Host application
    participant C as Client (core SDK)
    participant S as Sink
    participant D as Destination

    Note over H,D: Batching
    C->>C: queue admitted records in a bounded FIFO
    C->>C: form a batch on batch_max_size or linger

    Note over H,D: Delivery, one batch at a time
    C->>S: deliver(batch)
    S->>S: encode, set aside records the destination cannot accept, listed by record_id
    loop retries, if the sink makes them (bounded, with backoff)
        S->>D: send the batch with the sink's credentials
        Note over D: de-duplicates on record_id,<br/>so a retry or replay is safe
        D-->>S: per-record result
    end
    D->>D: store, and a conformant destination merges on (run_id, span_id)
    S-->>C: BatchResult: ACCEPTED with rejected and unknown,<br/>RETRYABLE_FAILURE, PERMANENT_FAILURE or CLOSED
    C->>C: settle each record as sent, dropped or unknown
    C-->>H: on_delivered and on_failure callbacks, DeliveryStats

    Note over H,D: Shutdown
    H->>C: shutdown()
    C->>S: close(), idempotent
```

A sink implements two asynchronous operations, `deliver()` and `close()`, and answers each
batch with a typed outcome. The contract — including what the pipeline guarantees a sink
and how each outcome affects the records in a batch — is defined in
[`adapters/core/README.md`](../adapters/core/README.md#the-sink-contract).

A sink forwards the whole record. Every field it is given, including `attribution.labels`
and any `x_*` extension, reaches the destination, and nothing downstream re-checks the
data-handling rules in [`SECURITY.md`](../SECURITY.md). Whatever a record must not carry,
it must not carry at the point it is built.

## Sinks

| Sink | Directory | Distribution | CI |
| --- | --- | --- | --- |
| Chargebee | [`chargebee/`](chargebee/) | [![PyPI](https://img.shields.io/pypi/v/audr-sink-chargebee?include_prereleases&label=audr-sink-chargebee)](https://pypi.org/project/audr-sink-chargebee/) [![npm](https://img.shields.io/npm/v/@openaudr/audr-sink-chargebee?include_prereleases&label=%40openaudr%2Faudr-sink-chargebee)](https://www.npmjs.com/package/@openaudr/audr-sink-chargebee) | [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/sink-chargebee-python-verify.yml?branch=main&label=ci%20python)](https://github.com/openaudr/audr/actions/workflows/sink-chargebee-python-verify.yml) [![ci](https://img.shields.io/github/actions/workflow/status/openaudr/audr/typescript-verify.yml?branch=main&label=ci%20typescript)](https://github.com/openaudr/audr/actions/workflows/typescript-verify.yml) |

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) describes how to propose and build a new sink.
[`AGENTS.md`](AGENTS.md) holds the invariants for work in this tree and a brief for
creating a sink.
