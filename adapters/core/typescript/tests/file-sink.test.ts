import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSink } from '../src/file-sink.js';
import { decodeRecord, encodeRecord } from '../src/index.js';
import { assertSinkContract, makeRecord } from '../src/testing.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'audr-file-sink-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
}

describe('FileSink', () => {
  it('writes one sorted-key JSON line per record', async () => {
    const path = join(directory, 'audr.jsonl');
    const sink = new FileSink(path);
    const records = [makeRecord(), makeRecord()];
    expect(await sink.deliver(records)).toEqual({ outcome: 'accepted' });
    await sink.close();
    const written = await lines(path);
    expect(written).toEqual(records.map((record) => encodeRecord(record)));
    expect(written.map((line) => decodeRecord(line))).toEqual(records);
  });

  it('appends by default and truncates when asked', async () => {
    const path = join(directory, 'audr.jsonl');
    await writeFile(path, 'existing\n');
    const appending = new FileSink(path);
    await appending.deliver([makeRecord()]);
    await appending.close();
    expect(await lines(path)).toHaveLength(2);

    const truncating = new FileSink(new URL(`file://${path}`), { append: false });
    await truncating.deliver([makeRecord()]);
    await truncating.deliver([makeRecord()]);
    await truncating.close();
    expect(await lines(path)).toHaveLength(2);
  });

  it('reports a write failure as retryable, naming only the error code', async () => {
    const sink = new FileSink(join(directory, 'missing', 'audr.jsonl'));
    expect(await sink.deliver([makeRecord()])).toEqual({
      outcome: 'retryable_failure',
      detail: 'ENOENT',
    });
    await sink.close();
  });

  it('writes concurrent deliveries one after another through one handle', async () => {
    const path = join(directory, 'audr.jsonl');
    const sink = new FileSink(path, { append: false });
    const batches = [0, 1, 2].map(() => [makeRecord(), makeRecord()]);
    const results = await Promise.all(batches.map((batch) => sink.deliver(batch)));
    await sink.close();
    expect(results).toEqual([0, 1, 2].map(() => ({ outcome: 'accepted' })));
    expect(await lines(path)).toEqual(batches.flat().map((record) => encodeRecord(record)));
  });

  it('writes deliveries requested before close() and refuses later ones', async () => {
    const path = join(directory, 'audr.jsonl');
    const sink = new FileSink(path);
    const early = sink.deliver([makeRecord()]);
    const closing = Promise.all([sink.close(), sink.close()]);
    const late = sink.deliver([makeRecord()]);
    await closing;
    expect(await early).toEqual({ outcome: 'accepted' });
    expect(await late).toEqual({ outcome: 'closed' });
    expect(await lines(path)).toHaveLength(1);
  });

  it('answers closed after close()', async () => {
    const sink = new FileSink(join(directory, 'audr.jsonl'));
    await sink.close();
    expect(await sink.deliver([makeRecord()])).toEqual({ outcome: 'closed' });
  });

  it('honours the sink contract', async () => {
    await assertSinkContract(new FileSink(join(directory, 'audr.jsonl')));
  });
});
