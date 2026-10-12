// Run by tools/verify-npm-package.mjs in an empty project where the packed package is installed.
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { instrumentOpenRouter } from '@openaudr/audr-adapter-openrouter';
import { OpenRouter } from '@openrouter/sdk';

const model = 'anthropic/claude-sonnet-4.5';
globalThis.fetch = () =>
  Promise.resolve(
    Response.json({
      id: 'gen-1759680000-smoke',
      object: 'chat.completion',
      created: 1759680000,
      model,
      system_fingerprint: null,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, cost: 0.0001 },
      openrouter_metadata: {
        attempt: 1,
        endpoints: { available: [{ model, provider: 'Anthropic', selected: true }], total: 1 },
        is_byok: false,
        region: null,
        requested: model,
        strategy: 'direct',
        summary: 'routed',
      },
    }),
  );

const sink = new MemorySink();
const client = new Client(sink, { logger: { warn() {}, error() {} } });
const openrouter = instrumentOpenRouter(new OpenRouter({ apiKey: 'sk-or-test' }), {
  client,
  attributionDefaults: { environment: 'test' },
});
if (!(openrouter instanceof OpenRouter)) throw new Error('facade is not an OpenRouter');
await openrouter.chat.send({
  chatRequest: { model, messages: [{ role: 'user', content: 'ping' }] },
  xOpenRouterMetadata: 'enabled',
});
await client.shutdown();
if (sink.records.length !== 1 || sink.records[0].usage.llm.input_tokens !== 12) {
  throw new Error('call was not metered');
}
if (sink.records[0].resource.provider !== 'anthropic') {
  throw new Error('vendor was not read from router metadata');
}
