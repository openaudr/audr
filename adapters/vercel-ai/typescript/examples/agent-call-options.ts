/**
 * Per-request attribution for a `ToolLoopAgent`: `callOptionsSchema` declares the request
 * options and `prepareCall` turns them into `runtimeContext.audr`. No network.
 *
 *   node examples/agent-call-options.ts
 */
import { ToolLoopAgent } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { audrTelemetry } from '@openaudr/audr-adapter-vercel-ai';
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { z } from 'zod';

const usage = {
  inputTokens: { total: 80, noCache: 80, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 12, text: 12, reasoning: undefined },
};

const model = new MockLanguageModelV4({
  provider: 'anthropic.messages',
  modelId: 'claude-sonnet-5',
  doGenerate: {
    content: [{ type: 'text', text: 'Refunds take five days.' }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage,
    warnings: [],
  },
});

const sink = new MemorySink();
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'support-bot', version: '1.0.0' },
});

const agent = new ToolLoopAgent({
  model,
  telemetry: {
    functionId: 'support-agent',
    integrations: [audrTelemetry({ client, attributionDefaults: { environment: 'production' } })],
    includeRuntimeContext: { audr: true },
  },
  callOptionsSchema: z.object({ accountId: z.string(), subscriptionId: z.string() }),
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    runtimeContext: {
      audr: { account_id: options.accountId, subscription_id: options.subscriptionId },
    },
  }),
});

await agent.generate({
  prompt: 'How long do refunds take?',
  options: { accountId: 'acct_42', subscriptionId: 'sub_7' },
});
await client.shutdown();

console.log(`records: ${String(sink.records.length)}`);
console.log(
  `every record attributed: ${String(sink.records.every((r) => r.attribution.account_id !== undefined))}`,
);
console.log(
  `run named after functionId: ${String(sink.records.every((r) => r.run.name === 'support-agent'))}`,
);
