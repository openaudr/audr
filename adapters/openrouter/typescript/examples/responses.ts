/**
 * Meter a Responses call billed to the caller's own provider key (BYOK). OpenRouter's
 * `cost` is only its fee in that case, so the adapter adds the provider's own charge from
 * `usage.costDetails`. `fetch` is answered locally: no network, no credentials.
 *
 *   node examples/responses.ts
 */
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { instrumentOpenRouter } from '@openaudr/audr-adapter-openrouter';
import { OpenRouter } from '@openrouter/sdk';

import { standIn } from './stand-in.ts';

const network = standIn({ provider: 'Anthropic', byok: true });

const sink = new MemorySink();
const client = new Client(sink);
const openrouter = instrumentOpenRouter(new OpenRouter({ apiKey: 'sk-or-example' }), {
  client,
  attributionDefaults: { environment: 'production', account_id: 'acct_42' },
});

const result = await openrouter.responses.send({
  responsesRequest: { model: 'anthropic/claude-sonnet-4.5', input: 'Say hello.' },
  // Router metadata names the vendor, so no lookup is needed; see examples/metadata.ts.
  xOpenRouterMetadata: 'enabled',
});

await client.shutdown();

const [record] = sink.records;
if (record === undefined) throw new Error('no record was written');
console.log(`requests: ${network.requests.join(', ')}`);
console.log(`status: ${'status' in result ? String(result.status) : 'streamed'}`);
console.log(`usage: ${JSON.stringify(record.usage.llm)}`);
console.log(`cost: ${JSON.stringify(record.cost)} (fee 0.0005 + provider 0.01)`);
