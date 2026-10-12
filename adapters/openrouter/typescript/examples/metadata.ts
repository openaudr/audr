/**
 * Ask OpenRouter for router metadata, so that the result itself names the vendor and the
 * adapter makes no lookup. Compare `requests` with `examples/chat.ts`, which makes one
 * more. `fetch` is answered locally: no network, no credentials.
 *
 *   node examples/metadata.ts
 */
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { instrumentOpenRouter } from '@openaudr/audr-adapter-openrouter';
import { OpenRouter } from '@openrouter/sdk';

import { standIn } from './stand-in.ts';

const network = standIn({ provider: 'Google Vertex' });

const sink = new MemorySink();
const client = new Client(sink);
const openrouter = instrumentOpenRouter(new OpenRouter({ apiKey: 'sk-or-example' }), {
  client,
  attributionDefaults: { environment: 'production', account_id: 'acct_42' },
});

await openrouter.chat.send({
  chatRequest: {
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'Say hello.' }],
  },
  // The service then adds `openrouterMetadata` to the result, including the selected vendor.
  xOpenRouterMetadata: 'enabled',
});

await client.shutdown();

const [record] = sink.records;
if (record === undefined) throw new Error('no record was written');
console.log(`requests: ${network.requests.join(', ')}`);
console.log(`provider: ${record.resource.provider}`);
