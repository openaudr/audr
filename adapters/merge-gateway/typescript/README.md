# @openaudr/audr-adapter-merge-gateway

[![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-merge-gateway?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-adapter-merge-gateway)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-adapter-merge-gateway)](https://www.npmjs.com/package/@openaudr/audr-adapter-merge-gateway)

The **AUDR adapter for [Merge Gateway](https://docs.merge.dev/merge-gateway/overview)**
meters calls made through Gateway's native TypeScript SDK. Every `responses.create()`,
streamed or not, and every `embeddings.create()` becomes one
[AUDR](https://openaudr.dev/spec/v1.0.0/) record for an `@openaudr/audr` `Client` your
application owns. It reads requested output modalities, usage, cost, identifiers and the
served model only: never input, output, tools, tags or error messages.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
npm install @openaudr/audr @openaudr/audr-adapter-merge-gateway merge-gateway-sdk
```

Requires Node.js 22.12 or later and `merge-gateway-sdk` 0.4.x. Both `merge-gateway-sdk`
and `@openaudr/audr` are peer dependencies, and the adapter imports only the Gateway SDK's
types.

## Usage

Wrap the `MergeGateway` once at startup and make every call through the returned facade:

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

await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Where is order 42?' });

// After the application has stopped starting Gateway calls and awaited the ones in flight.
await client.shutdown();
```

The facade is the native client behind a `Proxy`. It remains an `instanceof MergeGateway`
with the SDK's own type, passes every argument to the native method unchanged and forwards
every other member untouched. Calls made on the native client directly are not metered.

Each call hands its record to `client.record()` before its promise settles, or, for a
stream, before the terminal frame reaches the caller. The adapter therefore has no
`drain()` or `close()`, and the application owns the client's shutdown.

> [!IMPORTANT]
> Set `timeout` to at least 300 seconds, as Merge's
> [streaming guidance](https://docs.merge.dev/merge-gateway/streaming#timeouts-and-disconnects)
> recommends. The SDK aborts a request whose response has not started within `timeout`.
> Gateway still bills a call it has started, and an aborted call produces no record.

Runnable versions, answered by a local stand-in for the Gateway API, are in
[`examples/`](https://github.com/openaudr/audr/tree/main/adapters/merge-gateway/typescript/examples).

## Attribution

Attribution is resolved once, when a call starts, from the innermost `withAudr` scope
merged field by field over `attributionDefaults`. The scope wins, and `labels` merge by key:

```ts
import { instrumentMergeGateway, withAudr } from '@openaudr/audr-adapter-merge-gateway';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { MergeGateway } from 'merge-gateway-sdk';

const client = new Client(new FileSink('audr.jsonl'));
const gateway = instrumentMergeGateway(
  new MergeGateway({ apiKey: process.env.MERGE_GATEWAY_API_KEY ?? '', timeout: 300_000 }),
  { client, attributionDefaults: { environment: 'production' } },
);

await withAudr(
  {
    attribution: {
      account_id: 'acct_42',
      subscription_id: 'sub_7',
      user_id: 'u_8f14e45f', // pseudonymous, never an email or a name
      labels: { feature: 'support-chat' },
    },
  },
  () => gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Where is order 42?' }),
);
await client.shutdown();
```

- A scope covers every call any instrumented client starts inside it, including calls in
  promises the scope creates. `withAudr` returns exactly what its body returns.
- A stream keeps the attribution of the scope it was created in, even when it is read after
  that scope has exited.
- Only `environment`, `account_id`, `subscription_id`, `user_id` and `labels` reach a
  record. The `Client` validates their values.
- A call with no `environment` is skipped with an `ATTRIBUTION_UNRESOLVED` warning rather
  than billed to a guess. Omit `environment` from `attributionDefaults` to require it in
  every scope.
- Merge's own `customer`, `project_id`, `tags` and `session_id` are never read. They
  configure Gateway routing and budgets, not AUDR attribution.

A scope can also carry the host's run, so that every call in it joins that run and lines up
with Merge Gateway tracing; see
[Agent runs](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/docs/reference.md#agent-runs)
and
[Tracing](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/docs/reference.md#tracing-with-merge-gateway).

## Records

| Native call | `resource.operation` | `usage.llm` | `cost` |
| --- | --- | --- | --- |
| `responses.create()`, or the `response.done` frame of a stream | `generation` | Exclusive token counters, `requests: 1` | `total_cost` in USD from `usage.cost` |
| `embeddings.create()` | `embedding` | `input_tokens` from `prompt_tokens`, `requests: 1` | `total_cost` in USD from `usage.cost` |

Cache and reasoning tokens are counted apart from `input_tokens` and `output_tokens`.
`resource.provider` is `merge-gateway` and `resource.name` is the model that served the
call; `mapResource` attributes it to the model vendor instead.

Not metered: calls the SDK rejects, streams not read to their terminal frame, the `models`,
`tags` and `customers` resources, and Gateway endpoints the SDK does not expose.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/docs/reference.md): options, agent runs, Merge tracing, streams, record fields, diagnostics, operational bounds
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/merge-gateway/typescript/examples): runnable against a local stand-in for the Gateway API, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
