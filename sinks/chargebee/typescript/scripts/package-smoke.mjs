// Run by tools/verify-npm-package.mjs in an empty project where the packed package is installed.
import { Client } from '@openaudr/audr';
import { makeRecord } from '@openaudr/audr/testing';
import { ChargebeeSink } from '@openaudr/audr-sink-chargebee';

const requests = [];
const fetch = async (url, init) => {
  requests.push({ url, events: JSON.parse(init.body).events });
  return new Response(null, { status: 202 });
};
const sink = new ChargebeeSink({ site: 'acme', apiKey: 'test_key', fetch });
const client = new Client(sink, { logger: { warn() {}, error() {} } });
const record = makeRecord({ attribution: { environment: 'test', subscription_id: 'sub_1' } });
if (!client.record(record).queued) throw new Error('record was not queued');
await client.shutdown();
const [request] = requests;
if (request?.url !== 'https://acme.ingest.chargebee.com/api/v2/batch/usage_events') {
  throw new Error('batch did not reach the ingest endpoint');
}
if (request.events[0].deduplication_id !== record.record_id || client.stats.sent !== 1) {
  throw new Error('record was not delivered');
}
