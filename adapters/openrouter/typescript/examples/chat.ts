/**
 * Instrument an OpenRouter client once and send a chat completion. The result does not
 * name the vendor that served the call, so the adapter asks `generations.getGeneration()`
 * through the same client. `fetch` is answered locally: no network, no credentials.
 *
 *   node examples/chat.ts
 */
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { instrumentOpenRouter } from '@openaudr/audr-adapter-openrouter';
import { OpenRouter } from '@openrouter/sdk';

import { standIn } from './stand-in.ts';

const network = standIn();

const sink = new MemorySink();
const client = new Client(sink);
const openrouter = instrumentOpenRouter(new OpenRouter({ apiKey: 'sk-or-example' }), {
  client,
  attributionDefaults: { environment: 'production', account_id: 'acct_42' },
});

const completion = await openrouter.chat.send({
  chatRequest: {
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'Say hello.' }],
  },
});

// After the application has stopped starting calls and awaited the ones in flight.
await client.shutdown();

// Without `stream: true` the result is a completion; the SDK types it as a union.
if (!('choices' in completion)) throw new Error('expected a completion');

const [record] = sink.records;
if (record === undefined) throw new Error('no record was written');
console.log(`requests: ${network.requests.join(', ')}`);
console.log(`the host received completion ${completion.id}, unchanged`);
console.log(`provider: ${record.resource.provider}`);
console.log(`usage: ${JSON.stringify(record.usage.llm)}`);
console.log(`cost: ${JSON.stringify(record.cost)}`);
