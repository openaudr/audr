// Run by tools/verify-npm-package.mjs in an empty project where the packed package is installed.
import { Client } from '@openaudr/audr';
import { makeRecord } from '@openaudr/audr/testing';
import { StiggSink } from '@openaudr/audr-sink-stigg';

const requests = [];
const fetch = async (url, init) => {
  requests.push({ url, headers: init.headers, events: JSON.parse(init.body).events });
  return new Response(JSON.stringify({ data: {} }), { status: 202 });
};
const sink = new StiggSink({
  apiUrl: 'https://stigg.example.test',
  apiKey: 'test_key',
  eventName: 'ai.usage',
  fetch,
});
const client = new Client(sink, { logger: { warn() {}, error() {} } });
const record = makeRecord({
  attribution: { environment: 'test', account_id: 'customer-1', subscription_id: 'sub_1' },
});
if (!client.record(record).queued) throw new Error('record was not queued');
await client.shutdown();
const [request] = requests;
if (request?.url !== 'https://stigg.example.test/api/v1/events') {
  throw new Error('batch did not reach the events endpoint');
}
if (request.headers['X-API-KEY'] !== 'test_key') throw new Error('key was not sent');
const [event] = request.events;
if (
  event.idempotencyKey !== record.record_id ||
  event.eventName !== 'ai.usage' ||
  event.customerId !== 'customer-1' ||
  'resourceId' in event ||
  event.dimensions.attribution__subscription_id !== 'sub_1'
) {
  throw new Error('record was not encoded');
}
if (client.stats.sent !== 1) throw new Error('record was not delivered');
