# @openaudr/audr-adapter-vercel-ai

[![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-vercel-ai?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-adapter-vercel-ai)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-adapter-vercel-ai)](https://www.npmjs.com/package/@openaudr/audr-adapter-vercel-ai)

The **AUDR telemetry integration** for the [Vercel AI SDK](https://ai-sdk.dev) turns every
provider model call, client-side tool execution, embedding call and rerank call into one
[AUDR](https://openaudr.dev/spec/v1.0.0/) record for an `@openaudr/audr` `Client` your
application owns. It reads usage, identifiers and timings only: never prompts, completions,
tool inputs, tool outputs or error messages.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
npm install @openaudr/audr @openaudr/audr-adapter-vercel-ai ai
```

Requires Node.js 22.12 or later and `ai` 7.0.98 or later within 7.x, the first release that
passes `runtimeContext` to embedding and rerank calls.

## Usage

Register the integration once at startup. Every `generateText`, `streamText`,
`ToolLoopAgent`, `embed`, `embedMany` and `rerank` call is then metered:

```ts
import { generateText, registerTelemetry } from 'ai';
import { audrTelemetry } from '@openaudr/audr-adapter-vercel-ai';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';

const client = new Client(new FileSink('audr.jsonl'), {
  emitter: { component: 'harness', name: 'my-app', version: '1.0.0' },
});
registerTelemetry(audrTelemetry({ client, attributionDefaults: { environment: 'production' } }));

await generateText({
  model: 'openai/gpt-5.4',
  prompt: 'Where is order 42?',
  runtimeContext: { audr: { account_id: 'acct_42', subscription_id: 'sub_7' } },
  telemetry: { includeRuntimeContext: { audr: true } },
});

// After the application has stopped starting AI SDK calls and awaited the ones in flight.
await client.shutdown();
```

A string model id resolves to the Vercel AI Gateway, so this record's `resource.provider` is
`vercel-ai-gateway`; [`mapResource`](https://github.com/openaudr/audr/blob/main/adapters/vercel-ai/typescript/docs/reference.md#provider-slugs)
attributes it to the model vendor instead.

Register one integration per client: every registered integration meters every call, so a
second registration, such as one per hot reload, records each operation twice. To meter
selected calls only, pass it per call with `telemetry: { integrations: [audr] }` instead.
A runnable version with a mock model is
[`examples/generate-text.ts`](https://github.com/openaudr/audr/blob/main/adapters/vercel-ai/typescript/examples/generate-text.ts).

> [!IMPORTANT]
> Metering follows the call's telemetry settings. `isEnabled: false` turns off every
> integration for that call, this one included, and a per-call `integrations` array
> **replaces** the registered ones: pass `integrations: [otel, audr]`, not `[otel]`.

## Attribution

Attribution is resolved once, when an operation starts, from `runtimeContext.audr` merged
field by field over `attributionDefaults`. The call wins, and `labels` merge by key:

```ts
await generateText({
  model,
  prompt, // model, prompt: see Usage above
  runtimeContext: {
    audr: {
      account_id: 'acct_42',
      user_id: 'u_8f14e45f', // pseudonymous, never an email or a name
      labels: { feature: 'support-chat' },
    },
  },
  telemetry: { includeRuntimeContext: { audr: true } },
});
```

- **`includeRuntimeContext: { audr: true }` is required.** The AI SDK removes every
  other `runtimeContext` key before integrations see it.
- `environment`, `user_id`, `account_id` and `subscription_id` are read when each is a
  string, and `labels` when it is an object of strings. The `Client` validates the result.
- An operation with no `environment` is skipped with an `ATTRIBUTION_UNRESOLVED` warning
  rather than billed to a guess. Omit it from `attributionDefaults` to require it per call.

For a `ToolLoopAgent`, return `runtimeContext` from `prepareCall`, as in
[`examples/agent-call-options.ts`](https://github.com/openaudr/audr/blob/main/adapters/vercel-ai/typescript/examples/agent-call-options.ts).
A call made inside a tool's `execute` joins the calling run, keeping its `run_id` and
attribution with `parent_span_id` set to the tool's span, as in
[`examples/sub-agent.ts`](https://github.com/openaudr/audr/blob/main/adapters/vercel-ai/typescript/examples/sub-agent.ts).

## Records

| AI SDK event | `resource.operation` | `usage` |
| --- | --- | --- |
| Each provider model call, one per tool-loop step | `generation` | `llm` tokens |
| Each client-side tool `execute` | `tool_execution` | `tool: { type: 'invocation', call_count: 1 }` |
| Each embedding provider call, one per `embedMany` chunk | `embedding` | `llm: { input_tokens?, requests: 1 }` |
| Each `rerank` provider call | `reranking` | `llm: { requests: 1 }` |

Cache and reasoning tokens are counted apart from `input_tokens` and `output_tokens`, and a
counter the provider did not report is omitted rather than zeroed. Cost is never written.

Not metered: tokens of a stream aborted mid-call, failed attempts that are retried,
provider-executed tools, the deprecated `generateObject` and `streamObject`, and image,
speech, transcription, video and realtime models.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/vercel-ai/typescript/docs/reference.md): options, record fields and identifiers, provider slugs, diagnostics, operational bounds
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/vercel-ai/typescript/examples): runnable on mock models, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/vercel-ai/typescript/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
