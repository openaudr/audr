# AGENTS.md

Directives for working inside this package. Tier-wide directives are in
[`adapters/AGENTS.md`](../../AGENTS.md); repository setup, the shared Python toolchain and
the contribution process are in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

## What this is

`adapters/langfuse/python` is the `audr-adapter-langfuse` distribution: an OpenTelemetry
`SpanProcessor` that observes ended Langfuse SDK spans and hands attributed `AUDR` records to
an `audr.Client` the host application owns. The host owns the `TracerProvider`, the Langfuse
client, the AUDR client, its sink and their shutdown order.

Update [`docs/reference.md`](docs/reference.md) when public behaviour changes.
`make examples` runs `examples/observe_generation.py` offline.

## Working rules

1. Read only the attributes listed in `_mapping.py`. Never read
   `langfuse.observation.input` or `langfuse.observation.output`, and never copy a metadata
   value other than the `audr_*` keys and `ls_provider`.
2. Meter only spans that carry `langfuse.observation.type`. Emit a generation or embedding
   only when it reports usage or a cost; a zero cost counts only on a successful span. Never
   infer usage from absence.
3. Bill a nested model call once: a model span whose direct model child produced a record is
   not recorded. Bound the remembered parents by `max_tracked_spans`, evicting the oldest, and
   never track a remote parent. A span inherits the `audr_*` observation metadata of its open
   ancestors, under its own, so the billed child keeps the attribution set on its parent.
4. Never guess the provider from the model name. An unresolved provider skips the record.
5. Never copy Langfuse's `user.id` to `attribution.user_id`; it is commonly an email.
6. Spans end on whichever thread ran the work, so every record crosses to the client's loop
   through the bounded bridge. Never block in `on_end`.
7. `shutdown()` stays a no-op so that `drain()` works after the provider shuts down. The
   shutdown order is: stop work, `langfuse.shutdown()` (or `langfuse.flush()`),
   `await processor.drain()`, `processor.close()`, then the client.
8. Logs carry stable paths and outcomes only, never attribute values.
9. `langfuse` and `opentelemetry-sdk` are the `runtime` extra. A plain
   `import audr_adapter_langfuse` must not import OpenTelemetry; accessing
   `LangfuseAudrProcessor` is the activation boundary.

## Verification

Run `make verify` from this directory. Runtime tests drive the real Langfuse SDK with an
in-memory span exporter; tests must not require Langfuse credentials or make network calls.
