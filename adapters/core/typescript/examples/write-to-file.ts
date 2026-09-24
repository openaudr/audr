/**
 * Build one AUDR record and deliver it to a local JSON Lines file through a `Client`
 * backed by a `FileSink`.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, createRecord } from 'audr';
import { FileSink } from 'audr/file';

const record = createRecord({
  timing: { duration_ms: 812 }, // event_time defaults to now
  resource: {
    provider: 'anthropic',
    type: 'model',
    name: 'claude-sonnet-5',
    operation: 'generation',
    modality: 'text',
  },
  usage: { llm: { input_tokens: 1200, output_tokens: 340, requests: 1 } },
  run: { run_id: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V', span_id: 'turn-3', run_type: 'agent_run' },
  attribution: { environment: 'production', account_id: 'acct_42' },
}); // record_id and spec_version are filled in

const path = join(tmpdir(), 'audr-example.jsonl');
const client = new Client(new FileSink(path), {
  emitter: { component: 'harness', name: 'my-harness', version: '1.4.0' },
});
try {
  const result = client.record(record);
  if (!result.queued) throw new Error(`record rejected: ${JSON.stringify(result.issues)}`);
  await client.flush(5000);
  console.log(client.stats);
} finally {
  await client.shutdown(); // or `await using client = ...` on Node 24+ / compiled TypeScript
}
console.log(`wrote to ${path}`);
