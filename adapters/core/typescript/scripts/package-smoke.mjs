// Run by tools/verify-npm-package.mjs in an empty project where the packed package is installed.
import { createRequire } from 'node:module';
import { Client, createRecord, VERSION } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { MemorySink, makeRecord } from '@openaudr/audr/testing';

const sink = new MemorySink();
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'verify', version: VERSION },
});
const { emitter: _omitted, ...record } = makeRecord();
const result = client.record(createRecord(record));
if (!result.queued) throw new Error('record was not queued');
await client.shutdown();
if (sink.records.length !== 1 || typeof FileSink !== 'function') throw new Error('smoke failed');

if (createRequire(import.meta.url)('@openaudr/audr').validate({}).length === 0) {
  throw new Error('require smoke failed');
}
