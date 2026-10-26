/**
 * Stream a response through an instrumented OpenAI client. The record is submitted when the
 * `response.completed` event arrives, before the loop sees it. `fetch` is answered locally:
 * no network, no credentials.
 *
 *   node examples/streaming.ts
 */
import { instrumentOpenAI } from '@openaudr/audr-adapter-openai';
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import OpenAI from 'openai';

// Stand-in for the OpenAI API: a Responses stream of two progress events and the terminal one.
globalThis.fetch = () => {
  const response = { id: 'resp_example_stream', object: 'response', model: 'gpt-5.4-2026-03-01' };
  const events = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: { ...response, status: 'in_progress' },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 1,
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'It shipped.',
    },
    {
      type: 'response.completed',
      sequence_number: 2,
      response: {
        ...response,
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 5620,
          output_tokens: 180,
          total_tokens: 5800,
          input_tokens_details: { cached_tokens: 5533 },
          output_tokens_details: { reasoning_tokens: 30 },
        },
      },
    },
  ];
  const sse = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return Promise.resolve(new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
};

const sink = new MemorySink();
const client = new Client(sink);
const openai = instrumentOpenAI(new OpenAI({ apiKey: 'sk-example' }), {
  client,
  attributionDefaults: { environment: 'test', account_id: 'acct_42' },
});

const stream = await openai.responses.create({
  model: 'gpt-5.4',
  input: 'Write a short answer.',
  stream: true,
});
const types: string[] = [];
for await (const event of stream) {
  types.push(event.type);
}

await client.shutdown();

const [record] = sink.records;
console.log(`events read: ${types.join(', ')}`);
console.log(`usage: ${JSON.stringify(record?.usage)}`);
