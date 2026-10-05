# @openaudr/audr-adapter-openrouter

[![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-openrouter?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-adapter-openrouter)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-adapter-openrouter)](https://www.npmjs.com/package/@openaudr/audr-adapter-openrouter)

The **AUDR adapter for [OpenRouter](https://openrouter.ai/docs)** meters calls made through
OpenRouter's native TypeScript SDK. Every `chat.send()`, `responses.send()` (streamed or
not) and `embeddings.generate()` becomes one
[AUDR](https://openaudr.dev/spec/v1.0.0/) record for an `@openaudr/audr` `Client` your
application owns. It reads requested output modalities, usage, cost, identifiers, the served
model and the serving vendor only: never prompts, completions, tools, request `metadata` or
error messages.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
npm install @openaudr/audr @openaudr/audr-adapter-openrouter @openrouter/sdk
```

Requires Node.js 22.12 or later and `@openrouter/sdk` 1.3.8 or later in the 1.x line. Both
`@openrouter/sdk` and `@openaudr/audr` are peer dependencies, and the adapter imports only
the OpenRouter SDK's types.

## Usage

Wrap the `OpenRouter` client once at startup and make every call through the returned
facade:

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

await openrouter.chat.send({
  chatRequest: {
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'Where is order 42?' }],
  },
  xOpenRouterMetadata: 'enabled',
});

// After the application has stopped starting OpenRouter calls and awaited the ones in flight.
await client.shutdown();
```

The facade is the native client behind a `Proxy`. It remains an `instanceof OpenRouter`
with the SDK's own type, passes every argument to the native method unchanged and forwards
every other member untouched. Calls made on the native client directly are not metered.

Each call hands its record to `client.record()` before its promise settles, or, for a
stream, before the terminal frame reaches the caller. The adapter therefore has no
`drain()` or `close()`, and the application owns the client's shutdown.

Runnable versions, answered by a local stand-in for the OpenRouter API, are in
[`examples/`](https://github.com/openaudr/audr/tree/main/adapters/openrouter/typescript/examples).

## Which vendor served the call

AUDR names the vendor that served a call in `resource.provider`. OpenRouter routes between
vendors, and only the service knows which one it chose:

- **Router metadata.** A Chat or Responses request that sends
  `xOpenRouterMetadata: 'enabled'`, as the example above does, gets `openrouterMetadata` on
  its result, naming the selected endpoint. The adapter reads the vendor from it and makes
  no further request.
- **A lookup.** Otherwise the adapter asks `generations.getGeneration({ id })` through the
  same client, which can hold back the call's promise, or a stream's terminal frame, for up
  to `lookup.maxWaitMs`. Embeddings results never carry router metadata, so they always take
  this path. [Lookup](https://github.com/openaudr/audr/blob/main/adapters/openrouter/typescript/docs/reference.md#lookup)
  has the retry rules and how to bound or disable it.

A response that OpenRouter replayed from its cache is attributed to `openrouter`, and so is
a call whose vendor cannot be resolved, which also logs `PROVIDER_UNRESOLVED`.

## Attribution

Attribution is resolved once, when a call starts, from the innermost `withAudr` scope
merged field by field over `attributionDefaults`. The scope wins, and `labels` merge by key:

```ts
import { instrumentOpenRouter, withAudr } from '@openaudr/audr-adapter-openrouter';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { OpenRouter } from '@openrouter/sdk';

const client = new Client(new FileSink('audr.jsonl'));
const openrouter = instrumentOpenRouter(
  new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? '' }),
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
  () =>
    openrouter.chat.send({
      chatRequest: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'Where is order 42?' }],
      },
      xOpenRouterMetadata: 'enabled',
    }),
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
- OpenRouter's own `user`, `sessionId` and `metadata` request fields are never read. They
  configure OpenRouter, not AUDR attribution.

A scope can also carry the host's run, so that every call in it joins that run; see
[Agent runs](https://github.com/openaudr/audr/blob/main/adapters/openrouter/typescript/docs/reference.md#agent-runs).

## Records

| Native call | `resource.operation` | `usage.llm` | `cost` |
| --- | --- | --- | --- |
| `chat.send()`, or the chunk of a stream that carries `usage` | `generation` | Exclusive token counters, `requests: 1` | `total_cost` in USD |
| `responses.send()`, or the terminal event of a stream | `generation` | Exclusive token counters, `requests: 1` | `total_cost` in USD |
| `embeddings.generate()` | `embedding` | `input_tokens` from `promptTokens`, `requests: 1` | `total_cost` in USD |

Cache and reasoning tokens are counted apart from `input_tokens` and `output_tokens`.
`resource.provider` is the vendor that served the call, as a slug (`Amazon Bedrock` becomes
`amazon-bedrock`), or `openrouter` when it is unknown. `resource.name` is the model that
served it, and `mapResource` overrides both. The cost of a call billed to the caller's own
provider key (BYOK) is OpenRouter's fee plus the provider's charge; when the provider's
charge is unknown, the record carries no cost rather than an understated one.

Calls the SDK rejects, streams not read to their end or read without `for await`, and every
other resource and method, including `callModel()`, are not metered.
[Not metered](https://github.com/openaudr/audr/blob/main/adapters/openrouter/typescript/docs/reference.md#not-metered)
has the full list.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/openrouter/typescript/docs/reference.md): options, the lookup, agent runs, streams, token and cost formulas, record fields, diagnostics, privacy, what is not metered, operational bounds and runtime support
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/openrouter/typescript/examples): runnable against a local stand-in for the OpenRouter API, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/openrouter/typescript/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
