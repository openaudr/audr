import { validate } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index.js';
import { CHAT_PARAMS, chatCompletion, GENERATION_LLM, harness } from './helpers.js';

describe('generation record per chat completion', () => {
  it('records one valid generation record', async () => {
    const h = harness({ attributionDefaults: { environment: 'test', account_id: 'acct_1' } });
    h.fake.json(chatCompletion());
    await h.openai.chat.completions.create(CHAT_PARAMS);
    const [record, ...rest] = await h.records();
    expect(rest).toEqual([]);
    expect(validate(record)).toEqual([]);
    expect(record).toMatchObject({
      emitter: { component: 'harness', name: '@openaudr/audr-adapter-openai', version: VERSION },
      resource: {
        provider: 'openai',
        type: 'model',
        name: 'gpt-5.4-2026-03-01',
        operation: 'generation',
        modality: 'text',
      },
      usage: { llm: GENERATION_LLM },
      run: {
        run_id: 'chatcmpl-01J9Z8QK4M',
        span_id: 'chat:chatcmpl-01J9Z8QK4M',
        run_type: 'single_call',
      },
      attribution: { environment: 'test', account_id: 'acct_1' },
    });
    expect(record!.cost).toBeUndefined();
    expect(record!.run.error_code).toBeUndefined();
    expect(record!.run.step).toBeUndefined();
    expect(record!.timing.duration_ms).toBeGreaterThanOrEqual(0);
    expect(h.logger.lines).toEqual([]);
  });

  it('records the output modalities the request declares', async () => {
    const h = harness();
    h.fake.json(chatCompletion()).json(chatCompletion()).json(chatCompletion());
    await h.openai.chat.completions.create({ ...CHAT_PARAMS, modalities: ['audio'] });
    await h.openai.chat.completions.create({ ...CHAT_PARAMS, modalities: ['text', 'audio'] });
    await h.openai.chat.completions.create({ ...CHAT_PARAMS, modalities: null });
    const records = await h.records();
    expect(records.map(({ resource }) => resource.modality)).toEqual([
      'audio',
      'multimodal',
      'text',
    ]);
  });

  it('does not meter a native call that rejects', async () => {
    const h = harness();
    h.fake.json({ error: { type: 'invalid_request_error', message: 'bad' } }, 400);
    await expect(h.openai.chat.completions.create(CHAT_PARAMS)).rejects.toThrow();
    expect(await h.records()).toEqual([]);
    expect(h.logger.lines).toEqual([]);
  });
});

describe('token arithmetic', () => {
  it('keeps the counters whole when the detail objects are absent', async () => {
    const h = harness();
    h.fake.json(
      chatCompletion({ usage: { prompt_tokens: 41, completion_tokens: 1630, total_tokens: 1671 } }),
    );
    await h.openai.chat.completions.create(CHAT_PARAMS);
    const [record] = await h.records();
    expect(record!.usage.llm).toEqual({ input_tokens: 41, output_tokens: 1630, requests: 1 });
  });

  it('records the request alone when a response carries no usage', async () => {
    const h = harness();
    h.fake.json(chatCompletion({ usage: undefined }));
    await h.openai.chat.completions.create(CHAT_PARAMS);
    const [record] = await h.records();
    expect(record!.usage.llm).toEqual({ requests: 1 });
  });

  it('leaves an impossible counter to the Client, which rejects the record', async () => {
    const h = harness();
    h.fake.json(chatCompletion({ usage: { prompt_tokens: 10, completion_tokens: 1.5 } }));
    await h.openai.chat.completions.create(CHAT_PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings[0]).toMatch(
      /RECORD_NOT_QUEUED .*issues=\w+@\/usage\/llm\/output_tokens\)$/,
    );
  });
});
