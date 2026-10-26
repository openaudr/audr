/**
 * Meter an embeddings call, attributing it per request. `fetch` is answered locally: no
 * network, no credentials.
 *
 *   node examples/embeddings.ts
 */
import { instrumentOpenAI, withAudr } from '@openaudr/audr-adapter-openai';
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import OpenAI from 'openai';

// Stand-in for the OpenAI API's POST /v1/embeddings. The SDK asks for base64 vectors.
globalThis.fetch = () =>
  Promise.resolve(
    Response.json({
      object: 'list',
      data: [
        { object: 'embedding', index: 0, embedding: 'AACAPwAAAEA=' },
        { object: 'embedding', index: 1, embedding: 'AABAQAAAgEA=' },
      ],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 8, total_tokens: 8 },
    }),
  );

const sink = new MemorySink();
const client = new Client(sink);
const openai = instrumentOpenAI(new OpenAI({ apiKey: 'sk-example' }), {
  client,
  attributionDefaults: { environment: 'test' },
});

await withAudr({ attribution: { account_id: 'acct_42', user_id: 'u_8f14e45f' } }, () =>
  openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: ['first document', 'second document'],
  }),
);

await client.shutdown();

const [record] = sink.records;
console.log(`resource: ${JSON.stringify(record?.resource)}`);
console.log(`usage: ${JSON.stringify(record?.usage)}`);
