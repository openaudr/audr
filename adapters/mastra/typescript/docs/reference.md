# Reference

The full reference for `@openaudr/audr-adapter-mastra`. Installation, usage and
attribution are in the [README](../README.md).

## Options

`new AudrExporter(options)` returns a Mastra `ObservabilityExporter` named `audr`.

| Option | Type | Default | Behaviour |
| --- | --- | --- | --- |
| `client` | `Client` from `@openaudr/audr` | Required | Receives every record through `client.record()`. The exporter's `flush()` calls `client.flush()`; its `shutdown()` leaves the client open. |
| `attributionDefaults` | `Attribution` | None | Applied field by field under each span's `metadata.audr`; `labels` merge by key. Omit `environment` to require it on every call. |
| `logger` | `{ warn(message), error(message) }` | The Mastra instance's logger once the exporter is registered | Receives [diagnostics](#diagnostics). When set, it is used instead of Mastra's logger. |

`AudrExporter` throws `ConfigurationError` when `client` has no `record()` or no `flush()`
method. Nothing else in the package throws.

## Records

| Mastra span (`span_ended`) | `resource.operation` | `resource.type` | `usage` |
| --- | --- | --- | --- |
| `model_inference` | `generation` | `model` | `llm` |
| `rag_embedding` | `embedding` | `model` | `llm` |
| `tool_call`, `mcp_tool_call` | `tool_execution` | `tool` | `tool: { type: 'invocation', call_count: 1 }` |

Each `model_inference` is one call to the model provider. `model_generation` and
`model_step` repeat the same usage at coarser levels, and `model_chunk` carries none, so
none of them is metered.

### Tokens

`usage.llm` on a `generation` record is derived from the span's `UsageStats`, whose
`inputTokens` includes cache reads and writes and whose `outputTokens` includes reasoning:

| AUDR counter | Source |
| --- | --- |
| `input_tokens` | `inputTokens` minus `inputDetails.cacheRead` and `inputDetails.cacheWrite` |
| `cache_read_tokens` | `inputDetails.cacheRead` |
| `cache_write_tokens` | `inputDetails.cacheWrite` |
| `output_tokens` | `outputTokens` minus `outputDetails.reasoning` |
| `reasoning_tokens` | `outputDetails.reasoning` |
| `requests` | `1` for each `model_inference` or `rag_embedding` |

Audio and image tokens stay inside `input_tokens` and `output_tokens`, because AUDR has no
separate counter for them. A counter Mastra did not report is omitted, not zeroed. A
provider call that reports no token counters still produces a record with `requests: 1`.
`totalTokens` and cost are never written; Mastra's estimated cost is not read.

### Resource

- **Model calls.** `resource.name` is `responseModel` when set, otherwise `model`.
  `resource.modality` is `text`. `resource.provider` follows the
  [provider slugs](#provider-slugs) rules.
- **Embeddings.** `resource.name` is `model`, `resource.operation` is `embedding` and
  `resource.modality` is `text`.
- **Tools.** `resource.provider` is `self-hosted` and `resource.name` is the tool name
  (`entityName`). A `tool_call` with a direct `agent_run` or `workflow_run` child is the
  call through which an agent invokes a sub-agent or a workflow. It produces no tool record;
  the sub-agent's or workflow's own operations are metered. This includes a user-defined
  tool whose execution runs an agent or a workflow in the same trace.

A span with no valid provider slug, no model name or no tool name is skipped with
`RESOURCE_UNRESOLVED`.

### Identifiers

| Field | Value |
| --- | --- |
| `run.run_id` | Mastra `traceId`, so sub-agents in the same trace share a run |
| `run.trace_id` | The same `traceId` when it is 32 lowercase hexadecimal digits, the W3C trace id form |
| `run.span_id` | The span id |
| `run.parent_span_id` | The parent span id, when the span has one |
| `run.error_code` | `MASTRA_TOOL_ERROR` on a failed tool call; `MASTRA_MODEL_ERROR` on a failed model inference or embedding |

`run.run_id` must be 8 to 64 characters, so the `Client` rejects the records of a call whose
caller-supplied `tracingOptions.traceId` is shorter than 8 characters. An error itself is
never read. The `@openaudr/audr` SDK mints `record_id`, and the `Client` stamps its own
`emitter`.

### Timing

`timing.event_time` is when the span ended; without a valid end it is the start, and
without either it is the time the record is built.
`timing.duration_ms` is the span's wall time when both ends are valid.

## Provider slugs

`resource.provider` must match `^[a-z0-9-]+$`. The span's provider is the model router's
provider (`openai` for `openai/gpt-5.4`, and the upstream provider for a gateway id such as
`netlify/openai/gpt-4o`) or, for an AI SDK model instance, its provider id
(`openai.responses`). It is mapped in this order:

1. The alias table below. Each prefix matches itself and every `<prefix>.<api>` id.
2. The text before the first `.`, lowercased, with other characters replaced by `-`:
   `openai.responses` becomes `openai`, `anthropic.messages` becomes `anthropic`.

| AI SDK provider id | `resource.provider` |
| --- | --- |
| `gateway` | `vercel-ai-gateway` |
| `azure` | `azure-openai` |
| `amazon-bedrock`, `bedrock`, `bedrock-mantle` | `aws-bedrock` |
| `google.vertex`, `googleVertex`, `vertex` | `google-vertex` |

The table matches the Vercel AI SDK adapter's, so records from both adapters join on
`resource.provider`.

## Diagnostics

Diagnostics go to the `logger` option when set, otherwise to the Mastra instance's logger.
Each message has the form
`@openaudr/audr-adapter-mastra: <CODE> (<key>=<value>, ...)` and carries span types, setting
names, submit outcomes, issue paths and error class names only, never a record value or an
error message. The `DiagnosticCode` type lists every code.

| Code | Level | Logged when | Action |
| --- | --- | --- | --- |
| `ATTRIBUTION_UNRESOLVED` | warn | A metered span has no `environment` in its merged attribution; it is not metered | Set `environment` in `attributionDefaults` or `metadata.audr` |
| `RESOURCE_UNRESOLVED` | warn | A model or embedding span has no valid provider slug or model name, or a tool span has no name; the record is skipped | Check the model's provider id against [provider slugs](#provider-slugs) |
| `RECORD_NOT_QUEUED` | warn | The `Client` rejects or drops a record; `issues` lists each `<code>@<path>` | Fix the attribution the issue path names, or check that the client is running |
| `CONFIG_DROPS_SPANS` | warn | At registration, `sampling.type` is not `always`, `includeInternalSpans` is not `true`, or `excludeSpanTypes` lists a metered span type, `agent_run` or `workflow_run`; `setting` names which | Change the observability configuration |
| `EXPORT_FAILED` | error | An exception while exporting a span or flushing the client; Mastra continues | Report it as a bug, with the error class |

An error class is one of the built-in `Error` subclasses, `Error`, the `typeof` of a thrown
non-error, or `unknown`. `error.name` and `error.message` are never read, because both are
writable and may carry prompt or record values.

## Not metered

- `model_generation`, `model_step`, `model_chunk`, and every span type other than
  `model_inference`, `rag_embedding`, `tool_call` and `mcp_tool_call`.
- Mastra internal spans unless observability is configured with `includeInternalSpans: true`.
- A `tool_call` through which an agent invokes a sub-agent or a workflow, identified by a
  direct `agent_run` or `workflow_run` child. The sub-agent's or workflow's own operations
  are metered.
- Provider-executed tools, and client-side tools Mastra does not surface as `tool_call` or
  `mcp_tool_call` spans.
- Spans dropped by sampling, `excludeSpanTypes` or a `spanFilter`.

## Operational bounds

- The exporter builds records from `span_ended` events and hands each one to
  `client.record()` before `exportTracingEvent` returns. It holds no records between events;
  it tracks the ids of open `tool_call` spans until they end, to recognise a direct
  `agent_run` or `workflow_run` child.
- `exportTracingEvent` and `flush` never throw into Mastra; an exception is logged as
  `EXPORT_FAILED`.
- `Client.record()` validates every record value and never throws. A record it does not
  queue is logged as `RECORD_NOT_QUEUED` with the outcome and each issue as `<code>@<path>`.

## Runtime support

The adapter is tested on Node.js 22, 24 and 26 and imports no Node API.
