/**
 * Meter an embeddings call. An embeddings result never names the vendor, so the adapter
 * always asks `generations.getGeneration()`; `lookup` bounds how long it may wait.
 * `fetch` is answered locally: no network, no credentials.
 *
 *   node examples/embeddings.ts
 */
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { instrumentOpenRouter } from '@openaudr/audr-adapter-openrouter';
import { OpenRouter } from '@openrouter/sdk';

import { standIn } from './stand-in.ts';

const network = standIn({ provider: 'OpenAI' });

const sink = new MemorySink();
const client = new Client(sink);
const openrouter = instrumentOpenRouter(new OpenRouter({ apiKey: 'sk-or-example' }), {
  client,
  attributionDefaults: { environment: 'production', account_id: 'acct_42' },
  // At most 2 s for the whole lookup, retries included; `maxWaitMs: 0` turns it off.
  lookup: { maxWaitMs: 2000 },
});

await openrouter.embeddings.generate({
  requestBody: { model: 'openai/text-embedding-3-small', input: 'Hello' },
});

await client.shutdown();

const [record] = sink.records;
if (record === undefined) throw new Error('no record was written');
console.log(`requests: ${network.requests.join(', ')}`);
console.log(`resource: ${JSON.stringify(record.resource)}`);
console.log(`usage: ${JSON.stringify(record.usage.llm)}`);
