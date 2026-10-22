/**
 * Instrument a MergeGateway once, run two calls of one agent run inside an attribution
 * scope, and write the records to a JSON Lines file. `fetch` is answered locally: no
 * network, no credentials.
 *
 *   node examples/responses.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { instrumentMergeGateway, withAudr } from '@openaudr/audr-adapter-merge-gateway';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { MergeGateway } from 'merge-gateway-sdk';

// Stand-in for the Gateway API: every POST /v1/responses answers the same body.
let served = 0;
globalThis.fetch = () => {
  served += 1;
  const body = {
    id: `resp_example_${String(served)}`,
    object: 'response',
    created_at: new Date().toISOString(),
    model: 'openai/gpt-5.4',
    vendor: 'openai',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [] }],
    usage: {
      input_tokens: 812,
      output_tokens: 180,
      total_tokens: 992,
      cache_read_input_tokens: 512,
      cost: 0.002365,
    },
  };
  return Promise.resolve(Response.json(body));
};

const dir = mkdtempSync(join(tmpdir(), 'audr-merge-gateway-'));
const path = join(dir, 'audr.jsonl');
const client = new Client(new FileSink(path));

const gateway = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_example' }), {
  client,
  attributionDefaults: { environment: 'production' },
});

await withAudr(
  {
    attribution: { account_id: 'acct_42', subscription_id: 'sub_7', feature_id: 'support-chat' },
    run: { run_id: 'run-order-42-support', name: 'support-agent' },
  },
  async () => {
    await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Where is order 42?' });
    await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Summarise the answer.' });
  },
);

// After the application has stopped starting Gateway calls and awaited the ones in flight.
await client.shutdown();

const lines = readFileSync(path, 'utf8').trim().split('\n');
console.log(`records written: ${String(lines.length)}`);
console.log(`stats: ${JSON.stringify(client.stats)}`);
rmSync(dir, { recursive: true, force: true });
