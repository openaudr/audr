/**
 * Run two calls of one agent run inside an attribution scope and write the records to a
 * JSON Lines file. `fetch` is answered locally: no network, no credentials.
 *
 *   node examples/attribution.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { instrumentOpenRouter, withAudr } from '@openaudr/audr-adapter-openrouter';
import { OpenRouter } from '@openrouter/sdk';

import { standIn } from './stand-in.ts';

standIn();

const dir = mkdtempSync(join(tmpdir(), 'audr-openrouter-'));
const path = join(dir, 'audr.jsonl');
const client = new Client(new FileSink(path));

const openrouter = instrumentOpenRouter(new OpenRouter({ apiKey: 'sk-or-example' }), {
  client,
  attributionDefaults: { environment: 'production' },
});

const ask = (content: string) =>
  openrouter.chat.send({
    chatRequest: {
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content }],
    },
    xOpenRouterMetadata: 'enabled',
  });

await withAudr(
  {
    attribution: { account_id: 'acct_42', subscription_id: 'sub_7', labels: { team: 'support' } },
    run: { run_id: 'run-order-42-support', name: 'support-agent' },
  },
  async () => {
    await ask('Where is order 42?');
    await ask('Summarise the answer.');
  },
);

// After the application has stopped starting calls and awaited the ones in flight.
await client.shutdown();

const records = readFileSync(path, 'utf8')
  .trim()
  .split('\n')
  .map(
    (line) => JSON.parse(line) as { run: { run_id: string; span_id: string; run_type: string } },
  );
if (records.length !== 2) throw new Error('expected two records');
console.log(`records written: ${String(records.length)}`);
for (const { run } of records) {
  console.log(`${run.run_type} ${run.run_id} ${run.span_id}`);
}
console.log(`stats: ${JSON.stringify(client.stats)}`);
rmSync(dir, { recursive: true, force: true });
