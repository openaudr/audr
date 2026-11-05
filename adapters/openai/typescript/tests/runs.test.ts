import { describe, expect, it } from 'vitest';

import { withAudr } from '../src/index.js';
import {
  CHAT_PARAMS,
  chatCompletion,
  embedding,
  EMBEDDINGS_PARAMS,
  harness,
  response,
  RESPONSES_PARAMS,
} from './helpers.js';

describe('run identifiers', () => {
  it('joins every call in a run scope', async () => {
    const h = harness();
    h.fake
      .json(chatCompletion({ id: 'chatcmpl-aaaaaaaa' }))
      .json(embedding())
      .json(response({ id: 'resp_bbbbbbbb' }));
    await withAudr(
      { run: { run_id: 'run-0001-support', parent_span_id: 'agent:1', name: 'support-agent' } },
      async () => {
        await h.openai.chat.completions.create(CHAT_PARAMS);
        await h.openai.embeddings.create(EMBEDDINGS_PARAMS);
        await h.openai.responses.create(RESPONSES_PARAMS);
      },
    );
    const records = await h.records();
    const shared = {
      run_id: 'run-0001-support',
      parent_span_id: 'agent:1',
      name: 'support-agent',
      run_type: 'agent_run',
    };
    expect(records.map((r) => r.run)).toEqual([
      { ...shared, span_id: 'chat:chatcmpl-aaaaaaaa' },
      { ...shared, span_id: expect.stringMatching(/^embedding:[0-9a-f-]{36}$/) as unknown },
      { ...shared, span_id: 'response:resp_bbbbbbbb' },
    ]);
  });

  it('writes no step, so repeated scopes of one run never collide', async () => {
    const h = harness();
    h.fake
      .json(chatCompletion({ id: 'chatcmpl-aaaaaaaa' }))
      .json(chatCompletion({ id: 'chatcmpl-bbbbbbbb' }));
    const run = { run_id: 'run-0001-support' };
    await withAudr({ run }, () => h.openai.chat.completions.create(CHAT_PARAMS));
    await withAudr({ run }, () => h.openai.chat.completions.create(CHAT_PARAMS));
    const records = await h.records();
    expect(records.map((r) => [r.run.run_id, r.run.span_id, r.run.step])).toEqual([
      ['run-0001-support', 'chat:chatcmpl-aaaaaaaa', undefined],
      ['run-0001-support', 'chat:chatcmpl-bbbbbbbb', undefined],
    ]);
  });

  it('a nested scope of the same run keeps its name and replaces its parent', async () => {
    const h = harness();
    h.fake.json(chatCompletion()).json(chatCompletion());
    await withAudr({ run: { run_id: 'run-0001-support', name: 'support-agent' } }, async () => {
      await h.openai.chat.completions.create(CHAT_PARAMS);
      await withAudr({ run: { run_id: 'run-0001-support', parent_span_id: 'tool:1' } }, () =>
        h.openai.chat.completions.create(CHAT_PARAMS),
      );
    });
    const [first, second] = await h.records();
    expect(first!.run.parent_span_id).toBeUndefined();
    expect(second!.run).toMatchObject({ name: 'support-agent', parent_span_id: 'tool:1' });
  });

  it('a nested scope of another run inherits nothing from the outer run', async () => {
    const h = harness();
    h.fake.json(chatCompletion());
    await withAudr(
      { run: { run_id: 'run-0001-outer', parent_span_id: 'agent:1', name: 'outer' } },
      () =>
        withAudr({ run: { run_id: 'run-0002-inner' } }, () =>
          h.openai.chat.completions.create(CHAT_PARAMS),
        ),
    );
    const [inner] = await h.records();
    expect(inner!.run).toEqual({
      run_id: 'run-0002-inner',
      span_id: 'chat:chatcmpl-01J9Z8QK4M',
      run_type: 'agent_run',
    });
  });

  it('an attribution-only scope keeps the outer run', async () => {
    const h = harness();
    h.fake.json(chatCompletion());
    await withAudr({ run: { run_id: 'run-0001-outer' } }, () =>
      withAudr({ attribution: { account_id: 'acct_1' } }, () =>
        h.openai.chat.completions.create(CHAT_PARAMS),
      ),
    );
    const [record] = await h.records();
    expect(record!.run.run_id).toBe('run-0001-outer');
  });

  it('a run_id outside 8 to 64 characters is rejected by the Client', async () => {
    const h = harness();
    h.fake.json(chatCompletion());
    await withAudr({ run: { run_id: 'short' } }, () =>
      h.openai.chat.completions.create(CHAT_PARAMS),
    );
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings[0]).toMatch(/RECORD_NOT_QUEUED .*issues=\w+@\/run\/run_id\)$/);
  });

  it('mints a run id when the response id does not fit', async () => {
    const h = harness();
    const long = `chatcmpl-${'x'.repeat(80)}`;
    h.fake
      .json(chatCompletion({ id: 'short' }))
      .json(chatCompletion({ id: long }))
      .json(chatCompletion({ id: undefined }));
    await h.openai.chat.completions.create(CHAT_PARAMS);
    await h.openai.chat.completions.create(CHAT_PARAMS);
    await h.openai.chat.completions.create(CHAT_PARAMS);
    const [short, tooLong, missing] = await h.records();
    expect(short!.run.span_id).toBe('chat:short');
    expect(short!.run.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tooLong!.run.span_id).toBe(`chat:${long}`);
    expect(tooLong!.run.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(missing!.run.span_id).toBe(`chat:${missing!.run.run_id}`);
  });
});
