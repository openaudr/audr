import { describe, expect, it } from 'vitest';

import { withAudr } from '../src/index.js';
import { chatResult, embeddingsResult, generation, harness, responsesResult } from './helpers.js';

const CHAT = { chatRequest: { model: 'anthropic/claude-sonnet-4.5', messages: [] } };
const RUN = { run_id: 'run-0123456789', parent_span_id: 'span-parent', name: 'planner' };

describe('a call inside a run scope', () => {
  it('joins the host run: its id, parent span and name, as an agent_run', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult({ id: 'gen-aaaaaaaa' }));
    await withAudr({ run: RUN }, () => h.openrouter.chat.send(CHAT as never));
    const [record] = await h.records();
    expect(record?.run).toEqual({
      run_id: 'run-0123456789',
      span_id: 'chat:gen-aaaaaaaa',
      parent_span_id: 'span-parent',
      name: 'planner',
      run_type: 'agent_run',
    });
  });

  it('gives every call its own span in the shared run', async () => {
    const h = harness();
    h.fake
      .answer('chat.send', chatResult({ id: 'gen-one-aaaa' }))
      .answer('responses.send', responsesResult({ id: 'resp-two-bbbb' }))
      .answer('embeddings.generate', embeddingsResult({ id: 'gen-three-cccc' }))
      .answer('generations.getGeneration', generation());
    await withAudr({ run: RUN }, async () => {
      await h.openrouter.chat.send(CHAT);
      await h.openrouter.responses.send({ responsesRequest: {} });
      await h.openrouter.embeddings.generate({ requestBody: {} });
    });
    const records = await h.records();
    expect(records.map((record) => record.run.run_id)).toEqual([
      RUN.run_id,
      RUN.run_id,
      RUN.run_id,
    ]);
    expect(records.map((record) => record.run.span_id)).toEqual([
      'chat:gen-one-aaaa',
      'response:resp-two-bbbb',
      'embedding:gen-three-cccc',
    ]);
    expect(records.every((record) => record.run.run_type === 'agent_run')).toBe(true);
  });

  it('writes no parent span or name the scope did not set', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult());
    await withAudr({ run: { run_id: 'run-0123456789' } }, () =>
      h.openrouter.chat.send(CHAT as never),
    );
    const run = (await h.records())[0]?.run;
    expect(run?.run_id).toBe('run-0123456789');
    expect(run).not.toHaveProperty('parent_span_id');
    expect(run).not.toHaveProperty('name');
  });

  it('keeps the outer parent span and name when an inner scope repeats the run id', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult());
    await withAudr({ run: RUN }, () =>
      withAudr({ run: { run_id: RUN.run_id, parent_span_id: 'span-inner' } }, () =>
        h.openrouter.chat.send(CHAT as never),
      ),
    );
    const run = (await h.records())[0]?.run;
    expect(run?.parent_span_id).toBe('span-inner');
    expect(run?.name).toBe('planner');
  });

  it('is replaced entirely by an inner scope with another run id', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult());
    await withAudr({ run: RUN }, () =>
      withAudr({ run: { run_id: 'run-other-0001' } }, () => h.openrouter.chat.send(CHAT as never)),
    );
    const run = (await h.records())[0]?.run;
    expect(run?.run_id).toBe('run-other-0001');
    expect(run).not.toHaveProperty('parent_span_id');
    expect(run).not.toHaveProperty('name');
  });

  it('is kept by an inner scope that sets only attribution', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult());
    await withAudr({ run: RUN }, () =>
      withAudr({ attribution: { account_id: 'acct_inner' } }, () =>
        h.openrouter.chat.send(CHAT as never),
      ),
    );
    const [record] = await h.records();
    expect(record?.run.run_id).toBe(RUN.run_id);
    expect(record?.attribution.account_id).toBe('acct_inner');
  });

  it('is not reached by a call outside the scope', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult({ id: 'gen-outside-aaaa' }));
    await withAudr({ run: RUN }, () => Promise.resolve());
    await h.openrouter.chat.send(CHAT);
    const run = (await h.records())[0]?.run;
    expect(run?.run_id).toBe('gen-outside-aaaa');
    expect(run?.run_type).toBe('single_call');
  });
});

describe('a call outside a run scope', () => {
  it('is a single_call whose run_id is the response id when that fits', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult({ id: 'gen-single-aaaa' }));
    await h.openrouter.chat.send(CHAT);
    const run = (await h.records())[0]?.run;
    expect(run).toEqual({
      run_id: 'gen-single-aaaa',
      span_id: 'chat:gen-single-aaaa',
      run_type: 'single_call',
    });
  });

  it('gets a generated run_id when the response id is missing', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult({ id: undefined }));
    await h.openrouter.chat.send(CHAT);
    const run = (await h.records())[0]?.run;
    expect(run?.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run?.span_id).toBe(`chat:${run?.run_id}`);
  });

  it('generates a fresh run_id for each call that has none', async () => {
    const h = harness();
    h.fake
      .answer('chat.send', chatResult({ id: undefined }))
      .answer('chat.send', chatResult({ id: undefined }));
    await h.openrouter.chat.send(CHAT);
    await h.openrouter.chat.send(CHAT);
    const [first, second] = await h.records();
    expect(first?.run.run_id).not.toBe(second?.run.run_id);
  });
});
