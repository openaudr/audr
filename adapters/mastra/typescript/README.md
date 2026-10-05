# @openaudr/audr-adapter-mastra

[![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-mastra?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-adapter-mastra)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-adapter-mastra)](https://www.npmjs.com/package/@openaudr/audr-adapter-mastra)

The **AUDR observability exporter** for [Mastra](https://mastra.ai) turns every provider
model call, embedding call and tool call into one
[AUDR](https://openaudr.dev/spec/v1.0.0/) record for an `@openaudr/audr` `Client` your
application owns. It reads usage, identifiers and timings only: never prompts, completions,
tool inputs, tool outputs or error messages.

> **Status: alpha.** The record model tracks AUDR v1.0.0; until 1.0.0, a minor release may
> change the public API.

## Setup

```bash
npm install @openaudr/audr @openaudr/audr-adapter-mastra @mastra/core @mastra/observability
```

Requires Node.js 22.12 or later, `@mastra/core` 1.62.0 or later and `@mastra/observability`
1.17.2 or later. All three packages are peer dependencies; the adapter imports only types
from `@mastra/*`.

## Usage

Register the exporter in Mastra's observability configuration:

```ts
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Observability } from '@mastra/observability';
import { Client } from '@openaudr/audr';
import { AudrExporter } from '@openaudr/audr-adapter-mastra';
import { FileSink } from '@openaudr/audr/file';

const client = new Client(new FileSink('audr.jsonl'), {
  emitter: { component: 'harness', name: 'my-app', version: '1.0.0' },
});
const exporter = new AudrExporter({ client, attributionDefaults: { environment: 'production' } });

const agent = new Agent({
  id: 'support',
  name: 'Support',
  instructions: 'Help customers with orders.',
  model: 'openai/gpt-5.4',
});
const mastra = new Mastra({
  agents: { agent },
  observability: new Observability({
    configs: {
      default: { serviceName: 'my-app', exporters: [exporter], includeInternalSpans: true },
    },
  }),
});

await agent.generate('Where is order 42?', {
  tracingOptions: {
    metadata: {
      audr: {
        account_id: 'acct_42',
        subscription_id: 'sub_7',
        user_id: 'u_8f14e45f', // pseudonymous, never an email or a name
        labels: { feature: 'support-chat' },
      },
    },
  },
});

await mastra.shutdown();
await client.shutdown();
```

Shut down Mastra first, then the client. A runnable version with a mock model and a tool is
[`examples/agent.ts`](https://github.com/openaudr/audr/blob/main/adapters/mastra/typescript/examples/agent.ts).

> [!IMPORTANT]
> Metered spans reach the exporter only when Mastra observability emits them. Keep
> `sampling.type` at `always`, set `includeInternalSpans: true` so that model calls made by
> structured output and built-in processors are metered, and leave `model_inference`,
> `rag_embedding`, `tool_call` and `mcp_tool_call` out of `excludeSpanTypes`. Keep
> `agent_run` and `workflow_run` there too: without them, a call from one agent to a
> sub-agent or workflow is also recorded as a tool execution. The exporter warns with
> `CONFIG_DROPS_SPANS` at registration when any of these settings applies.

## Attribution

Attribution is resolved per ended span from `metadata.audr` merged field by field over
`attributionDefaults`. The span wins, and `labels` merge by key. Metadata set on the root
span reaches every child span, so a tool call carries the attribution of the agent call that
made it. The usage example sets every supported attribution field.

Attribution can also come from the request context. Listing the key in
`requestContextKeys` makes Mastra copy it onto span metadata:

```ts
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { Observability } from '@mastra/observability';
import { Client } from '@openaudr/audr';
import { AudrExporter } from '@openaudr/audr-adapter-mastra';
import { FileSink } from '@openaudr/audr/file';

const client = new Client(new FileSink('audr.jsonl'), {
  emitter: { component: 'harness', name: 'my-app', version: '1.0.0' },
});
const exporter = new AudrExporter({ client, attributionDefaults: { environment: 'production' } });
const agent = new Agent({
  id: 'support',
  name: 'Support',
  instructions: 'Help customers with orders.',
  model: 'openai/gpt-5.4',
});
const mastra = new Mastra({
  agents: { agent },
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'my-app',
        exporters: [exporter],
        includeInternalSpans: true,
        requestContextKeys: ['audr'],
      },
    },
  }),
});

const requestContext = new RequestContext();
requestContext.set('audr', { account_id: 'acct_42' });
await agent.generate('Where is order 42?', { requestContext });

await mastra.shutdown();
await client.shutdown();
```

- `environment`, `user_id`, `account_id` and `subscription_id` are read when each is a
  string, and `labels` when it is an object of strings. The `Client` validates the result.
- A span with no `environment` after the merge is skipped with an `ATTRIBUTION_UNRESOLVED`
  warning rather than billed to a guess. Omit it from `attributionDefaults` to require it
  per call.

## Records

| Mastra span (`span_ended`) | `resource.operation` | `usage` |
| --- | --- | --- |
| `model_inference`, one per provider model call | `generation` | `llm` tokens, `requests: 1` |
| `rag_embedding` | `embedding` | `llm: { input_tokens?, requests: 1 }` |
| `tool_call`, `mcp_tool_call` | `tool_execution` | `tool: { type: 'invocation', call_count: 1 }` |

Cache and reasoning tokens are counted apart from `input_tokens` and `output_tokens`, and a
counter Mastra did not report is omitted rather than zeroed. Cost is never written.

Not metered: the tool call through which an agent invokes a sub-agent or a workflow, whose
own calls are metered; Mastra internal model calls unless `includeInternalSpans` is set;
provider-executed tools; and spans that sampling or filters drop.

## Documentation

- [Reference](https://github.com/openaudr/audr/blob/main/adapters/mastra/typescript/docs/reference.md): options, record fields and identifiers, provider slugs, diagnostics, operational bounds
- [Examples](https://github.com/openaudr/audr/tree/main/adapters/mastra/typescript/examples): runnable on mock models, without network access
- [Changelog](https://github.com/openaudr/audr/blob/main/adapters/mastra/typescript/CHANGELOG.md)
- [AUDR specification](https://openaudr.dev/spec/v1.0.0/), which defines every record field

## License

Apache-2.0. Contributions follow [`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).
