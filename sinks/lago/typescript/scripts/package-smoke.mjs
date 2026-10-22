// Run by tools/verify-npm-package.mjs in an empty project where the packed package is installed.
import { Client } from '@openaudr/audr';
import { makeRecord } from '@openaudr/audr/testing';
import { LagoSink } from '@openaudr/audr-sink-lago';

const requests = [];
const fetch = async (url, init) => {
  requests.push({ url, events: JSON.parse(init.body).events });
  return new Response(JSON.stringify({ events: [] }), { status: 200 });
};
const sink = new LagoSink({
  apiUrl: 'https://lago.example.test',
  apiKey: 'test_key',
  fetch,
});
const client = new Client(sink, { logger: { warn() {}, error() {} } });
const record = makeRecord({
  attribution: { environment: 'test', subscription_id: 'sub_1', feature_id: 'ai_usage' },
});
if (!client.record(record).queued) throw new Error('record was not queued');
await client.shutdown();
const [request] = requests;
if (request?.url !== 'https://lago.example.test/api/v1/events/batch') {
  throw new Error('batch did not reach the batch endpoint');
}
const [event] = request.events;
if (event.transaction_id !== record.record_id || event.code !== 'ai_usage') {
  throw new Error('record was not encoded');
}
if (client.stats.sent !== 1) throw new Error('record was not delivered');
