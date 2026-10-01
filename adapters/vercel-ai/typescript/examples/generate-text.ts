/**
 * Register the integration once, run a two-step tool loop on a mock model, and write the
 * records to a JSON Lines file. No network, no credentials.
 *
 *   node examples/generate-text.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateText, isStepCount, registerTelemetry, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { audrTelemetry } from '@openaudr/audr-adapter-vercel-ai';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { z } from 'zod';

const usage = {
  inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: undefined },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
};

// First call asks for a tool, second call answers.
const model = new MockLanguageModelV4({
  provider: 'openai.chat',
  modelId: 'gpt-5.4',
  doGenerate: [
    {
      content: [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'lookupOrder', input: '{"id":"42"}' },
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage,
      warnings: [],
    },
    {
      content: [{ type: 'text', text: 'Order 42 has shipped.' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    },
  ],
});

const lookupOrder = tool({
  description: 'Look up an order by id',
  inputSchema: z.object({ id: z.string() }),
  execute: () => Promise.resolve({ status: 'shipped' }),
});

const dir = mkdtempSync(join(tmpdir(), 'audr-vercel-ai-'));
const path = join(dir, 'audr.jsonl');
const client = new Client(new FileSink(path), {
  emitter: { component: 'harness', name: 'support-bot', version: '1.0.0' },
});

registerTelemetry(audrTelemetry({ client, attributionDefaults: { environment: 'production' } }));

await generateText({
  model,
  prompt: 'Where is order 42?',
  tools: { lookupOrder },
  stopWhen: isStepCount(3),
  runtimeContext: { audr: { account_id: 'acct_42', subscription_id: 'sub_7' } },
  telemetry: { includeRuntimeContext: { audr: true } },
});

// After the application has stopped starting AI SDK calls.
await client.shutdown();

const lines = readFileSync(path, 'utf8').trim().split('\n');
console.log(`records written: ${String(lines.length)}`);
console.log(`stats: ${JSON.stringify(client.stats)}`);
rmSync(dir, { recursive: true, force: true });
