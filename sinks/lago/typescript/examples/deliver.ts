/**
 * Deliver one AUDR record through the Lago sink and print the event it became, billed against
 * the metric its `feature_id` names. A stand-in `fetch` answers for the Lago batch endpoint, so
 * the example runs without network access or credentials. Remove `fetch` to deliver to a real
 * Lago.
 *
 *   node examples/deliver.ts
 */
import { Client, createRecord } from '@openaudr/audr';
import { LagoSink } from '@openaudr/audr-sink-lago';

const lago: typeof fetch = (_input, init) => {
  const { events } = JSON.parse(init?.body as string) as { events: unknown[] };
  console.log(JSON.stringify(events[0], null, 2));
  return Promise.resolve(new Response(JSON.stringify({ events }), { status: 200 }));
};

const record = createRecord({
  resource: {
    provider: 'anthropic',
    type: 'model',
    name: 'claude-sonnet-5',
    operation: 'generation',
    modality: 'text',
  },
  usage: { llm: { input_tokens: 1200, output_tokens: 340, requests: 1 } },
  run: { run_id: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V', span_id: 'turn-3', run_type: 'agent_run' },
  attribution: {
    environment: 'production',
    account_id: 'acct_42',
    subscription_id: 'sub_42',
    feature_id: 'support-chat',
    labels: { region: 'eu' },
  },
});

const sink = new LagoSink({ apiKey: 'lago_test_key', fetch: lago });
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'my-harness', version: '1.4.0' },
});
const result = client.record(record);
if (!result.queued) throw new Error(`record rejected: ${JSON.stringify(result.issues)}`);

await client.shutdown(); // drains the queue, then closes the sink
console.log(client.stats);
