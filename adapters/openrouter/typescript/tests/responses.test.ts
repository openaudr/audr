import { describe, expect, it } from 'vitest';

import { RESPONSE_FAILED_CODE, RESPONSE_INCOMPLETE_CODE } from '../src/index.js';
import {
  generation,
  GENERATION_ID,
  harness,
  LLM,
  responsesResult,
  responsesUsage,
} from './helpers.js';

const REQUEST = { responsesRequest: { model: 'anthropic/claude-sonnet-4.5', input: 'hi' } };

async function sendResponses(result: Record<string, unknown>, request: unknown = REQUEST) {
  const h = harness();
  h.fake.answer('responses.send', result);
  await h.openrouter.responses.send(request);
  return { h, records: await h.records() };
}

describe('responses.send()', () => {
  it('records one generation from the result and router metadata, with no lookup', async () => {
    const { h, records } = await sendResponses(responsesResult());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      resource: {
        provider: 'amazon-bedrock',
        type: 'model',
        name: 'anthropic/claude-sonnet-4.5',
        operation: 'generation',
        modality: 'text',
      },
      usage: { llm: LLM },
      cost: { total_cost: 0.0123, currency: 'USD' },
      run: {
        run_id: GENERATION_ID,
        span_id: `response:${GENERATION_ID}`,
        run_type: 'single_call',
      },
    });
    expect(records[0]?.run).not.toHaveProperty('error_code');
    expect(h.fake.lookups).toHaveLength(0);
    expect(h.logger.lines).toEqual([]);
  });

  it('asks the lookup for the vendor when the result carries no metadata', async () => {
    const h = harness();
    h.fake
      .answer('responses.send', responsesResult({ openrouterMetadata: undefined }))
      .answer('generations.getGeneration', generation({ providerName: 'Anthropic' }));
    await h.openrouter.responses.send(REQUEST);
    const [record] = await h.records();
    expect(record?.resource.provider).toBe('anthropic');
    expect(h.fake.lookups[0]?.args[0]).toEqual({ id: GENERATION_ID });
  });

  it('keeps explicit zero counters, including a zero reasoning count', async () => {
    const { records } = await sendResponses(
      responsesResult({
        usage: responsesUsage({
          inputTokens: 10,
          outputTokens: 5,
          inputTokensDetails: { cachedTokens: 0 },
          outputTokensDetails: { reasoningTokens: 0 },
        }),
      }),
    );
    expect(records[0]?.usage.llm).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      reasoning_tokens: 0,
      requests: 1,
    });
  });

  it('subtracts cache writes as well as reads, and omits an absent write counter', async () => {
    const { records } = await sendResponses(
      responsesResult({
        usage: responsesUsage({
          inputTokens: 100,
          inputTokensDetails: { cachedTokens: 30, cacheWriteTokens: null },
          outputTokensDetails: { reasoningTokens: 0 },
        }),
      }),
    );
    expect(records[0]?.usage.llm).toMatchObject({
      input_tokens: 70,
      cache_read_tokens: 30,
    });
    expect(records[0]?.usage.llm).not.toHaveProperty('cache_write_tokens');
    const withWrites = await sendResponses(
      responsesResult({
        usage: responsesUsage({
          inputTokens: 100,
          inputTokensDetails: { cachedTokens: 30, cacheWriteTokens: 50 },
        }),
      }),
    );
    expect(withWrites.records[0]?.usage.llm).toMatchObject({
      input_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 50,
    });
  });

  it('clamps at zero and omits counters the result does not report', async () => {
    const { records } = await sendResponses(
      responsesResult({
        usage: responsesUsage({
          inputTokens: 10,
          inputTokensDetails: { cachedTokens: 50 },
          outputTokens: undefined,
          outputTokensDetails: undefined,
        }),
      }),
    );
    expect(records[0]?.usage.llm).toEqual({ input_tokens: 0, cache_read_tokens: 50, requests: 1 });
  });

  it.each([
    ['completed', undefined],
    ['failed', RESPONSE_FAILED_CODE],
    ['incomplete', RESPONSE_INCOMPLETE_CODE],
    ['cancelled', undefined],
    ['in_progress', undefined],
    ['some_future_status', undefined],
  ])('status %s sets run.error_code to %s', async (status, code) => {
    const { records } = await sendResponses(responsesResult({ status }));
    expect(records[0]?.run.error_code).toBe(code);
    expect(records).toHaveLength(1);
  });

  it('skips a result with no usage object and says so', async () => {
    const { h, records } = await sendResponses(responsesResult({ status: 'failed', usage: null }));
    expect(records).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: USAGE_UNREPORTED (operation=responses.send)',
    ]);
  });

  it('derives modality from the declared selectors only', async () => {
    const both = await sendResponses(responsesResult(), {
      responsesRequest: { model: 'm', modalities: ['text', 'image'] },
    });
    expect(both.records[0]?.resource.modality).toBe('multimodal');
    const image = await sendResponses(responsesResult(), {
      responsesRequest: { model: 'm', modalities: ['image'] },
    });
    expect(image.records[0]?.resource.modality).toBe('image');
    const none = await sendResponses(responsesResult(), { responsesRequest: { model: 'm' } });
    expect(none.records[0]?.resource.modality).toBe('text');
  });
});
