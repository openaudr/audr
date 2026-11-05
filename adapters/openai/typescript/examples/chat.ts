/**
 * Instrument an OpenAI client once, run two calls of one agent run inside an attribution
 * scope, and write the records to a JSON Lines file. `fetch` is answered locally: no
 * network, no credentials.
 *
 *   node examples/chat.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { instrumentOpenAI, withAudr } from '@openaudr/audr-adapter-openai';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import OpenAI from 'openai';

// Stand-in for the OpenAI API: every POST /v1/chat/completions answers the same body.
let served = 0;
globalThis.fetch = () => {
  served += 1;
  const body = {
    id: `chatcmpl-example-${String(served)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-5.4-2026-03-01',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'It shipped.' }, finish_reason: 'stop' },
    ],
    usage: {
      prompt_tokens: 812,
      completion_tokens: 180,
      total_tokens: 992,
      prompt_tokens_details: { cached_tokens: 512 },
      completion_tokens_details: { reasoning_tokens: 40 },
    },
  };
  return Promise.resolve(Response.json(body));
};

const dir = mkdtempSync(join(tmpdir(), 'audr-openai-'));
const path = join(dir, 'audr.jsonl');
const client = new Client(new FileSink(path), {
  emitter: { component: 'harness', name: 'my-app', version: '1.0.0' },
});

const openai = instrumentOpenAI(new OpenAI({ apiKey: 'sk-example' }), {
  client,
  attributionDefaults: { environment: 'production' },
});

await withAudr(
  {
    attribution: { account_id: 'acct_42', subscription_id: 'sub_7', feature_id: 'support-chat' },
    run: { run_id: 'run-order-42-support', name: 'support-agent' },
  },
  async () => {
    await openai.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Where is order 42?' }],
    });
    await openai.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Summarise the answer.' }],
    });
  },
);

// After the application has stopped starting OpenAI calls and awaited the ones in flight.
await client.shutdown();

const lines = readFileSync(path, 'utf8').trim().split('\n');
console.log(`records written: ${String(lines.length)}`);
console.log(`stats: ${JSON.stringify(client.stats)}`);
rmSync(dir, { recursive: true, force: true });
