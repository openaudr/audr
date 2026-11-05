// Run by tools/verify-npm-package.mjs in an empty project where the packed package is installed.
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { instrumentOpenAI } from '@openaudr/audr-adapter-openai';
import OpenAI from 'openai';

globalThis.fetch = () =>
  Promise.resolve(
    Response.json({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-5.4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    }),
  );
const sink = new MemorySink();
const client = new Client(sink, { logger: { warn() {}, error() {} } });
const openai = instrumentOpenAI(new OpenAI({ apiKey: 'sk-test' }), {
  client,
  attributionDefaults: { environment: 'test' },
});
if (!(openai instanceof OpenAI)) throw new Error('facade is not an OpenAI');
await openai.chat.completions.create({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'ping' }],
});
await client.shutdown();
if (sink.records.length !== 1 || sink.records[0].usage.llm.input_tokens !== 12) {
  throw new Error('call was not metered');
}
