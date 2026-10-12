/**
 * Stream a chat completion. The adapter records from the chunk that carries `usage` and
 * submits the record before the loop sees that chunk. `fetch` is answered locally: no
 * network, no credentials.
 *
 *   node examples/streaming.ts
 */
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { instrumentOpenRouter } from '@openaudr/audr-adapter-openrouter';
import { OpenRouter } from '@openrouter/sdk';

import { standIn } from './stand-in.ts';

standIn();

const sink = new MemorySink();
const client = new Client(sink);
const openrouter = instrumentOpenRouter(new OpenRouter({ apiKey: 'sk-or-example' }), {
  client,
  attributionDefaults: { environment: 'production', account_id: 'acct_42' },
});

const result = await openrouter.chat.send({
  chatRequest: {
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'Say hello.' }],
    stream: true,
  },
  xOpenRouterMetadata: 'enabled',
});

// With `stream: true` the result is an event stream; the SDK types it as a union.
if (!(Symbol.asyncIterator in result)) throw new Error('expected a stream');

let text = '';
for await (const chunk of result) {
  text += chunk.choices[0]?.delta.content ?? '';
  const submitted = String(client.stats.submitted);
  console.log(
    `chunk ${chunk.usage === undefined ? 'delta' : 'usage'}: records submitted so far ${submitted}`,
  );
}

await client.shutdown();

const [record] = sink.records;
if (record === undefined) throw new Error('no record was written');
console.log(`text: ${text}`);
console.log(`usage: ${JSON.stringify(record.usage.llm)}`);
