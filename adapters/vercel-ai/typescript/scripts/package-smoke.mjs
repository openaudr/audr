// Run by tools/verify-npm-package.mjs in an empty project where the packed package is installed.
import { generateText, registerTelemetry } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { audrTelemetry } from '@openaudr/audr-adapter-vercel-ai';

const model = new MockLanguageModelV4({
  provider: 'openai.chat',
  modelId: 'gpt-5.4',
  doGenerate: {
    content: [{ type: 'text', text: 'pong' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 7, text: 7, reasoning: undefined },
    },
    warnings: [],
  },
});
const sink = new MemorySink();
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'package-smoke', version: '0' },
  logger: { warn() {}, error() {} },
});
registerTelemetry(audrTelemetry({ client, attributionDefaults: { environment: 'test' } }));
await generateText({ model, prompt: 'ping' });
await client.shutdown();
if (sink.records.length !== 1 || sink.records[0].usage.llm.input_tokens !== 12) {
  throw new Error('call was not metered');
}
