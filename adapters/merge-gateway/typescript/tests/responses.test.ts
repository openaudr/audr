import { validate } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { RESPONSE_FAILED_CODE, VERSION } from '../src/index.js';
import { harness, response, RESPONSE_LLM } from './helpers.js';

const PARAMS = { model: 'openai/gpt-5.4', input: 'hi' };

describe('generation record per response', () => {
  it('records one valid generation record', async () => {
    const h = harness({ attributionDefaults: { environment: 'test', account_id: 'acct_1' } });
    h.fake.json(response());
    await h.gateway.responses.create(PARAMS);
    const [record, ...rest] = await h.records();
    expect(rest).toEqual([]);
    expect(validate(record)).toEqual([]);
    expect(record).toMatchObject({
      emitter: {
        component: 'router',
        name: '@openaudr/audr-adapter-merge-gateway',
        version: VERSION,
      },
      resource: {
        provider: 'merge-gateway',
        type: 'model',
        name: 'openai/gpt-5.4',
        operation: 'generation',
        modality: 'text',
      },
      usage: { llm: RESPONSE_LLM },
      cost: { total_cost: 0.002365, currency: 'USD' },
      run: {
        run_id: 'resp_01J9Z8QK4M',
        span_id: 'response:resp_01J9Z8QK4M',
        run_type: 'single_call',
      },
      attribution: { environment: 'test', account_id: 'acct_1' },
    });
    expect(record!.run.error_code).toBeUndefined();
    expect(record!.run.step).toBeUndefined();
    expect(record!.timing.duration_ms).toBeGreaterThanOrEqual(0);
    expect(h.logger.lines).toEqual([]);
  });

  it('records a response routed by a customer policy with no requested model', async () => {
    const h = harness();
    h.fake.json(response({ model: 'anthropic/claude-sonnet-5' }));
    await h.gateway.responses.create({ input: 'hi', customer: 'cus_1' });
    const [record] = await h.records();
    expect(record!.resource.name).toBe('anthropic/claude-sonnet-5');
  });

  it('records the output modalities requested from Gateway', async () => {
    const h = harness();
    h.fake.json(response()).json(response());
    await h.gateway.responses.create({ ...PARAMS, modalities: ['image'] });
    await h.gateway.responses.create({ ...PARAMS, modalities: ['text', 'image'] });
    const records = await h.records();
    expect(records.map(({ resource }) => resource.modality)).toEqual(['image', 'multimodal']);
  });

  it('does not meter a native call that rejects', async () => {
    const h = harness();
    h.fake.json({ error: { type: 'invalid_request', message: 'bad' } }, 400);
    await expect(h.gateway.responses.create(PARAMS)).rejects.toThrow();
    expect(await h.records()).toEqual([]);
    expect(h.logger.lines).toEqual([]);
  });
});

describe('token arithmetic', () => {
  it('keeps input_tokens and output_tokens whole when split counters are unreported', async () => {
    const h = harness();
    h.fake.json(
      response({
        usage: {
          input_tokens: 41,
          output_tokens: 1630,
          total_tokens: 1671,
          cache_creation_input_tokens: null,
          reasoning_output_tokens: null,
          cost: null,
        },
      }),
    );
    await h.gateway.responses.create(PARAMS);
    const [record] = await h.records();
    expect(record!.usage.llm).toEqual({ input_tokens: 41, output_tokens: 1630, requests: 1 });
    expect(record!.cost).toBeUndefined();
  });

  it('records the request alone when a response carries no usage', async () => {
    const h = harness();
    h.fake.json(response({ usage: undefined }));
    await h.gateway.responses.create(PARAMS);
    const [record] = await h.records();
    expect(record!.usage.llm).toEqual({ requests: 1 });
  });

  it('leaves an impossible counter to the Client, which rejects the record', async () => {
    const h = harness();
    h.fake.json(response({ usage: { input_tokens: 10, output_tokens: 1.5 } }));
    await h.gateway.responses.create(PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings[0]).toMatch(
      /RECORD_NOT_QUEUED .*issues=\w+@\/usage\/llm\/output_tokens\)$/,
    );
  });
});

describe('failed responses', () => {
  it('marks a failed response and still reports its usage', async () => {
    const h = harness();
    h.fake.json(response({ status: 'failed' }));
    await h.gateway.responses.create(PARAMS);
    const [record] = await h.records();
    expect(record!.run.error_code).toBe(RESPONSE_FAILED_CODE);
    expect(record!.usage.llm).toEqual(RESPONSE_LLM);
  });
});
