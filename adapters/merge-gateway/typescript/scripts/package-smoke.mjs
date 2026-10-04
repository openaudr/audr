// Run by tools/verify-npm-package.mjs in an empty project where the packed package is installed.
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { instrumentMergeGateway } from '@openaudr/audr-adapter-merge-gateway';
import { MergeGateway } from 'merge-gateway-sdk';

globalThis.fetch = () =>
  Promise.resolve(
    Response.json({
      id: 'resp_1',
      object: 'response',
      created_at: new Date().toISOString(),
      model: 'openai/gpt-5.4',
      vendor: 'openai',
      output: [],
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, cost: 0.0001 },
    }),
  );
const sink = new MemorySink();
const client = new Client(sink, { logger: { warn() {}, error() {} } });
const gateway = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_test' }), {
  client,
  attributionDefaults: { environment: 'test' },
});
if (!(gateway instanceof MergeGateway)) throw new Error('facade is not a MergeGateway');
await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'ping' });
await client.shutdown();
if (sink.records.length !== 1 || sink.records[0].usage.llm.input_tokens !== 12) {
  throw new Error('call was not metered');
}
