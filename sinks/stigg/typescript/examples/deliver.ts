/**
 * Deliver one AUDR record through the Stigg sink and print the event it became, reported for
 * the customer its `account_id` names. A stand-in `fetch` answers for Stigg's events endpoint,
 * so the example runs without network access or credentials. Remove `fetch` to deliver to a
 * real Stigg environment with a server API key.
 *
 *   node examples/deliver.ts
 */
import { Client, createRecord } from '@openaudr/audr';
import { StiggSink } from '@openaudr/audr-sink-stigg';

const stigg: typeof fetch = (_input, init) => {
  const { events } = JSON.parse(init?.body as string) as { events: unknown[] };
  console.log(JSON.stringify(events[0], null, 2));
  return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 202 }));
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

const sink = new StiggSink({ apiKey: 'stigg_test_key', eventName: 'ai.usage', fetch: stigg });
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'my-harness', version: '1.4.0' },
});
const result = client.record(record);
if (!result.queued) throw new Error(`record rejected: ${JSON.stringify(result.issues)}`);

await client.shutdown(); // drains the queue, then closes the sink
console.log(client.stats);
