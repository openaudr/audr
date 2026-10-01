/**
 * A Mastra agent metered through Observability. No network, no credentials.
 *
 *   node examples/agent.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { Observability } from '@mastra/observability';
import { type AudrRecord, Client } from '@openaudr/audr';
import { AudrExporter } from '@openaudr/audr-adapter-mastra';
import { FileSink } from '@openaudr/audr/file';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const usage = {
  inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: undefined },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
};

let calls = 0;
const model = new MockLanguageModelV3({
  provider: 'openai.chat',
  modelId: 'gpt-5.4',
  doGenerate: () => {
    calls += 1;
    const content =
      calls === 1
        ? [
            {
              type: 'tool-call' as const,
              toolCallId: 'tc-1',
              toolName: 'lookupOrder',
              input: JSON.stringify({ id: '42' }),
            },
          ]
        : [{ type: 'text' as const, text: 'Order 42 has shipped.' }];
    return Promise.resolve({
      content,
      finishReason: { unified: calls === 1 ? 'tool-calls' : 'stop', raw: undefined },
      usage,
      warnings: [],
    });
  },
});

const lookupOrder = createTool({
  id: 'lookupOrder',
  description: 'Look up an order by id',
  inputSchema: z.object({ id: z.string() }),
  execute: () => Promise.resolve({ status: 'shipped' }),
});

const dir = mkdtempSync(join(tmpdir(), 'audr-mastra-'));
const path = join(dir, 'audr.jsonl');
const client = new Client(new FileSink(path), {
  emitter: { component: 'harness', name: 'support-bot', version: '1.0.0' },
});
const exporter = new AudrExporter({ client, attributionDefaults: { environment: 'production' } });

const agent = new Agent({
  id: 'support',
  name: 'Support',
  instructions: 'Help customers with orders.',
  model,
  tools: { lookupOrder },
});
const mastra = new Mastra({
  agents: { agent },
  observability: new Observability({
    configs: { default: { serviceName: 'support-bot', exporters: [exporter] } },
  }),
});

await agent.generate('Where is order 42?', {
  maxSteps: 5,
  tracingOptions: { metadata: { audr: { account_id: 'acct_42', subscription_id: 'sub_7' } } },
});

await mastra.shutdown();
await client.shutdown();

const records = readFileSync(path, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as AudrRecord);
rmSync(dir, { recursive: true, force: true });

for (const record of records) {
  console.log(`${record.resource.operation} ${record.resource.name}`, record.usage);
}
const operations = records.map((record) => record.resource.operation).sort();
if (operations.join() !== 'generation,tool_execution') process.exitCode = 1;
