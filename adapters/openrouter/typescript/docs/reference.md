# Reference

The full reference for `@openaudr/audr-adapter-openrouter`. Installation, usage, the
choice between router metadata and a lookup, and attribution are in the
[README](../README.md).

## Options

`instrumentOpenRouter(openrouter, options)` returns a facade with the type of `openrouter`.

| Option | Type | Default | Behaviour |
| --- | --- | --- | --- |
| `client` | `Client` from `@openaudr/audr` | Required | Receives every record through `client.record()`. The adapter never creates, flushes or shuts it down. |
| `attributionDefaults` | `Attribution` | None | Applied field by field under each `withAudr` scope; `labels` merge by key. Copied when instrumenting, so later changes to the object have no effect. Omit `environment` to require it in every scope. |
| `mapResource` | `({ model, vendor }) => { provider, name } \| null \| undefined` | None | Overrides `resource.provider` and `resource.name`. Returning `null` or `undefined` keeps the default. A throw skips the record. |
| `lookup` | `{ maxWaitMs, initialDelayMs, maxDelayMs }` | `5000`, `250`, `1000` | Bounds the [lookup](#lookup). |
| `logger` | `{ warn(message), error(message) }` | Discards diagnostics | Receives [diagnostics](#diagnostics). Pass `console` to print them. |

`instrumentOpenRouter` throws `ConfigurationError` when `client` has no `record()` method or
when `openrouter` is already a facade, because a second facade would record every call
twice. Instrumenting the same native client twice gives two independent facades. Nothing
else in the package throws.

`withAudr(context, body)` runs `body` with `context` applied and returns what `body`
returns, including a rejection or exception. A `context` that cannot be read is ignored, and
`body` runs under the outer scope.

## Lookup

A Chat or Responses result carries `openrouterMetadata` only when the request sent
`xOpenRouterMetadata: 'enabled'`; an Embeddings result never does. When the result does not
name the vendor that served the call, the adapter calls `generations.getGeneration({ id })`
on the same native client, so it uses the same key, base URL and HTTP client as the host.
The SDK's own retries are turned off for the lookup, including any `retryConfig` the client
was given: the adapter retries on its own schedule, within `maxWaitMs`.

The lookup also runs when the result leaves out whether the call was BYOK, or, for a BYOK
call, the provider's own charge, because the cost cannot be completed without it.

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxWaitMs` | `5000` | The most time one lookup may take, every attempt and wait included. `0` disables the lookup. |
| `initialDelayMs` | `250` | The wait before the first retry. It doubles after each retry. |
| `maxDelayMs` | `1000` | The longest single wait. |

A value that is not a finite number of at least zero is replaced by its default.

- **It delays the call.** The record is submitted after the lookup, and the facade's promise
  resolves after the record is submitted. For a stream, the terminal event is delivered
  after the lookup. The delay is at most `maxWaitMs` and is zero when router metadata names
  the vendor.
- **It does not change the timing.** `timing.event_time` and `timing.duration_ms` are taken
  when the primary call completes, before the lookup.
- **What is retried.** OpenRouter publishes a generation's statistics shortly after the
  call, so a `404` is expected at first. The adapter retries a `404`, `408`, `429`, any `5xx`
  and a failure with no HTTP status, such as a network error. It stops at once on any other
  `4xx` (including authentication and payment failures), on a response the SDK could not
  validate, and on an invalid request.
- **The attempt deadline.** Each attempt is cut off when the total budget ends.
- **What is read.** Only `data.providerName`, `data.responseCacheSourceId`, `data.isByok`
  and `data.upstreamInferenceCost` of the response.
- **The generation id** is the `id` of the result. `getGeneration` accepts only a `gen-`
  identifier (`gen-` followed by letters, digits and `-`, 128 characters at most), so a result
  with no id, or with an id of another shape, is not looked up (`LOOKUP_FAILED` with reason
  `no_id`). A Responses result may carry such an id; its vendor then comes from router
  metadata or `mapResource`.
- **If it fails,** a record whose vendor is still unknown is written with
  `resource.provider` `openrouter` (`PROVIDER_UNRESOLVED`). When only the BYOK cost is
  incomplete, the record is written without a cost (`BYOK_COST_INCOMPLETE`).

To skip the lookup altogether, set `lookup.maxWaitMs` to `0` and send
`xOpenRouterMetadata: 'enabled'` on every Chat and Responses request. Embeddings then name
no vendor, so they are recorded as `openrouter` unless `mapResource` names one:

```ts
import { instrumentOpenRouter } from '@openaudr/audr-adapter-openrouter';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { OpenRouter } from '@openrouter/sdk';

const client = new Client(new FileSink('audr.jsonl'));
const openrouter = instrumentOpenRouter(
  new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? '' }),
  {
    client,
    attributionDefaults: { environment: 'production', account_id: 'acct_42' },
    lookup: { maxWaitMs: 0 },
    // Embeddings results never name the vendor: take it from the model's prefix.
    mapResource: ({ model, vendor }) =>
      vendor === undefined && model !== undefined
        ? { provider: model.split('/')[0] ?? 'openrouter', name: model }
        : null,
  },
);

await openrouter.embeddings.generate({
  requestBody: { model: 'openai/text-embedding-3-small', input: 'Where is order 42?' },
});
await client.shutdown();
```

Router metadata is read from the `available` endpoint whose `selected` flag is set. A call
replayed from OpenRouter's response cache is detected by the lookup alone, so a call whose
metadata already names a vendor is attributed to that vendor.

## Agent runs

A harness that already has a run id passes it in the scope, and every OpenRouter call in
the scope joins that run:

```ts
import { instrumentOpenRouter, withAudr } from '@openaudr/audr-adapter-openrouter';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { OpenRouter } from '@openrouter/sdk';

const client = new Client(new FileSink('audr.jsonl'));
const openrouter = instrumentOpenRouter(
  new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? '' }),
  { client, attributionDefaults: { environment: 'production', account_id: 'acct_42' } },
);

const ask = (content: string) =>
  openrouter.chat.send({
    chatRequest: {
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content }],
    },
    xOpenRouterMetadata: 'enabled',
  });

await withAudr(
  { run: { run_id: 'run-order-42-support', parent_span_id: 'agent:1', name: 'support-agent' } },
  async () => {
    await ask('Plan the reply.');
    await ask('Write the reply.');
  },
);
await client.shutdown();
```

- The records share `run.run_id`, carry `run.parent_span_id` and `run.name`, and have
  `run.run_type` `agent_run`. Each has its own `run.span_id`.
- A nested scope with the same `run_id` keeps the outer `parent_span_id` and `name` unless
  it sets its own, so a tool passes `{ run_id, parent_span_id: 'tool:1' }` alone. A nested
  scope with a different `run_id` starts a separate run and inherits nothing from the outer
  one.
- `run_id` must be 8 to 64 characters, or the `Client` rejects the record.

## Streams

```ts
import { instrumentOpenRouter } from '@openaudr/audr-adapter-openrouter';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { OpenRouter } from '@openrouter/sdk';

const client = new Client(new FileSink('audr.jsonl'));
const openrouter = instrumentOpenRouter(
  new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? '' }),
  { client, attributionDefaults: { environment: 'production', account_id: 'acct_42' } },
);

const stream = await openrouter.chat.send({
  chatRequest: {
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'Write a short answer.' }],
    stream: true,
  },
  xOpenRouterMetadata: 'enabled',
});
if (!(Symbol.asyncIterator in stream)) throw new Error('expected a stream');
for await (const chunk of stream) {
  if (chunk.usage !== undefined) console.log('usage chunk');
}
await client.shutdown();
```

The returned stream is the native `EventStream` behind a proxy, and every frame is yielded
unchanged and in order. The record is built from one frame and submitted before the caller
sees it:

| Stream | The frame that is recorded |
| --- | --- |
| `chat.send()` with `stream: true` | The chunk that carries `usage`. Router metadata may arrive on any chunk; the latest one seen is used when the usage chunk has none. |
| `responses.send()` with `stream: true` | `response.completed`, `response.failed` or `response.incomplete`. The latter two are recorded when their `response` carries `usage`, with an [error code](#identifiers). |

A stream that ends without a record produces nothing and logs one `STREAM_INCOMPLETE`
warning with a `reason`:

| `reason` | The stream ended because |
| --- | --- |
| `no_usage` | A Responses terminal event arrived without `usage` |
| `error_frame` | A frame carried an error and no usage chunk followed (an `error` event, or a Chat chunk with `error`) |
| `ended` | The body ended without a frame that carries `usage` |
| `failed` | Reading the stream threw |
| `abandoned` | The loop stopped early |
| `closed` | `cancel()` was called first |

A stream that is never iterated or cancelled produces neither a record nor a warning,
because no event marks it as dropped. Such a call may still be billed, so read every stream
to its end when every call must be metered.

Only async iteration (`for await`) is metered. A stream consumed through `getReader()`,
`tee()`, `pipeTo()`, `pipeThrough()` or `values()` yields its frames untouched but produces
no record and no warning.

## Records

### Tokens

`usage.llm` is derived from the result's `usage`. OpenRouter's prompt (or input) count
includes cache reads and writes, and its completion (or output) count includes reasoning:

| AUDR counter | Chat | Responses | Embeddings |
| --- | --- | --- | --- |
| `input_tokens` | `promptTokens` minus `promptTokensDetails.cachedTokens` and `promptTokensDetails.cacheWriteTokens` | `inputTokens` minus `inputTokensDetails.cachedTokens` and `inputTokensDetails.cacheWriteTokens` | `promptTokens` |
| `cache_read_tokens` | `promptTokensDetails.cachedTokens` | `inputTokensDetails.cachedTokens` | None |
| `cache_write_tokens` | `promptTokensDetails.cacheWriteTokens` | `inputTokensDetails.cacheWriteTokens` | None |
| `output_tokens` | `completionTokens` minus `completionTokensDetails.reasoningTokens` | `outputTokens` minus `outputTokensDetails.reasoningTokens` | None |
| `reasoning_tokens` | `completionTokensDetails.reasoningTokens` | `outputTokensDetails.reasoningTokens` | None |
| `requests` | Always `1` | Always `1` | Always `1` |

- A subtraction never goes below zero.
- A counter the result does not report (absent or `null`) is omitted, and nothing is
  subtracted for it. A reported zero is kept.
- `total_tokens` is never copied.

### Cost

`cost.total_cost` is in `USD`. No `cost.llm` breakdown is written.

| Call | `total_cost` |
| --- | --- |
| Not BYOK | `usage.cost`, which is what OpenRouter charged. Any upstream figure is ignored. |
| BYOK | `usage.cost` plus the provider's own charge, `usage.costDetails.upstreamInferenceCost` or, if the usage lacks it, the lookup's `upstreamInferenceCost` |
| BYOK with either part unknown, or BYOK status unknown | None: the record is written without `cost`, and `BYOK_COST_INCOMPLETE` is logged |

`usage.costDetails.serverToolCost` is already part of OpenRouter's charge and is never added.
A call that reports no `usage.cost` and is not BYOK carries no `cost`, silently. The
BYOK flag is `usage.isByok`, then the router metadata's `isByok`, then the lookup's.
`total_cost` is what OpenRouter reported for the call; reconcile billing against the
OpenRouter invoice.

### Resource

`resource.provider` is the vendor that served the call, as a slug: lowercase, with each run
of characters outside `a-z` and `0-9` replaced by one `-` (`Amazon Bedrock` becomes
`amazon-bedrock`, `Google Vertex` becomes `google-vertex`). It is `openrouter` when a lookup
shows a response-cache replay, and when the vendor cannot be resolved, including a name with
no such characters; the latter also logs `PROVIDER_UNRESOLVED`.
`resource.name` is the `model` the result reports, verbatim (`anthropic/claude-sonnet-4.5`).

`resource.modality` follows the output modalities the request declared in `modalities`
(`chatRequest.modalities`, `responsesRequest.modalities`), `text` by default, and:

| Call | Modality |
| --- | --- |
| Chat | The declared modalities, plus `audio` when audio tokens were used; `multimodal` for more than one, or when video tokens were used |
| Responses | The declared modalities only; `multimodal` for more than one |
| Embeddings | `text`, `image` or `audio` by the prompt token details that are above zero; `multimodal` for more than one, or when video or file tokens were used |

`mapResource` receives the `model` and the vendor as OpenRouter names it (`vendor`, which is
`undefined` when it could not be resolved), and may return both fields of the resource:

```ts
import { instrumentOpenRouter } from '@openaudr/audr-adapter-openrouter';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { OpenRouter } from '@openrouter/sdk';

const client = new Client(new FileSink('audr.jsonl'));
const openrouter = instrumentOpenRouter(
  new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? '' }),
  {
    client,
    attributionDefaults: { environment: 'production', account_id: 'acct_42' },
    // Price every call by OpenRouter itself rather than by the vendor behind it.
    mapResource: ({ model }) => (model === undefined ? null : { provider: 'openrouter', name: model }),
  },
);

await openrouter.chat.send({
  chatRequest: {
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'Where is order 42?' }],
  },
  xOpenRouterMetadata: 'enabled',
});
await client.shutdown();
```

A mapped `provider` must match `^[a-z0-9-]+$`, or the `Client` rejects the record with
`RECORD_NOT_QUEUED`. A `mapResource` that throws skips the record with `HOOK_FAILED` rather
than falling back to the default. A call with no model name, reported or mapped, is skipped
with `MODEL_UNREPORTED`.

### Identifiers

| Field | Value |
| --- | --- |
| `run.run_id` | The scope's `run_id`; otherwise the result `id`, or a fresh UUIDv7 when the result has no id or the id is outside 8 to 64 characters |
| `run.span_id` | `chat:<id>`, `response:<id>` or `embedding:<id>`, with the result id or the UUIDv7 that was generated |
| `run.parent_span_id` | The scope's `parent_span_id` |
| `run.name` | The scope's `name` |
| `run.run_type` | `agent_run` inside a run scope; `single_call` otherwise |
| `run.error_code` | `OPENROUTER_RESPONSE_FAILED` (`RESPONSE_FAILED_CODE`) or `OPENROUTER_RESPONSE_INCOMPLETE` (`RESPONSE_INCOMPLETE_CODE`), for a Responses result with that `status`, or a `response.failed` or `response.incomplete` event, that carries usage |

`run.step`, `run.trace_id` and `run.outcome` are never written. A run can span several
scopes, processes and concurrent calls, so a call's position is undefined; order records by
`timing.event_time`. `emitter` is the adapter as a `router`. The `@openaudr/audr` SDK mints
`record_id`.

### Timing

`timing.event_time` is when the primary call completed, or, for a stream, when its terminal
frame arrived. `timing.duration_ms` is the time from the start of the call to that moment.
Neither includes the lookup.

## Diagnostics

The adapter logs nothing unless `logger` is given. Each message has the form
`@openaudr/audr-adapter-openrouter: <CODE> (<key>=<value>, ...)` and carries the operation
(`chat.send`, `responses.send` or `embeddings.generate`), submit outcomes, issue paths,
lookup and stream reasons, and error categories only, never a record value, an id, a model
name or an error message. The `DiagnosticCode` type lists every code.

| Code | Level | Logged when | Action |
| --- | --- | --- | --- |
| `ATTRIBUTION_UNRESOLVED` | warn | A call starts with no `environment` in its attribution; it is not metered | Set `environment` in `attributionDefaults` or the `withAudr` scope |
| `PROVIDER_UNRESOLVED` | warn | Neither the result, the lookup nor `mapResource` names a vendor; the record is written with `resource.provider` `openrouter` | Send `xOpenRouterMetadata: 'enabled'`, raise the lookup budget, or return a provider from `mapResource` |
| `LOOKUP_FAILED` | warn | The [lookup](#lookup) produced nothing, with a `reason`: `disabled` (`maxWaitMs: 0`), `no_id` (the result has no id that `getGeneration` accepts), `rejected` (a failure that waiting cannot fix) or `exhausted` (the budget ran out) | Check the key's access to `generations`, or raise `maxWaitMs` |
| `BYOK_COST_INCOMPLETE` | warn | A call's cost is withheld because its BYOK status or the provider's charge is unknown | Send `xOpenRouterMetadata: 'enabled'` or allow the lookup |
| `MODEL_UNREPORTED` | warn | A result names no model and `mapResource` supplies none; the record is skipped | Return a name from `mapResource` |
| `USAGE_UNREPORTED` | warn | A result has no `usage` object; the record is skipped | None: OpenRouter reported no usage |
| `STREAM_INCOMPLETE` | warn | A stream ends without a record, with the [`reason`](#streams) | Read streams to their end |
| `RECORD_NOT_QUEUED` | warn | The `Client` does not queue a record; `issues` lists each `<code>@<path>` | Fix the attribution or mapping the issue path names, or check that the client is running |
| `HOOK_FAILED` | error | A metering step throws: `mapResource`, a `record()` that throws, an OpenRouter client without `generations.getGeneration()`, or the adapter itself. The native call continues | Fix `mapResource` or the client, or report a bug with the error category |

An error category is `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError` or `Error`,
the `typeof` of a thrown non-error, or `unknown`. `error.name` and `error.message` are
never read, because both are writable and may carry prompt or record values.

## Privacy

The adapter reads these fields and no others. `tests/privacy.test.ts` plants a sentinel in
every other position of a request, result and stream frame and fails if it reaches a record
or a log line, and fails if the adapter reads any property outside this list.

| From | Fields read |
| --- | --- |
| A Chat or Responses request | `modalities` of `chatRequest` or `responsesRequest` |
| A result or frame | `id`, `model`, `status` (Responses), `type` (stream events), `error` (Chat chunks, to tell an error from the end), `usage` (token counters, `cost`, `costDetails.upstreamInferenceCost`, `isByok`) and `openrouterMetadata` (`isByok`, and `provider` and `selected` of each available endpoint) |
| A `getGeneration` response | `data.providerName`, `data.responseCacheSourceId`, `data.isByok`, `data.upstreamInferenceCost` |

Never read: messages, prompts, instructions, completions, reasoning, tool definitions and
calls, embeddings input and vectors, `user`, `sessionId`, `metadata`, `systemFingerprint`,
error messages, and every other field of a result.

## Not metered

- Calls made on the native client rather than the facade.
- Calls the SDK rejects: `4xx` and `5xx` responses and network failures.
- Streams not read to their end, including streams never read at all, and streams read
  without async iteration.
- Every resource and method other than `chat.send()`, `responses.send()` and
  `embeddings.generate()`, including `callModel()`, `images`, `rerank`, `tts`, `stt`,
  `videoGeneration`, `models` and `generations`, which are forwarded unmetered.
- Charges that OpenRouter reports outside `usage.cost`, and fields with no AUDR counterpart,
  such as `serviceTier` and `region`.

## Operational bounds

- Metering never changes or fails a native call. A native error reaches the caller
  unchanged and is never logged; an exception inside the adapter is logged as `HOOK_FAILED`.
- Each call hands its record to `client.record()` before its result reaches the caller, so
  the adapter holds no records. Shut down by stopping new OpenRouter calls, awaiting the
  ones in flight, then awaiting `client.shutdown()`.
- A lookup can delay a call or a stream's terminal frame by at most `maxWaitMs`.
- Between calls the adapter keeps only its options. A stream it returned carries its own
  metering state, which is released with the stream.
- `client` is checked for a `record()` method, and other options use their TypeScript types
  as the contract. An `@openaudr/audr` `Client` validates every record in `record()` and
  reports a rejection in its result, which the adapter logs as `RECORD_NOT_QUEUED`.

## Runtime support

The adapter is tested on Node.js 22, 24 and 26. Its only runtime API is
`AsyncLocalStorage` from `node:async_hooks`, used for `withAudr` scopes. Runtimes that
provide it, such as Bun, Deno and Cloudflare Workers with the `nodejs_compat` flag, are
expected to work but are not tested.

## OpenRouter behaviour

This adapter relies on the OpenRouter behaviour described in OpenRouter's
[Usage accounting](https://openrouter.ai/docs/guides/administration/usage-accounting),
[Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
[BYOK](https://openrouter.ai/docs/guides/overview/auth/byok) and
[Get a generation](https://openrouter.ai/docs/api-reference/get-a-generation) pages, and on
the types of `@openrouter/sdk`.
