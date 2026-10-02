# Reference

The full reference for `@openaudr/audr-adapter-merge-gateway`. Installation, usage and
attribution are in the [README](../README.md).

## Options

`instrumentMergeGateway(gateway, options)` returns a facade with the type of `gateway`.

| Option | Type | Default | Behaviour |
| --- | --- | --- | --- |
| `client` | `Client` from `@openaudr/audr` | Required | Receives every record through `client.record()`. The adapter never creates, flushes or shuts it down. |
| `attributionDefaults` | `Attribution` | None | Applied field by field under each `withAudr` scope; `labels` merge by key. Copied when instrumenting, so later changes to the object have no effect. Omit `environment` to require it in every scope. |
| `mapResource` | `({ model, vendor }) => { provider, name } \| null \| undefined` | None | Overrides `resource.provider` and `resource.name`. Returning `null` or `undefined` keeps the default. A throw skips the record. |
| `logger` | `{ warn(message), error(message) }` | Discards diagnostics | Receives [diagnostics](#diagnostics). Pass `console` to print them. |

`instrumentMergeGateway` throws `ConfigurationError` when `client` has no `record()` method
or when `gateway` is already a facade, because a second facade would record every call
twice. Instrumenting the same native client twice gives two independent facades. Nothing
else in the package throws.

`withAudr(context, body)` runs `body` with `context` applied and returns what `body`
returns, including a rejection or exception. A `context` that cannot be read is ignored, and `body`
runs under the outer scope.

## Agent runs

A harness that already has a run id passes it in the scope, and every Gateway call in the
scope joins that run:

```ts
import { instrumentMergeGateway, withAudr } from '@openaudr/audr-adapter-merge-gateway';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { MergeGateway } from 'merge-gateway-sdk';

const client = new Client(new FileSink('audr.jsonl'));
const gateway = instrumentMergeGateway(
  new MergeGateway({ apiKey: process.env.MERGE_GATEWAY_API_KEY ?? '', timeout: 300_000 }),
  { client, attributionDefaults: { environment: 'production', account_id: 'acct_42' } },
);

await withAudr(
  { run: { run_id: 'run-order-42-support', parent_span_id: 'agent:1', name: 'support-agent' } },
  async () => {
    await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Plan the reply.' });
    await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Write the reply.' });
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

## Tracing with Merge Gateway

Merge Gateway groups the requests of one run into a trace when each carries an
`X-Merge-Trace-Id` header
([Tracing](https://docs.merge.dev/merge-gateway/observability/tracing)). AUDR groups the
records of one run by `run.run_id`. Using the same id for both makes Merge's Logs and the
AUDR records describe the same run.

`merge-gateway-sdk` sends headers per client through `defaultHeaders`, not per call, so
each run needs its own client. A `MergeGateway` holds no connections, and a scope covers
every instrumented client, including one created inside it. The runnable version is
[`examples/tracing.ts`](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/examples/tracing.ts):

```ts
import { instrumentMergeGateway, withAudr } from '@openaudr/audr-adapter-merge-gateway';
import { Client, uuidv7 } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { MergeGateway } from 'merge-gateway-sdk';

const client = new Client(new FileSink('audr.jsonl'));

async function handleTicket(accountId: string, ticket: string): Promise<void> {
  const runId = `run-${uuidv7()}`;
  const gateway = instrumentMergeGateway(
    new MergeGateway({
      apiKey: process.env.MERGE_GATEWAY_API_KEY ?? '',
      timeout: 300_000,
      defaultHeaders: { 'X-Merge-Trace-Id': runId, 'X-Merge-Thread-Id': ticket },
    }),
    { client, attributionDefaults: { environment: 'production' } },
  );
  await withAudr(
    { attribution: { account_id: accountId }, run: { run_id: runId, name: 'support-agent' } },
    async () => {
      await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Draft a reply.' });
      await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Critique the draft.' });
    },
  );
}

await handleTicket('acct_42', 'ticket-1042');
await client.shutdown();
```

- **The id must satisfy both systems:** 8 to 64 characters, AUDR's `run_id` limit, from
  `A-Z a-z 0-9 . _ : -`, Merge's header alphabet. Merge silently drops an invalid header
  and the request goes untraced; the `Client` rejects an out-of-range `run_id` with
  `RECORD_NOT_QUEUED`. `run-` followed by a UUID satisfies both.
- **Mint a fresh id per run.** Merge merges every request that shares a trace id, and AUDR
  requires `run_id` to be unique within an account.
- **Threads and turns** (`X-Merge-Thread-Id`, `X-Merge-Turn-Id`) group requests in Merge's
  Logs only. AUDR has no field for them, and a per-conversation id does not belong in
  `labels`.
- **Join records to Merge traces by run, not by span.** Merge identifies a span by the
  response's `X-Request-ID` header, which `merge-gateway-sdk` does not expose, so
  `run.span_id` is derived from the response id. For the same reason `X-Merge-Span-Name`
  and `X-Merge-Parent-Span-Id`, which describe a single call, cannot be set: as
  `defaultHeaders` they would apply to every call of the client.
- **`run.parent_span_id` is the harness span** that the scope's calls belong to, not a
  Merge span.
- **`run.trace_id` is never written.** AUDR reserves it for a W3C trace id, which
  `X-Merge-Trace-Id` is not. Merge records a W3C `traceparent` header separately, as
  *Client trace ID*.
- **A traced Fusion request** appears in Merge with its panel calls as child spans and
  produces one record (see [Fusion](#fusion)).

## Streams

```ts
import { instrumentMergeGateway } from '@openaudr/audr-adapter-merge-gateway';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { MergeGateway } from 'merge-gateway-sdk';

const client = new Client(new FileSink('audr.jsonl'));
const gateway = instrumentMergeGateway(
  new MergeGateway({ apiKey: process.env.MERGE_GATEWAY_API_KEY ?? '', timeout: 300_000 }),
  { client, attributionDefaults: { environment: 'production', account_id: 'acct_42' } },
);

const stream = await gateway.responses.create({
  model: 'anthropic/claude-sonnet-5',
  input: 'Write a short answer.',
  stream: true,
});
for await (const frame of stream) {
  if (frame.object === 'response.done') console.log('done');
}
await client.shutdown();
```

The returned stream is the native `Stream` behind a proxy, and every frame is yielded
unchanged. Gateway reports usage and cost only on the terminal `response.done` frame, so the
record is built from that frame alone. A `fallback_restart` frame, which Gateway sends when
it fails over to another vendor, has no effect on the record.

A stream that ends without a terminal frame produces no record and logs one
`STREAM_INCOMPLETE` warning with a `reason`:

| `reason` | The stream ended because |
| --- | --- |
| `error_frame` | Gateway sent a `response.error` frame, which ends a Gateway stream |
| `ended` | The body ended first |
| `failed` | Reading the stream threw |
| `abandoned` | The loop stopped early |
| `closed` | `close()` was called first |

A stream that is never iterated or closed produces neither a record nor a warning, because
no event marks it as dropped. Gateway still bills such a stream, so read every stream to its
terminal frame when every call must be metered.

## Records

### Tokens

`usage.llm` on a `generation` record is derived from Gateway's `/v1/responses` usage, whose
`input_tokens` counts the whole prompt and whose `output_tokens` includes reasoning:

| AUDR counter | Source |
| --- | --- |
| `input_tokens` | `input_tokens` minus `cache_read_input_tokens` and `cache_creation_input_tokens` |
| `cache_read_tokens` | `cache_read_input_tokens` |
| `cache_write_tokens` | `cache_creation_input_tokens` |
| `output_tokens` | `output_tokens` minus `reasoning_output_tokens` |
| `reasoning_tokens` | `reasoning_output_tokens` |
| `requests` | Always `1` |

Gateway reports a counter it cannot count as `null`. A `null` cache-read counter omits
`input_tokens`, because AUDR's `input_tokens` must exclude cache reads. A `null` cache-write
counter keeps those tokens in `input_tokens`, because Gateway bills unreported writes at the
input rate. A `null` reasoning counter writes no `reasoning_tokens`, and `output_tokens` is
then the whole completion. A counter Gateway does not include did not apply and counts as
zero. `total_tokens` is never copied. An `embedding` record carries `input_tokens` from
`prompt_tokens`.

### Cost

Gateway's per-call `usage.cost` becomes `cost.total_cost` with `currency` `USD`. It is
Gateway's price for the route and service tier that served the call, net of discounts, and
excludes Merge's fee and server-tool charges such as web search; the invoice remains the
authority. A `null` cost, which Gateway returns for an unpriced route, writes no `cost`.
No `cost.llm` breakdown is written, because `usage.cost` can include hosted image
generation.

### Resource

`resource.provider` is `merge-gateway` and `resource.name` is the model that served the
call, verbatim (`openai/gpt-5.4`). `resource.modality` follows the requested `modalities`:
`text` by default, `image` or `audio` when that is the only one of `text`, `image` and
`audio` requested, and `multimodal` when more than one of them is requested.

To price by the model vendor instead of by Gateway, return a mapping from `mapResource`.
It receives the served `model` and the execution `vendor` (`openai`, `bedrock`, ...):

```ts
import { instrumentMergeGateway } from '@openaudr/audr-adapter-merge-gateway';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { MergeGateway } from 'merge-gateway-sdk';

const client = new Client(new FileSink('audr.jsonl'));
const gateway = instrumentMergeGateway(
  new MergeGateway({ apiKey: process.env.MERGE_GATEWAY_API_KEY ?? '', timeout: 300_000 }),
  {
    client,
    attributionDefaults: { environment: 'production', account_id: 'acct_42' },
    mapResource: ({ model }) => {
      const [provider, ...name] = model?.split('/') ?? [];
      return provider && name.length > 0 ? { provider, name: name.join('/') } : null;
    },
  },
);

await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Where is order 42?' });
await client.shutdown();
```

A mapped `provider` must match `^[a-z0-9-]+$`, or the `Client` rejects the record with
`RECORD_NOT_QUEUED`. A `mapResource` that throws skips the record with `HOOK_FAILED` rather
than falling back to the default. A call with no model name, reported or mapped, is skipped
with `MODEL_UNREPORTED`.

### Identifiers

| Field | Value |
| --- | --- |
| `run.run_id` | The scope's `run_id`; otherwise the Merge response `id`, or a fresh UUIDv7 when the response has no id, as with embeddings, or an id outside 8 to 64 characters |
| `run.span_id` | `response:<response id>` or `embedding:<uuid>` |
| `run.parent_span_id` | The scope's `parent_span_id` |
| `run.name` | The scope's `name` |
| `run.run_type` | `agent_run` inside a run scope; `single_call` otherwise |
| `run.error_code` | `MERGE_GATEWAY_RESPONSE_FAILED`, exported as `RESPONSE_FAILED_CODE`, for a response with `status: 'failed'` |

`run.step` is never written, because a run can span several scopes, processes and
concurrent calls; order records by `timing.event_time`. `emitter` is the adapter as a
`router`, because every counter and the cost are Gateway's own. The `@openaudr/audr` SDK
mints `record_id`.

### Fusion

A [Fusion](https://docs.merge.dev/merge-gateway/capabilities/fusion) request
(`model: 'fusion'`) produces one record. Gateway's `usage` and `usage.cost` already sum
every panel call and the judge, so the cost is complete. `resource.name` is the `model` the
response reports, and the token counts span several models, so price Fusion by `cost`
rather than by tokens.

### Timing

`timing.event_time` is when the call completed, or, for a stream, when its terminal frame
arrived. `timing.duration_ms` is the time from the start of the call to that moment.

## Diagnostics

The adapter logs nothing unless `logger` is given. Each message has the form
`@openaudr/audr-adapter-merge-gateway: <CODE> (<key>=<value>, ...)` and carries the
operation (`responses.create` or `embeddings.create`), submit outcomes, issue paths, stream
reasons and error categories only, never a record value, an id, a model name or an error
message. The `DiagnosticCode` type lists every code.

| Code | Level | Logged when | Action |
| --- | --- | --- | --- |
| `ATTRIBUTION_UNRESOLVED` | warn | A call starts with no `environment` in its attribution; it is not metered | Set `environment` in `attributionDefaults` or the `withAudr` scope |
| `MODEL_UNREPORTED` | warn | A response names no model and `mapResource` supplies none; the record is skipped | Return a name from `mapResource` |
| `STREAM_INCOMPLETE` | warn | A stream ends without a terminal frame, with the [`reason`](#streams) | Read streams to their terminal frame |
| `RECORD_NOT_QUEUED` | warn | The `Client` does not queue a record; `issues` lists each `<code>@<path>` | Fix the attribution or mapping the issue path names, or check that the client is running |
| `HOOK_FAILED` | error | The adapter, `mapResource` or the client throws while metering; the native call continues | Fix `mapResource`, or report it as a bug with the error category |

An error category is `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError` or `Error`,
the `typeof` of a thrown non-error, or `unknown`. `error.name` and `error.message` are
never read, because both are writable and may carry prompt or record values.

## Not metered

- Calls made on the native client rather than the facade.
- Calls the SDK rejects: `4xx` and `5xx` responses, and requests it aborts because no
  response started within its `timeout`. Gateway still bills a call it has started and logs
  a disconnected request as `499`.
- Streams not read to their terminal frame, including streams never read at all.
- The `models`, `tags` and `customers` resources, which are forwarded unmetered.
- Gateway endpoints `merge-gateway-sdk` does not expose: chat completions, messages,
  images, audio, video, decisions and batches. Inline image output requested through
  `responses.create()` is metered as a response. Gateway's AI SDK surface is metered by
  [`@openaudr/audr-adapter-vercel-ai`](https://github.com/openaudr/audr/tree/main/adapters/vercel-ai/typescript#readme);
  its OpenAI and Anthropic surfaces are not metered.
- Server-tool charges such as web search, which Gateway leaves out of `usage.cost`, and the
  served `service_tier`, which has no AUDR field.

## Operational bounds

- Metering never changes or fails a native call. A native error reaches the caller
  unchanged and is never logged; an exception inside the adapter is logged as `HOOK_FAILED`.
- Each call hands its record to `client.record()` before its result reaches the caller, so
  the adapter holds no records. Shut down by stopping new Gateway calls, awaiting the ones
  in flight, then awaiting `client.shutdown()`.
- Between calls the adapter holds only the streams it returned and the current `withAudr`
  scope.
- `client` is checked for a `record()` method; other options use their TypeScript types as
  the contract. `Client.record()` validates every record value and never throws.

## Runtime support

The adapter is tested on Node.js 22, 24 and 26. Its only runtime API is
`AsyncLocalStorage` from `node:async_hooks`, used for `withAudr` scopes. Runtimes that
provide it, such as Bun, Deno and Cloudflare Workers with the `nodejs_compat` flag, are
expected to work but are not tested.

## Gateway behaviour

This adapter relies on the Gateway behaviour described in Merge's
[API details](https://docs.merge.dev/merge-gateway/api-overview),
[Streaming](https://docs.merge.dev/merge-gateway/streaming),
[Tracing](https://docs.merge.dev/merge-gateway/observability/tracing),
[Prompt caching](https://docs.merge.dev/merge-gateway/capabilities/prompt-caching),
[Reasoning](https://docs.merge.dev/merge-gateway/capabilities/reasoning) and
[Fusion](https://docs.merge.dev/merge-gateway/capabilities/fusion) pages.
