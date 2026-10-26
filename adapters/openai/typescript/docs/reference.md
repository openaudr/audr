# Reference

The full reference for `@openaudr/audr-adapter-openai`. Installation, usage, attribution and
the provider table are in the [README](../README.md).

## Options

`instrumentOpenAI(openai, options)` returns a facade with the type of `openai`.

| Option | Type | Default | Behaviour |
| --- | --- | --- | --- |
| `client` | `Client` from `@openaudr/audr` | Required | Receives every record through `client.record()`. The adapter never creates, flushes or shuts it down. |
| `attributionDefaults` | `Attribution` | None | Applied field by field under each `withAudr` scope; `labels` merge by key. Copied when instrumenting, so later changes to the object have no effect. Omit `environment` to require it in every scope. |
| `mapResource` | `({ baseUrl, model }) => { provider, name } \| null \| undefined` | None | Overrides `resource.provider` and `resource.name`, and names the provider for a `baseURL` the adapter does not know. Returning `null` or `undefined` keeps the default. A throw skips the record. |
| `logger` | `{ warn(message), error(message) }` | Discards diagnostics | Receives [diagnostics](#diagnostics). Pass `console` to print them. |

`instrumentOpenAI` throws `ConfigurationError` when `client` has no `record()` method or
when `openai` is already a facade, because a second facade would record every call twice.
Instrumenting the same native client twice gives two independent facades. Nothing else in
the package throws.

`openai` must satisfy `OpenAILike`: an optional `baseURL` string, and `chat.completions`,
`responses` and `embeddings` resources with a `create()` method. An `OpenAI` or
`AzureOpenAI` client does. A client without a `baseURL` is metered only through
`mapResource`.

`withAudr(context, body)` runs `body` with `context` applied and returns what `body`
returns, including a rejection or exception. A `context` that cannot be read is ignored,
and `body` runs under the outer scope.

## Agent runs

A harness that already has a run id passes it in the scope, and every call in the scope
joins that run:

```ts
import { instrumentOpenAI, withAudr } from '@openaudr/audr-adapter-openai';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import OpenAI from 'openai';

const client = new Client(new FileSink('audr.jsonl'));
const openai = instrumentOpenAI(new OpenAI(), {
  client,
  attributionDefaults: { environment: 'production', account_id: 'acct_42' },
});

await withAudr(
  { run: { run_id: 'run-order-42-support', parent_span_id: 'agent:1', name: 'support-agent' } },
  async () => {
    await openai.responses.create({ model: 'gpt-5.4', input: 'Plan the reply.' });
    await openai.responses.create({ model: 'gpt-5.4', input: 'Write the reply.' });
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
import { instrumentOpenAI } from '@openaudr/audr-adapter-openai';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import OpenAI from 'openai';

const client = new Client(new FileSink('audr.jsonl'));
const openai = instrumentOpenAI(new OpenAI(), {
  client,
  attributionDefaults: { environment: 'production', account_id: 'acct_42' },
});

const stream = await openai.chat.completions.create({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'Write a short answer.' }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  if (chunk.usage) console.log('done');
}
await client.shutdown();
```

The returned stream is the SDK's `Stream` behind a proxy, and every frame is yielded
unchanged. The record is built from the one frame that carries the call's usage, before that
frame is yielded:

| Stream | Recorded from |
| --- | --- |
| `chat.completions.create({ stream: true })` | The chunk whose `usage` is an object. OpenAI sends it last, and only when the request sets `stream_options: { include_usage: true }`. |
| `responses.create({ stream: true })` | The `response.completed`, `response.failed` or `response.incomplete` event, from its `response`. |

A stream that ends without that frame produces no record and logs one `STREAM_INCOMPLETE`
warning with a `reason`:

| `reason` | The stream ended because |
| --- | --- |
| `ended` | The body ended first; for a chat stream, usually because `include_usage` was not set |
| `failed` | Reading the stream threw, including the `APIError` the SDK raises for an `error` event |
| `abandoned` | The loop stopped early, or `stream.controller.abort()` was called |
| `error_frame` | A Responses `error` event reached the adapter as a frame, which the SDK itself does not do |

Only iteration of the proxied stream is metered. `stream.tee()` and
`stream.toReadableStream()` operate on the native stream and produce no record. A stream that
is never iterated produces neither a record nor a warning, because no event marks it as
dropped. The provider still bills such a stream, so read every stream to its completing frame
when every call must be metered.

## Records

### Tokens

`usage.llm` on a `generation` record is derived from the response's usage object. The
provider's prompt counter includes cache reads and its completion counter includes
reasoning, so each is reduced by the detail counter reported alongside it:

| AUDR counter | Chat Completions source | Responses source |
| --- | --- | --- |
| `input_tokens` | `prompt_tokens` minus `prompt_tokens_details.cached_tokens` | `input_tokens` minus `input_tokens_details.cached_tokens` |
| `cache_read_tokens` | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` |
| `output_tokens` | `completion_tokens` minus `completion_tokens_details.reasoning_tokens` | `output_tokens` minus `output_tokens_details.reasoning_tokens` |
| `reasoning_tokens` | `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` |
| `requests` | Always `1` | Always `1` |

A detail counter the provider does not include did not apply and counts as zero. A
counter that is absent or `null` is unreported and the corresponding AUDR counter is
omitted. `total_tokens` is never copied. An `embedding` record carries `input_tokens`
from `prompt_tokens`. No `cache_write_tokens` is written, because the OpenAI wire format
reports no cache writes.

### Cost

No `cost` is written. The OpenAI wire format carries no price, and the adapter does not
price usage itself.

### Resource

`resource.provider` is resolved from the client's `baseURL` as the
[README](../README.md#providers) tabulates, and `resource.name` is the model the response
reports, verbatim (`gpt-5.4-2026-03-01`, not the alias requested). `resource.modality`
follows the Chat Completions request's `modalities`: `text` by default, `audio` when that is
the only one requested, and `multimodal` when both are. Responses and embeddings are `text`.
`resource.deployment` is `self-hosted` for a loopback `baseURL`.

A mapped `provider` from `mapResource` must match `^[a-z0-9-]+$`, or the `Client` rejects the
record with `RECORD_NOT_QUEUED`. A `mapResource` that throws skips the record with
`HOOK_FAILED` rather than falling back to the default. A call with no model name, reported or
mapped, is skipped with `MODEL_UNREPORTED`; a call whose provider is neither known nor
mapped is skipped with `PROVIDER_UNRESOLVED`.

### Identifiers

| Field | Value |
| --- | --- |
| `run.run_id` | The scope's `run_id`; otherwise the response `id`, or a fresh UUIDv7 when the response has no id, as with embeddings, or an id outside 8 to 64 characters |
| `run.span_id` | `chat:<completion id>`, `response:<response id>` or `embedding:<uuid>` |
| `run.parent_span_id` | The scope's `parent_span_id` |
| `run.name` | The scope's `name` |
| `run.run_type` | `agent_run` inside a run scope; `single_call` otherwise |
| `run.error_code` | `OPENAI_RESPONSE_FAILED` (`RESPONSE_FAILED_CODE`) for a response with `status: 'failed'` or a `response.failed` event; `OPENAI_RESPONSE_INCOMPLETE` (`RESPONSE_INCOMPLETE_CODE`) for `status: 'incomplete'` or a `response.incomplete` event |

`run.step` is never written, because a run can span several scopes, processes and
concurrent calls; order records by `timing.event_time`. `run.trace_id` is never written.
`emitter` is the adapter as a `harness`, because it runs inside the application that makes
the call. The `@openaudr/audr` SDK mints `record_id`.

### Timing

`timing.event_time` is when the record was built: when the call completed, or, for a
stream, when its completing frame arrived. `timing.duration_ms` is the time from the start
of the call to that moment.

## Diagnostics

The adapter logs nothing unless `logger` is given. Each message has the form
`@openaudr/audr-adapter-openai: <CODE> (<key>=<value>, ...)` and carries the operation
(`chat.completions.create`, `responses.create` or `embeddings.create`), submit outcomes,
issue paths, stream reasons and error categories only, never a record value, an id, a
model name, a URL or an error message. The `DiagnosticCode` type lists every code.

| Code | Level | Logged when | Action |
| --- | --- | --- | --- |
| `ATTRIBUTION_UNRESOLVED` | warn | A call starts with no `environment` in its attribution; it is not metered | Set `environment` in `attributionDefaults` or the `withAudr` scope |
| `PROVIDER_UNRESOLVED` | warn | The client's `baseURL` names a host the adapter does not know and `mapResource` supplies no provider; the record is skipped | Return a provider from `mapResource` |
| `MODEL_UNREPORTED` | warn | A response names no model and `mapResource` supplies none; the record is skipped | Return a name from `mapResource` |
| `STREAM_INCOMPLETE` | warn | A stream ends without its completing frame, with the [`reason`](#streams) | Set `stream_options.include_usage` on chat streams; read streams to their end |
| `RECORD_NOT_QUEUED` | warn | The `Client` does not queue a record; `issues` lists each `<code>@<path>` | Fix the attribution or mapping the issue path names, or check that the client is running |
| `HOOK_FAILED` | error | The adapter, `mapResource` or the client throws while metering; the native call continues | Fix `mapResource`, or report it as a bug with the error category |

An error category is `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError` or `Error`,
the `typeof` of a thrown non-error, or `unknown`. `error.name` and `error.message` are
never read, because both are writable and may carry prompt or record values.

## Not metered

- Calls made on the native client rather than the facade.
- Calls the SDK rejects: `4xx` and `5xx` responses after its retries, and requests it
  aborts on `timeout`. The provider may still bill a call it has started.
- Streams not read to their completing frame, including streams never read at all, and
  streams consumed through `tee()` or `toReadableStream()`.
- The SDK's helpers `chat.completions.stream()`, `chat.completions.parse()`,
  `responses.stream()` and `responses.parse()`, which call the native client's `create()`
  internally.
- Every other resource: `audio`, `images`, `files`, `batches`, `fine_tuning`, `vector_stores`,
  `moderations`, `models` and the rest, which are forwarded unmetered.

## Operational bounds

- Metering never changes or fails a native call. A native error reaches the caller
  unchanged and is never logged; an exception inside the adapter is logged as `HOOK_FAILED`.
- Each call hands its record to `client.record()` before its result reaches the caller, so
  the adapter holds no records. Shut down by stopping new calls, awaiting the ones in
  flight, then awaiting `client.shutdown()`.
- Between calls the adapter holds only the streams it returned and the current `withAudr`
  scope.
- `client` is checked for a `record()` method; other options use their TypeScript types as
  the contract. `Client.record()` validates every record value and never throws.
- The client's `baseURL` is read when each record is built, so a client whose `baseURL` is
  changed after instrumenting is attributed to its current provider.

## Runtime support

The adapter is tested on Node.js 22, 24 and 26 against `openai` 5.0.0, the floor of its
peer range. Its only runtime API is `AsyncLocalStorage` from `node:async_hooks`, used for
`withAudr` scopes. Runtimes that provide it, such as Bun, Deno and Cloudflare Workers with
the `nodejs_compat` flag, are expected to work but are not tested.

## Provider behaviour

This adapter relies on the usage reporting described in OpenAI's
[Chat Completions](https://platform.openai.com/docs/api-reference/chat/object),
[Responses](https://platform.openai.com/docs/api-reference/responses/object),
[Embeddings](https://platform.openai.com/docs/api-reference/embeddings/object),
[Streaming](https://platform.openai.com/docs/api-reference/chat/streaming) and
[Prompt caching](https://platform.openai.com/docs/guides/prompt-caching) references. An
OpenAI-compatible endpoint that omits a counter is metered without it.
