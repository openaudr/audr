import { validate } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { embedding, EMBEDDINGS_PARAMS, harness } from './helpers.js';

describe('embedding record', () => {
  it('records one valid embedding record per call', async () => {
    const h = harness();
    h.fake.json(embedding());
    // The SDK requests base64 vectors and decodes them, so the result is not the raw body.
    expect(await h.openai.embeddings.create(EMBEDDINGS_PARAMS)).toMatchObject({ object: 'list' });
    const [record, ...rest] = await h.records();
    expect(rest).toEqual([]);
    expect(validate(record)).toEqual([]);
    expect(record).toMatchObject({
      resource: {
        provider: 'openai',
        type: 'model',
        name: 'text-embedding-3-small',
        operation: 'embedding',
        modality: 'text',
      },
      usage: { llm: { input_tokens: 8, requests: 1 } },
      run: { run_type: 'single_call' },
    });
    expect(record!.cost).toBeUndefined();
    expect(record!.run.span_id).toBe(`embedding:${record!.run.run_id}`);
  });

  it('gives every embedding its own run and span', async () => {
    const h = harness();
    h.fake.json(embedding()).json(embedding());
    await h.openai.embeddings.create(EMBEDDINGS_PARAMS);
    await h.openai.embeddings.create(EMBEDDINGS_PARAMS);
    const [a, b] = await h.records();
    expect(a!.run.run_id).not.toBe(b!.run.run_id);
  });

  it('records the request alone when usage is unreported', async () => {
    const h = harness();
    h.fake.json(embedding({ usage: undefined }));
    await h.openai.embeddings.create(EMBEDDINGS_PARAMS);
    const [record] = await h.records();
    expect(record!.usage.llm).toEqual({ requests: 1 });
  });
});
