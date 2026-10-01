# Reference

The full reference for `@openaudr/audr-adapter-vercel-ai`. Installation, usage and
attribution are in the [README](../README.md).

## Options

`audrTelemetry(options)` returns an AI SDK `Telemetry` integration.

| Option | Type | Default | Behaviour |
| --- | --- | --- | --- |
| `client` | `Client` from `@openaudr/audr` | Required | Receives every record through `client.record()`. The adapter never creates, flushes or shuts it down. |
| `attributionDefaults` | `Attribution` | None | Applied field by field under each call's `runtimeContext.audr`; `labels` merge by key. Omit `environment` to require it on every call. |
| `mapResource` | `({ provider, modelId }) => { provider, name } \| null \| undefined` | None | Overrides `resource.provider` and `resource.name` for a model call. Returning `null` or `undefined` keeps the default mapping. A throw skips the record. |
| `logger` | `{ warn(message), error(message) }` | Discards diagnostics | Receives [diagnostics](#diagnostics). Pass `console` to print them. |

`audrTelemetry` throws `ConfigurationError` when `client` has no `record()` method. Nothing
else in the package throws.

## Records

| AI SDK event | `resource.operation` | `resource.type` | `usage` |
| --- | --- | --- | --- |
| Each provider model call: one per step of a tool loop, one per stream | `generation` | `model` | `llm` |
| Each client-side tool `execute` | `tool_execution` | `tool` | `tool: { type: 'invocation', call_count: 1 }` |
| Each embedding provider call: one per `embed`, one per `embedMany` chunk | `embedding` | `model` | `llm: { input_tokens?, requests: 1 }` |
| Each `rerank` provider call | `reranking` | `model` | `llm: { requests: 1 }` |

### Tokens

`usage.llm` on a `generation` record is derived from the AI SDK `LanguageModelUsage`:

| AUDR counter | Source |
| --- | --- |
| `input_tokens` | `inputTokenDetails.noCacheTokens`, or `inputTokens` minus cache reads and writes |
| `cache_read_tokens` | `inputTokenDetails.cacheReadTokens` |
| `cache_write_tokens` | `inputTokenDetails.cacheWriteTokens` |
| `output_tokens` | `outputTokenDetails.textTokens`, or `outputTokens` minus reasoning tokens |
| `reasoning_tokens` | `outputTokenDetails.reasoningTokens` |
| `requests` | Always `1` |

A counter the provider did not report is omitted, not zeroed. `totalTokens` and cost are
never written; rating happens downstream. An `embedding` record carries `input_tokens` from
the embedding usage when the provider reports it.

### Resource

- **Model calls.** `resource.name` is the model id from the AI SDK end event (for language
  models, the id the provider echoed in its response). `resource.modality` is `text`.
  `resource.provider` follows the [provider slugs](#provider-slugs) rules.
- **Tools.** `resource.provider` is `self-hosted` and `resource.name` is the tool name. A
  tool that throws produces a record with `run.error_code` `VERCEL_AI_TOOL_ERROR`, exported
  as `TOOL_ERROR_CODE`; the error itself is never read.

### Identifiers

| Field | Value |
| --- | --- |
| `run.run_id` | The AI SDK `callId` of the root call |
| `run.span_id` | `model:<callId>:<n>`, `tool:<callId>:<n>:<toolCallId>`, `embed:<embedCallId>` or `rerank:<callId>:<n>` |
| `run.parent_span_id` | The spawning tool's span, on every record of a [sub-agent](#sub-agents) call |
| `run.step` | A run-wide ordinal in emission order |
| `run.run_type` | `agent_run` for `generateText` and `streamText`; `single_call` for embedding and reranking |
| `run.name` | `telemetry.functionId`, when set |

`<n>` is a per-call invocation counter, so span ids stay unique when a provider reuses a
tool call id. A record the `Client` does not queue still takes its `run.step`, so a gap in
the sequence marks an undelivered record. The `@openaudr/audr` SDK mints `record_id`, and
the `Client` stamps its own `emitter`.

### Timing

`timing.event_time` is the moment the adapter builds the record: when the provider call,
tool execution, embedding call or rerank call ends. `timing.duration_ms` is the provider
response time for a model call, the tool's execution time, or the wall time of the
embedding or rerank call.

### Sub-agents

An AI SDK call started inside a tool's `execute` joins the calling run. Its records reuse
the parent's `run.run_id`, set `run.parent_span_id` to the tool's span, share the parent's
`run.step` sequence, and inherit the parent's attribution, run type and name. The inner
call's own `runtimeContext.audr` is ignored, so a sub-agent cannot bill its work to another
account. Only a call metered by the same `audrTelemetry()` instance joins; a call metered
by another instance starts its own run.

## Provider slugs

`resource.provider` must match `^[a-z0-9-]+$`. The AI SDK provider id is mapped in this
order:

1. `mapResource({ provider, modelId })`, when it is given and returns a mapping.
2. The alias table below. Each prefix matches itself and every `<prefix>.<api>` id.
3. The text before the first `.`, lowercased, with other characters replaced by `-`:
   `openai.responses` becomes `openai`, `anthropic.messages` becomes `anthropic`.

| AI SDK provider id | `resource.provider` |
| --- | --- |
| `gateway` | `vercel-ai-gateway` |
| `azure` | `azure-openai` |
| `amazon-bedrock`, `bedrock`, `bedrock-mantle` | `aws-bedrock` |
| `google.vertex`, `googleVertex`, `vertex` | `google-vertex` |

A provider that maps to no valid slug is skipped with `PROVIDER_UNMAPPED`. A throwing
`mapResource` skips the record with `MAP_RESOURCE_FAILED` rather than falling back to the
default slug.

In AI SDK 7 a string model id such as `'openai/gpt-5.4'` resolves to the Vercel AI Gateway,
so the record has `resource.provider` `vercel-ai-gateway` and `resource.name`
`openai/gpt-5.4`, because the gateway meters and bills the call. To attribute such calls to
the model vendor instead:

```ts
audrTelemetry({
  client, // client: see the README's Usage section
  mapResource: ({ provider, modelId }) => {
    if (provider !== 'gateway') return undefined;
    const slash = modelId.indexOf('/');
    return slash > 0
      ? { provider: modelId.slice(0, slash), name: modelId.slice(slash + 1) }
      : undefined;
  },
});
```

## Diagnostics

The adapter logs nothing unless `logger` is given. Each message has the form
`@openaudr/audr-adapter-vercel-ai: <CODE> (<key>=<value>, ...)` and carries AI SDK operation
ids, hook names, error class names, submit outcomes and issue paths only, never a record
value or an error message. The `DiagnosticCode` type lists every code.

| Code | Level | Logged when | Action |
| --- | --- | --- | --- |
| `ATTRIBUTION_UNRESOLVED` | warn | An operation starts with no `environment` in its merged attribution; it is not metered | Set `environment` in `attributionDefaults` or `runtimeContext.audr`, and check `includeRuntimeContext: { audr: true }` |
| `RECORD_NOT_QUEUED` | warn | The `Client` rejects or drops a record; `issues` lists each `<code>@<path>` | Fix the attribution the issue path names, or check that the client is running |
| `PROVIDER_UNMAPPED` | warn | The provider slug, default or from `mapResource`, does not match `^[a-z0-9-]+$`; the record is skipped | Return a valid mapping from `mapResource` |
| `MAP_RESOURCE_FAILED` | warn | `mapResource` throws; the record is skipped | Fix `mapResource` |
| `OPERATION_UNSUPPORTED` | warn | The first `generateObject` call, and the first `streamObject` call, of each integration | Use `generateText` or `streamText` with `output` |
| `HOOK_FAILED` | error | An exception inside a hook; the AI SDK call continues | Report it as a bug, with the hook name and error class |

## Not metered

- Tokens of a model call aborted mid-stream: the AI SDK reports no end event for it.
- A provider attempt that fails and is retried: only the attempt that succeeds is reported.
- Provider-executed tools, such as a provider-hosted web search; the provider's own records
  cover them.
- The deprecated `generateObject` and `streamObject`.
- Image, speech, transcription, video and realtime models, and `experimental_evaluate`.
- Calls with `telemetry: { isEnabled: false }`, or with per-call `integrations` that omit
  this integration.
- Per-call attribution on a call without `includeRuntimeContext: { audr: true }`.

## Operational bounds

- Each hook hands its record to `client.record()` before it returns, so the adapter holds
  no records and has no `drain()` or `close()`. Shut down by stopping new AI SDK calls,
  awaiting the ones in flight, then awaiting `client.shutdown()`.
- The adapter holds a small state for each operation, sub-agent calls included, from
  `onStart` until the AI SDK reports its end, abort or error. An operation the AI SDK never
  ends, such as a stream abandoned without being read to the end or aborted, is held until
  the process exits.
- Hooks never throw into the AI SDK, and `executeTool` returns exactly what the tool's
  `execute` returns, including its rejection.

## Runtime support

The adapter is tested on Node.js 22, 24 and 26. Its only runtime API is
`AsyncLocalStorage` from `node:async_hooks`, used to join sub-agent calls. Runtimes that
provide it, such as Bun, Deno, Vercel Edge Functions and Cloudflare Workers with the
`nodejs_compat` flag, are expected to work but are not tested.
