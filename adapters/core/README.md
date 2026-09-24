# Core SDK

The vendor-neutral core every adapter and sink depends on. It models and validates
[AUDR](../../spec/SPEC.md) records and delivers them to a destination through the sink
contract defined below. It is also the null adapter: an application that emits records
directly uses this package alone.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [Python](python/) | [![PyPI](https://img.shields.io/pypi/v/audr?include_prereleases&label=audr)](https://pypi.org/project/audr/) | [`python/README.md`](python/README.md) |
| [TypeScript](typescript/) | [![npm](https://img.shields.io/npm/v/audr?include_prereleases&label=audr)](https://www.npmjs.com/package/audr) | [`typescript/README.md`](typescript/README.md) |

## How the parts fit

```
runtime events ──▶ adapter ──▶ client.record() ──▶ Client ──▶ sink.deliver() ──▶ destination
                                                   validates, batches, accounts
```

An [adapter](../README.md) observes an agent runtime and calls `client.record()` for each
metered operation. The `Client` validates each record, stamps the emitter, batches, and
hands each batch to one [sink](../../sinks/README.md). The core defines both boundaries and
implements neither side: adapters and sinks are separate packages.

## Rules every core implementation follows

1. **The core is destination-neutral.** It models and validates records and delivers them
   through the sink contract. Sinks and adapters are separate packages, so an
   implementation of the standard depends only on what it uses.
2. **The schema has a single source.** [`spec/audr.schema.json`](../../spec/audr.schema.json)
   is the one copy. A core validates with native types and tests those against it.
3. **Conformance is shared.** Every core runs [`conformance/`](../../conformance/README.md) —
   the same fixtures with the same expected outcomes. That is the definition of done.

## The sink contract

A sink implements two asynchronous operations. The notation below is Python, the reference
implementation; the outcomes and guarantees are the same in every language.

```python
class Sink(Protocol):
    async def deliver(self, batch: Sequence[AUDR]) -> BatchResult: ...
    async def close(self) -> None: ...        # idempotent; never raises
```

The pipeline guarantees a sink that a batch is never empty, never exceeds the client's
`batch_max_size`, arrives one at a time, and that an answered batch is never re-sent. The
sink answers with a `BatchResult`:

```python
class BatchOutcome(StrEnum):
    ACCEPTED, RETRYABLE_FAILURE, PERMANENT_FAILURE, CLOSED

class BatchResult:
    outcome: BatchOutcome
    rejected: Sequence[RejectedRecord] = ()   # meaningful with ACCEPTED
    unknown: Sequence[str] = ()               # record_ids; meaningful with ACCEPTED
    detail: str | None = None
```

| Outcome | Meaning | Effect on each record in the batch |
| --- | --- | --- |
| `ACCEPTED` | The sink took the batch. `rejected` and `unknown` name any records inside it that were not actually delivered. | Everything not named in `rejected`/`unknown` is `sent`. A named `rejected` record is `dropped` (not retryable). A named `unknown` record is `unknown` — the sink could not confirm delivery, so a replay keyed on `record_id` is safe. |
| `RETRYABLE_FAILURE` | The whole batch failed for a reason that may succeed later (a timeout, a `5xx`, a rate limit). | Every record in the batch is `dropped`; the pipeline never retries itself, so retrying is the sink's own responsibility inside `deliver()`. |
| `PERMANENT_FAILURE` | The whole batch failed for a reason that will not change on retry (bad credentials, a malformed request). | Every record in the batch is `dropped`. |
| `CLOSED` | The sink is closed and cannot accept the batch. | Every record in the batch is `dropped`. |

A sink never retries at the pipeline level and never raises out of `deliver()` or `close()`
for an ordinary delivery failure — it reports the outcome instead.
`audr.testing.assert_sink_contract()` checks a sink against these rules; every sink in this
repository runs it in its own test suite.

## Delivery states

Every record admitted through `client.record()` ends in exactly one terminal state:

| State | Meaning |
| --- | --- |
| `sent` | A sink accepted it. |
| `dropped` | It was not delivered and will not be: validation failed, the queue was full, the batch failed, or the sink rejected it by name. |
| `unknown` | A sink could not confirm delivery. `unknown` is terminal and never relabelled; a consumer that de-duplicates on `record_id` can replay safely. |

`DeliveryStats` counts the three; the `on_failure` and `on_delivered` callbacks report them
per record and per batch.

## Contributing

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — implementing an adapter, and the rules an
  adapter must follow when it feeds this client.
- [`../../sinks/CONTRIBUTING.md`](../../sinks/CONTRIBUTING.md) — implementing a sink against
  the contract above.
- [`python/AGENTS.md`](python/AGENTS.md) — working inside the Python package.
- [`typescript/AGENTS.md`](typescript/AGENTS.md) — working inside the TypeScript package.
