import { validate } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { RESPONSE_FAILED_CODE, RESPONSE_INCOMPLETE_CODE } from '../src/index.js';
import { GENERATION_LLM, harness, response, RESPONSES_PARAMS } from './helpers.js';

describe('generation record per response', () => {
  it('records one valid generation record', async () => {
    const h = harness();
    h.fake.json(response());
    // The SDK adds `output_text` to a response, so the result is the body plus that field.
    expect(await h.openai.responses.create(RESPONSES_PARAMS)).toMatchObject(response());
    const [record, ...rest] = await h.records();
    expect(rest).toEqual([]);
    expect(validate(record)).toEqual([]);
    expect(record).toMatchObject({
      resource: {
        provider: 'openai',
        type: 'model',
        name: 'gpt-5.4-2026-03-01',
        operation: 'generation',
        modality: 'text',
      },
      usage: { llm: GENERATION_LLM },
      run: {
        run_id: 'resp_01J9Z8QK4M',
        span_id: 'response:resp_01J9Z8QK4M',
        run_type: 'single_call',
      },
    });
    expect(record!.run.error_code).toBeUndefined();
    expect(h.logger.lines).toEqual([]);
  });

  it('marks a failed or incomplete response and still reports its usage', async () => {
    const h = harness();
    h.fake.json(response({ status: 'failed' })).json(response({ status: 'incomplete' }));
    await h.openai.responses.create(RESPONSES_PARAMS);
    await h.openai.responses.create(RESPONSES_PARAMS);
    const [failed, incomplete] = await h.records();
    expect(failed!.run.error_code).toBe(RESPONSE_FAILED_CODE);
    expect(failed!.usage.llm).toEqual(GENERATION_LLM);
    expect(incomplete!.run.error_code).toBe(RESPONSE_INCOMPLETE_CODE);
  });

  it('records the request alone when a response carries no usage', async () => {
    const h = harness();
    h.fake.json(response({ usage: null }));
    await h.openai.responses.create(RESPONSES_PARAMS);
    const [record] = await h.records();
    expect(record!.usage.llm).toEqual({ requests: 1 });
  });
});
