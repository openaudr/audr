/**
 * One adapter, three OpenAI-compatible endpoints. The provider comes from each client's
 * `baseURL`: Groq is known, a local Ollama is self-hosted, and a private gateway is named by
 * `mapResource`. `fetch` is answered locally: no network, no credentials.
 *
 *   node examples/providers.ts
 */
import { instrumentOpenAI } from '@openaudr/audr-adapter-openai';
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import OpenAI from 'openai';

// Stand-in for every endpoint: answers POST /chat/completions with the model requested.
globalThis.fetch = (_input, init) => {
  const { model } = JSON.parse(init?.body as string) as { model: string };
  return Promise.resolve(
    Response.json({
      id: `chatcmpl-${model}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    }),
  );
};

const sink = new MemorySink();
const client = new Client(sink);
const options = {
  client,
  attributionDefaults: { environment: 'test' as const, account_id: 'acct_42' },
  // Names the provider for a host the adapter does not know. Without it, calls to that host
  // are skipped with PROVIDER_UNRESOLVED rather than billed to a guess.
  mapResource: ({ baseUrl, model }: { baseUrl: string | undefined; model: string | undefined }) =>
    baseUrl?.includes('llm.example.internal') && model ? { provider: 'vllm', name: model } : null,
};

const groq = instrumentOpenAI(
  new OpenAI({ apiKey: 'gsk_example', baseURL: 'https://api.groq.com/openai/v1' }),
  options,
);
const ollama = instrumentOpenAI(
  new OpenAI({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' }),
  options,
);
const gateway = instrumentOpenAI(
  new OpenAI({ apiKey: 'internal', baseURL: 'https://llm.example.internal/v1' }),
  options,
);

const messages = [{ role: 'user' as const, content: 'Where is order 42?' }];
await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', messages });
await ollama.chat.completions.create({ model: 'llama3.2', messages });
await gateway.chat.completions.create({ model: 'mixtral-8x7b', messages });

await client.shutdown();

for (const record of sink.records) {
  console.log(JSON.stringify(record.resource));
}
