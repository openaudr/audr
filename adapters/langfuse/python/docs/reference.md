# Reference

Complete behaviour of `audr-adapter-langfuse`. The
[README](https://github.com/openaudr/audr/blob/main/adapters/langfuse/python/README.md)
covers setup and usage.

## Options

`LangfuseAudrProcessor` takes keyword arguments only.

| Argument | Default | Purpose |
| --- | --- | --- |
| `client` | required | The `audr.Client` that receives every record |
| `config` | `LangfuseConfig()` | Attribution defaults, fallback provider and handoff bound |
| `loop` | the running loop | The event loop that owns `client`; pass it when constructing off that loop |

Construction raises `LangfuseActivationError` when no running loop is available, and
importing `LangfuseAudrProcessor` raises it when the `runtime` extra is not installed.

`LangfuseConfig` is a frozen Pydantic model.

| Field | Default | Purpose |
| --- | --- | --- |
| `attribution_defaults` | `Attribution()` | Values every record starts from; may be partial |
| `provider` | `None` | Provider slug (`^[a-z0-9-]+$`) for a generation or embedding whose span names none |
| `max_pending_handoffs` | `1000` | Records waiting to reach the client loop, 1 to 100000 |
| `max_tracked_spans` | `10000` | Open spans, and parents of nested model calls, remembered at once; 1 to 1000000 |

An `attribution_defaults` value that can never be billed, such as a non-pseudonymous
`user_id`, or a `provider` that is not a slug, raises `pydantic.ValidationError` at
construction.

## Wiring

The processor is an OpenTelemetry `SpanProcessor`. Add it to the `TracerProvider` passed to
`Langfuse(tracer_provider=...)`, or to the global provider after the Langfuse client has
registered one. Langfuse's `should_export_span` filter does not apply to it.

The processor sees only spans the provider records:

- When the host passes its own `TracerProvider`, that provider's sampler decides; Langfuse's
  `sample_rate` applies only to the provider Langfuse builds itself. Sample every billed
  trace.
- When the Langfuse client is disabled, because its keys are missing or
  `tracing_enabled=False`, it creates no spans and no record is produced.

## Span metadata

Attribution is read from `audr_*` keys in observation metadata and in trace metadata set
with `propagate_attributes(metadata=...)`. The Langfuse SDK JSON-encodes every metadata
value, and the adapter decodes it.

| Key | Attribution field |
| --- | --- |
| `audr_environment` | `environment` |
| `audr_account_id` | `account_id` |
| `audr_subscription_id` | `subscription_id` |
| `audr_user_id` | `user_id` |
| `audr_feature_id` | `feature_id` |
| `audr_labels` | `labels`, an object of string values |

Each field resolves from the first source that sets it: the span's observation metadata,
the observation metadata of the spans still open around it (nearest first), trace metadata,
`langfuse.environment` (for `environment` only), then `attribution_defaults`. `labels` merge
by key across the same sources, in that order of precedence for a shared key. Metadata set
on an enclosing observation, such as the `metadata` of a LangChain call, therefore reaches
the model span inside it; see [Nested model calls](#nested-model-calls). An enclosing span
forgotten under `max_tracked_spans` contributes nothing. A merged map above the
specification's 20-label limit skips the record.

`langfuse.environment` is used when it is an AUDR environment (`production`, `staging`,
`development`, `test`, `evaluation`). Langfuse's experiment environment, `sdk-experiment`,
becomes `evaluation`. Any other value, including Langfuse's default `default`, is ignored.

Langfuse's trace `user.id` is never read.

## Records

### Resource

| `langfuse.observation.type` | `resource.operation` | `resource.type` | `resource.provider` | `resource.name` |
| --- | --- | --- | --- | --- |
| `generation` | `generation` | `model` | resolved below | model name |
| `embedding` | `embedding` | `model` | resolved below | model name |
| `tool` | `tool_execution` | `tool` | `self-hosted` | span name |
| `retriever` | `retrieval` | `tool` | `self-hosted` | span name |

The model name is `langfuse.observation.model.name`, falling back to
`gen_ai.response.model`, then `gen_ai.request.model`. Langfuse records no modality:
`resource.modality` is `multimodal` when any usage count whose key names audio, image or
video is positive (`input_audio`, `input_modality_IMAGE`, `cached_modality_AUDIO`,
`*_tokens_details.audio_tokens`), and `text` otherwise, including for a cost-only record.

The provider is the first of `gen_ai.provider.name`, `gen_ai.system`, the LangChain
handler's `ls_provider` observation metadata, and `LangfuseConfig.provider`, lowercased with
runs of other characters replaced by `-`. It is never derived from the model name.

### Tokens

Every model record carries `usage.llm.requests: 1`. A counter the integration did not
report is omitted rather than zeroed.

Langfuse's own buckets (`input`, `output` and their `input_*` / `output_*` details) are
exclusive:

- Cache reads come from `cache_read_input_tokens`, `input_cached_tokens` or
  `input_cache_read`, else the sum of Vertex AI `cached_modality_*` buckets. Cache writes
  come from `cache_creation_input_tokens` or `input_cache_creation`. Reasoning comes from
  `output_reasoning_tokens` or `output_reasoning`.
- `output_tokens` is `output` plus every other `output_*` bucket, such as audio or modality
  counts.
- `input_tokens` is `input` plus every other `input_*` bucket, or, when larger, `total` minus
  the output, reasoning, cache-read and cache-write counts. The LangChain handler clamps
  `input` at zero after subtracting its details, so `total` can be the only source of
  uncached input; taking the larger value means a `total` that disagrees with the buckets
  never lowers the count.
- Priority-tier buckets and Anthropic cache-tier buckets (`*_ephemeral_*`) repeat other
  counts and are not added.

Raw provider usage, as the `langfuse.openai` drop-in records it, is recognised by
`prompt_tokens`, `completion_tokens`, `input_tokens` or `output_tokens`:

- OpenAI totals (`prompt_tokens`, or `input_tokens` with detail objects) include cached,
  cache-write and reasoning tokens, which are subtracted. Cache reads come from
  `*_tokens_details.cached_tokens` or `cache_read_input_tokens`; cache writes from
  `*_tokens_details.cache_creation_tokens`, `cache_write_tokens` or
  `cache_creation_input_tokens`; reasoning from `*_tokens_details.reasoning_tokens`.
- Anthropic usage (`input_tokens` without detail objects) is already exclusive of its
  top-level `cache_read_input_tokens` and `cache_creation_input_tokens`.

### Cost

`langfuse.observation.cost_details` on a generation or embedding becomes `cost.total_cost`
with `cost.currency` `USD`: its `total`, or the sum of its values when `total` is absent.
A negative or non-finite value marks the span malformed. Langfuse's server-side inferred
cost never reaches the span. A zero cost on a failed span is dropped, because the OpenAI
drop-in writes an all-zero cost on failure.

### Run

`run.run_id` and `run.trace_id` are the OpenTelemetry trace id as 32 hex digits;
`run.span_id` and `run.parent_span_id` are span ids as 16 hex digits. A span with status
`ERROR` or `langfuse.observation.level` `ERROR` carries
`run.error_code = LANGFUSE_OBSERVATION_ERROR` (`LangfuseRunErrorCode.OBSERVATION_ERROR`);
status messages are never copied.

### Nested model calls

Some integrations record one model call twice, as a model span inside another: importing
the `langfuse.openai` drop-in patches the OpenAI SDK that LangChain's `ChatOpenAI` calls, so
one call becomes a `ChatOpenAI` generation with an `OpenAI-generation` child carrying the
same usage. When a model span produces a record, its parent is remembered, and a parent
model span that ends after it is not recorded. The innermost model span that produced a
record is billed:

- If the child produced no record, for example because it reported no usage or no provider
  resolved, the parent is recorded.
- A tool or retriever span is never suppressed, and never suppresses its parent.
- Only the direct parent is checked, and a parent in another process is not tracked.
- The billed child carries the `audr_*` metadata of the open spans around it, so the
  `metadata` passed to a LangChain call applies to the drop-in span that is recorded.

At most `max_tracked_spans` parents are remembered at once. Beyond that the oldest is
forgotten; it is normally a parent that ended before its child and will never be looked up.
Should a forgotten parent still be open, that one call is recorded twice.

### Timing and emitter

`timing.event_time` is the span end, truncated to milliseconds, and `timing.duration_ms`
its wall time. `emitter.name` is `audr-adapter-langfuse` and `emitter.version` is this
package's release.

## Not metered

- Spans without `langfuse.observation.type`, including third-party OpenTelemetry spans, and
  the types `span`, `agent`, `chain`, `event`, `evaluator` and `guardrail`.
- Generations and embeddings with no recognised usage and no cost, such as streams without
  usage or the OpenAI drop-in's failure path. These skips are not logged.
- Generations and embeddings with no resolvable provider or model, and tool or retriever
  spans with an empty name.
- A model span whose nested model span already produced a record; see
  [Nested model calls](#nested-model-calls).
- Audio duration and image counts, which Langfuse does not record.

## Shutdown order

1. Stop starting observed work and let in-flight observations end.
2. Call `langfuse.shutdown()`, or `langfuse.flush()` when the client stays in use.
3. Await `processor.drain(timeout=...)` so accepted handoffs reach `client.record()`. It
   raises `TimeoutError` when they cannot arrive in time, and `LangfuseActivationError`
   after `close()` or off the client's loop.
4. Call `processor.close()`, then shut down the client so its queue and sink drain.

`processor.shutdown()`, which `TracerProvider.shutdown()` calls, does nothing, so `drain()`
still works after the provider shuts down.

## Threads

Spans end on whichever thread ran the observed work. The adapter hands each record back to
the client's loop through a bounded, non-blocking bridge, so observed work may run in
worker threads while that loop is running. A process with no running event loop is not
supported.

## Diagnostics

The adapter logs to the `audr_adapter_langfuse._processor` logger through the standard
`logging` module. Messages carry JSON-pointer paths, attribute names and queue outcomes;
they never contain a record value, observation input or output, or a credential.

| Message | Cause |
| --- | --- |
| `Langfuse span skipped (path=...)` | Attribution, provider, model or tool name could not be resolved |
| `Langfuse span malformed (path=...)` | A usage, cost or `audr_labels` attribute did not parse |
| `Langfuse span mapping failed internally` | An unexpected error while mapping; the span is dropped |
| `Langfuse span record dropped: handoff full` | `max_pending_handoffs` records were already waiting |
| `Langfuse span record dropped: event loop unavailable` | The client's loop had stopped |
| `Langfuse span record submission failed` | `client.record()` raised |
| `Langfuse span record submission dropped (outcome=...)` | `client.record()` did not queue the record |
| `Langfuse span ignored: adapter is closed` | A span ended after `close()` |

Delivery outcomes after a record is queued belong to the client and its sink; inspect
`client.stats` and the client's delivery callbacks.

## Operational bounds

| Bound | Value |
| --- | --- |
| Records waiting to reach the client loop | `max_pending_handoffs`, default 1000; overflow drops with a warning |
| Open spans, and parents of nested model calls, remembered | `max_tracked_spans` each, default 10000; overflow forgets the oldest |
| Labels per record after merging | 20, from the specification |
| Propagated metadata value | 200 characters each, enforced by the Langfuse SDK, which drops a longer value |

## Runtime support

Python 3.11 to 3.14 and `langfuse` 5.2 or later within 5.x, through the `runtime` extra.
Spans from the Langfuse Python SDK are supported, including its OpenAI drop-in, LangChain
handler and `@observe` decorator.
