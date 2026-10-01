/**
 * A tool that runs a nested `generateText`: the sub-agent's records join the parent's run
 * and point at the spawning tool span. No network.
 *
 *   node examples/sub-agent.ts
 */
import { generateText, isStepCount, registerTelemetry, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { audrTelemetry } from '@openaudr/audr-adapter-vercel-ai';
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { z } from 'zod';

const usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};
const answer = {
  content: [{ type: 'text' as const, text: 'done' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
};

const sink = new MemorySink();
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'research-bot', version: '1.0.0' },
});
registerTelemetry(audrTelemetry({ client, attributionDefaults: { environment: 'development' } }));

const research = tool({
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }) => {
    const { text } = await generateText({
      model: new MockLanguageModelV4({ provider: 'openai.chat', doGenerate: answer }),
      prompt: `Research ${topic}`,
    });
    return { summary: text };
  },
});

await generateText({
  model: new MockLanguageModelV4({
    provider: 'openai.chat',
    doGenerate: [
      {
        ...answer,
        content: [
          { type: 'tool-call', toolCallId: 'tc-1', toolName: 'research', input: '{"topic":"x"}' },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      },
      answer,
    ],
  }),
  prompt: 'Research x and summarise.',
  tools: { research },
  stopWhen: isStepCount(3),
});
await client.shutdown();

const runIds = new Set(sink.records.map((r) => r.run.run_id));
const children = sink.records.filter((r) => r.run.parent_span_id !== undefined);
console.log(`records: ${String(sink.records.length)}`);
console.log(`one shared run_id: ${String(runIds.size === 1)}`);
console.log(`sub-agent records carry parent_span_id: ${String(children.length === 1)}`);
