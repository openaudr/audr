# @openaudr/audr-adapter-openai

[![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-openai?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-adapter-openai)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-adapter-openai)](https://www.npmjs.com/package/@openaudr/audr-adapter-openai)

The **AUDR adapter for the [OpenAI SDK](https://github.com/openai/openai-node)** meters calls
made through an `openai` client, whether it points at OpenAI or at any endpoint that speaks
the OpenAI wire format. Every `chat.completions.create()` and `responses.create()`, streamed or
not, and every `embeddings.create()` becomes one [AUDR](https://openaudr.dev/spec/v1.1.0/)
record for an `@openaudr/audr` `Client` your application owns. It reads requested output
modalities, usage, identifiers, the served model and the client's `baseURL` only: never
messages, input, output, tools or error messages.

> **Status: alpha.** The record model tracks AUDR v1.1.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
npm install @openaudr/audr @openaudr/audr-adapter-openai openai
```

Requires Node.js 22.12 or later and `openai` 5, 6 or 7. Both `openai` and `@openaudr/audr`
are peer dependencies, and the adapter imports nothing from the OpenAI SDK at run time.

## Usage

Wrap the client once at startup and make every call through the returned facade:

```ts
import { instrumentOpenAI } from '@openaudr/audr-adapter-openai';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import OpenAI from 'openai';

const client = new Client(new FileSink('audr.jsonl'), {
  emitter: { component: 'harness', name: 'my-app', version: '1.0.0' },
});
const openai = instrumentOpenAI(new OpenAI(), {
  client,
  attributionDefaults: { environment: 'production', account_id: 'acct_42' },
});

await openai.chat.completions.create({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'Where is order 42?' }],
});

// After the application has stopped starting OpenAI calls and awaited the ones in flight.
await client.shutdown();
```

The facade is the native client behind a `Proxy`. It remains an `instanceof OpenAI` with the
SDK's own type, passes every argument to the native method unchanged and forwards every
other member untouched. Calls made on the native client directly are not metered.

Each call hands its record to `client.record()` before its promise settles, or, for a
stream, before the frame that completes it reaches the caller. The adapter therefore has no
`drain()` or `close()`, and the application owns the client's shutdown.

> [!IMPORTANT]
> A streamed chat completion reports usage only when the request sets
> `stream_options: { include_usage: true }`. Without it, the stream ends with no record and a
> `STREAM_INCOMPLETE` warning. Responses streams always report usage.

Runnable versions, answered by a local stand-in for the API, are in
[`examples/`](https://github.com/openaudr/audr/tree/main/adapters/openai/typescript/examples).

## Attribution

Attribution is resolved once, when a call starts, from the innermost `withAudr` scope
merged field by field over `attributionDefaults`. The scope wins, and `labels` merge by key:

```ts
import { instrumentOpenAI, withAudr } from '@openaudr/audr-adapter-openai';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import OpenAI from 'openai';

const client = new Client(new FileSink('audr.jsonl'));
const openai = instrumentOpenAI(new OpenAI(), {
  client,
  attributionDefaults: { environment: 'production' },
});

await withAudr(
  {
    attribution: {
      account_id: 'acct_42',
      subscription_id: 'sub_7',
      user_id: 'u_8f14e45f', // pseudonymous, never an email or a name
      feature_id: 'support-chat', // selects the meter the usage is billed against
      labels: { team: 'support' },
    },
  },
  () =>
    openai.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Where is order 42?' }],
    }),
);
await client.shutdown();
```

- A scope covers every call any instrumented client starts inside it, including calls in
  promises the scope creates. `withAudr` returns exactly what its body returns.
- A stream keeps the attribution of the scope it was created in, even when it is read after
  that scope has exited.
- Only `environment`, `account_id`, `subscription_id`, `user_id`, `feature_id` and `labels`
  reach a record. The `Client` validates their values.
- A call with no `environment` is skipped with an `ATTRIBUTION_UNRESOLVED` warning rather
  than billed to a guess. Omit `environment` from `attributionDefaults` to require it in
  every scope.
- The request's own `user` and `metadata` fields are never read. They belong to the
  provider, not to AUDR attribution.

A scope can also carry the host's run, so that every call in it joins that run; see
[Agent runs](https://github.com/openaudr/audr/blob/main/adapters/openai/typescript/docs/reference.md#agent-runs).

## Providers

`resource.provider` comes from the client's `baseURL`, so one package meters every
OpenAI-compatible endpoint the SDK can be pointed at:

| `baseURL` host | `resource.provider` |
| --- | --- |
| `api.openai.com` (the default) | `openai` |
| `*.openai.azure.com`, `*.cognitiveservices.azure.com`, `*.services.ai.azure.com`, including an `AzureOpenAI` client | `azure-openai` |
| `api.groq.com` | `groq` |
| `api.mistral.ai` | `mistral` |
| `api.together.xyz` | `together` |
| `api.fireworks.ai` | `fireworks` |
| `api.deepseek.com` | `deepseek` |
| `openrouter.ai` | `openrouter` |
| `localhost`, `127.0.0.1`, `[::1]` | `ollama`, with `resource.deployment` `self-hosted` |

A host not in this table is skipped with a `PROVIDER_UNRESOLVED` warning rather than billed
to a guess. Name it with `mapResource`, which receives the `baseUrl` and the served `model`:

```ts
import { instrumentOpenAI } from '@openaudr/audr-adapter-openai';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import OpenAI from 'openai';

const client = new Client(new FileSink('audr.jsonl'));
const databricks = instrumentOpenAI(
  new OpenAI({
    apiKey: process.env.DATABRICKS_TOKEN ?? '',
    baseURL: 'https://adb-1234567890.1.azuredatabricks.net/serving-endpoints',
  }),
  {
    client,
    attributionDefaults: { environment: 'production', account_id: 'acct_42' },
    mapResource: ({ model }) => (model ? { provider: 'databricks', name: model } : null),
  },
);

await databricks.chat.completions.create({
  model: 'databricks-llama-4-maverick',
  messages: [{ role: 'user', content: 'Where is order 42?' }],
});
await client.shutdown();
```

The same applies to a LiteLLM proxy, Cloudflare AI Gateway, vLLM on another host or any
private gateway. For OpenRouter, the dedicated
[`@openaudr/audr-adapter-openrouter`](https://github.com/openaudr/audr/tree/main/adapters/openrouter/typescript#readme)
additionally reads the routed vendor and the per-call cost.

> [!IMPORTANT]
> An application that already meters through
> [`@openaudr/audr-adapter-vercel-ai`](https://github.com/openaudr/audr/tree/main/adapters/vercel-ai/typescript#readme),
> [`@openaudr/audr-adapter-mastra`](https://github.com/openaudr/audr/tree/main/adapters/mastra/typescript#readme)
> or a LiteLLM callback must not also instrument the OpenAI client beneath them. Each call
> would produce two records with different span ids.

## Records

| Native call | `resource.operation` | `usage.llm` |
| --- | --- | --- |
| `chat.completions.create()`, or the chunk of a stream that carries `usage` | `generation` | Exclusive token counters, `requests: 1` |
| `responses.create()`, or the terminal event of a stream | `generation` | Exclusive token counters, `requests: 1` |
| `embeddings.create()` | `embedding` | `input_tokens` from `prompt_tokens`, `requests: 1` |

Cache-read and reasoning tokens are counted apart from `input_tokens` and `output_tokens`.
`resource.name` is the model the response reports, verbatim. No `cost` is written: the
OpenAI wire format carries none.

Not metered: calls the SDK rejects, streams not read to the frame that completes them,
the `chat.completions.stream()`, `responses.stream()` and `parse()` helpers, and every other
resource (`audio`, `images`, `files`, `batches`, ...), which are forwarded unmetered.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/openai/typescript/docs/reference.md): options, agent runs, streams, record fields, diagnostics, operational bounds
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/openai/typescript/examples): runnable against a local stand-in for the API, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/openai/typescript/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.1.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
