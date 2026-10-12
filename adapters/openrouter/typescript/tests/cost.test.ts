import { describe, expect, it } from 'vitest';

import { resolveCost } from '../src/mapping.js';
import {
  chatResult,
  chatUsage,
  embeddingsResult,
  generation,
  harness,
  LLM,
  responsesResult,
  responsesUsage,
} from './helpers.js';

const CHAT = { chatRequest: { model: 'anthropic/claude-sonnet-4.5', messages: [] } };
const WARNING = (code: string): string =>
  `@openaudr/audr-adapter-openrouter: ${code} (operation=chat.send)`;

async function chat(
  result: Record<string, unknown>,
  lookups: readonly (Record<string, unknown> | Error)[] = [],
) {
  const h = harness();
  h.fake.answer('chat.send', result);
  for (const lookup of lookups) {
    if (lookup instanceof Error) h.fake.fail('generations.getGeneration', lookup);
    else h.fake.answer('generations.getGeneration', lookup);
  }
  await h.openrouter.chat.send(CHAT);
  return { h, records: await h.records() };
}

const byok = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  chatUsage({ isByok: true, cost: 0.0005, ...overrides });

describe('cost of a call that is not BYOK', () => {
  it('is usage.cost', async () => {
    const { records } = await chat(chatResult());
    expect(records[0]?.cost).toEqual({ total_cost: 0.0123, currency: 'USD' });
  });

  it('ignores an upstream figure', async () => {
    const { h, records } = await chat(
      chatResult({
        usage: chatUsage({ cost: 0.01, costDetails: { upstreamInferenceCost: 0.01 } }),
      }),
    );
    expect(records[0]?.cost?.total_cost).toBe(0.01);
    expect(h.fake.lookups).toHaveLength(0);
    expect(h.logger.lines).toEqual([]);
  });

  it('keeps a cost of zero', async () => {
    const { records } = await chat(chatResult({ usage: chatUsage({ cost: 0 }) }));
    expect(records[0]?.cost).toEqual({ total_cost: 0, currency: 'USD' });
  });

  it.each([null, undefined])(
    'writes no cost when usage.cost is %s, and says nothing',
    async (cost) => {
      const { h, records } = await chat(chatResult({ usage: chatUsage({ cost }) }));
      expect(records[0]).toBeDefined();
      expect(records[0]).not.toHaveProperty('cost');
      expect(h.logger.lines).toEqual([]);
    },
  );

  it('does not add serverToolCost, which OpenRouter already charged', async () => {
    const { records } = await chat(
      chatResult({
        usage: chatUsage({ cost: 0.02, costDetails: { serverToolCost: 0.005 } }),
      }),
    );
    expect(records[0]?.cost?.total_cost).toBe(0.02);
  });
});

describe('cost of a BYOK call', () => {
  it('is usage.cost plus the upstream cost in the usage, with no lookup', async () => {
    const { h, records } = await chat(
      chatResult({ usage: byok({ costDetails: { upstreamInferenceCost: 0.01 } }) }),
    );
    expect(records[0]?.cost?.total_cost).toBeCloseTo(0.0105, 12);
    expect(records[0]?.cost?.currency).toBe('USD');
    expect(records[0]?.usage.llm).toEqual(LLM);
    expect(h.fake.lookups).toHaveLength(0);
    expect(h.logger.lines).toEqual([]);
  });

  it('takes the upstream cost from the lookup when the usage lacks it', async () => {
    const { h, records } = await chat(chatResult({ usage: byok() }), [
      generation({ isByok: true, upstreamInferenceCost: 0.01 }),
    ]);
    expect(records[0]?.cost?.total_cost).toBeCloseTo(0.0105, 12);
    expect(h.fake.lookups).toHaveLength(1);
    expect(h.logger.lines).toEqual([]);
  });

  it('does not add serverToolCost either', async () => {
    const { records } = await chat(
      chatResult({
        usage: byok({ costDetails: { upstreamInferenceCost: 0.01, serverToolCost: 0.005 } }),
      }),
    );
    expect(records[0]?.cost?.total_cost).toBeCloseTo(0.0105, 12);
  });

  it('adds an upstream cost of zero', async () => {
    const { records } = await chat(
      chatResult({ usage: byok({ cost: 0, costDetails: { upstreamInferenceCost: 0 } }) }),
    );
    expect(records[0]?.cost?.total_cost).toBe(0);
  });

  it('writes usage without cost, and says so, when the lookup has no upstream figure', async () => {
    const { h, records } = await chat(chatResult({ usage: byok() }), [
      generation({ isByok: true, upstreamInferenceCost: null }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.usage.llm).toEqual(LLM);
    expect(records[0]).not.toHaveProperty('cost');
    expect(h.logger.warnings).toEqual([WARNING('BYOK_COST_INCOMPLETE')]);
  });

  it('writes usage without cost when the lookup fails', async () => {
    const { h, records } = await chat(chatResult({ usage: byok() }), [
      Object.assign(new Error('x'), { statusCode: 402 }),
    ]);
    expect(records[0]?.usage.llm).toEqual(LLM);
    expect(records[0]).not.toHaveProperty('cost');
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: LOOKUP_FAILED (operation=chat.send, reason=rejected)',
      WARNING('BYOK_COST_INCOMPLETE'),
    ]);
  });

  it('writes no cost, without a lookup, when OpenRouter reported no fee', async () => {
    const { h, records } = await chat(
      chatResult({
        usage: byok({ cost: undefined, costDetails: { upstreamInferenceCost: 0.01 } }),
      }),
    );
    expect(records[0]).not.toHaveProperty('cost');
    expect(h.fake.lookups).toHaveLength(0);
    expect(h.logger.warnings).toEqual([WARNING('BYOK_COST_INCOMPLETE')]);
  });

  it('takes the BYOK flag from router metadata when the usage lacks it', async () => {
    const { records } = await chat(
      chatResult({
        usage: chatUsage({
          isByok: undefined,
          cost: 0.0005,
          costDetails: { upstreamInferenceCost: 0.01 },
        }),
        openrouterMetadata: { ...(chatResult().openrouterMetadata as object), isByok: true },
      }),
    );
    expect(records[0]?.cost?.total_cost).toBeCloseTo(0.0105, 12);
  });

  it('prefers the usage flag to the metadata flag', async () => {
    const { records } = await chat(
      chatResult({
        usage: chatUsage({ isByok: false, cost: 0.01, costDetails: { upstreamInferenceCost: 9 } }),
        openrouterMetadata: { ...(chatResult().openrouterMetadata as object), isByok: true },
      }),
    );
    expect(records[0]?.cost?.total_cost).toBe(0.01);
  });
});

describe('cost when the BYOK status is not reported', () => {
  const unknown = chatResult({
    openrouterMetadata: undefined,
    usage: chatUsage({ isByok: undefined, cost: 0.0005 }),
  });

  it('comes from the lookup', async () => {
    const { records } = await chat(unknown, [
      generation({ providerName: 'Anthropic', isByok: true, upstreamInferenceCost: 0.01 }),
    ]);
    expect(records[0]?.cost?.total_cost).toBeCloseTo(0.0105, 12);

    const plain = await chat(unknown, [generation({ providerName: 'Anthropic', isByok: false })]);
    expect(plain.records[0]?.cost?.total_cost).toBe(0.0005);
  });

  it('is withheld, rather than guessed, when no source reports it', async () => {
    const h = harness({
      lookup: { maxWaitMs: 0 },
      mapResource: () => ({ provider: 'anthropic', name: 'claude' }),
    });
    h.fake.answer('chat.send', unknown);
    await h.openrouter.chat.send(CHAT);
    const [record] = await h.records();
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty('cost');
    expect(h.logger.warnings).toContain(WARNING('BYOK_COST_INCOMPLETE'));
  });
});

describe('cost for Responses and Embeddings', () => {
  it('follows the same rules for responses.send()', async () => {
    const h = harness();
    h.fake
      .answer(
        'responses.send',
        responsesResult({
          usage: responsesUsage({
            isByok: true,
            cost: 0.0005,
            costDetails: { upstreamInferenceCost: 0.01 },
          }),
        }),
      )
      .answer(
        'responses.send',
        responsesResult({
          usage: responsesUsage({ cost: 0.02, costDetails: { serverToolCost: 0.005 } }),
        }),
      );
    await h.openrouter.responses.send({ responsesRequest: {} });
    await h.openrouter.responses.send({ responsesRequest: {} });
    const records = await h.records();
    expect(records[0]?.cost?.total_cost).toBeCloseTo(0.0105, 12);
    expect(records[1]?.cost?.total_cost).toBe(0.02);
  });

  it('follows the same rules for embeddings.generate(), with the lookup supplying the upstream cost', async () => {
    const h = harness();
    h.fake
      .answer(
        'embeddings.generate',
        embeddingsResult({ usage: { promptTokens: 8, cost: 0.000001, isByok: true } }),
      )
      .answer(
        'generations.getGeneration',
        generation({ providerName: 'OpenAI', isByok: true, upstreamInferenceCost: 0.00002 }),
      );
    await h.openrouter.embeddings.generate({ requestBody: {} });
    expect((await h.records())[0]?.cost?.total_cost).toBeCloseTo(0.000021, 12);
  });
});

describe('resolveCost', () => {
  it.each([
    ['not BYOK', 0.5, false, undefined, 0.5, false],
    ['not BYOK with a fee of zero', 0, false, 7, 0, false],
    ['not BYOK, no fee', undefined, false, 7, undefined, false],
    ['BYOK', 0.5, true, 1.5, 2, false],
    ['BYOK without upstream', 0.5, true, undefined, undefined, true],
    ['BYOK without a fee', undefined, true, 1.5, undefined, true],
    ['unknown, with both figures', 0.5, undefined, 1.5, undefined, true],
    ['unknown, with neither', undefined, undefined, undefined, undefined, true],
  ])('%s', (_name, charge, isByok, upstream, total, incomplete) => {
    const result = resolveCost(charge, isByok, upstream);
    expect(result.cost?.total_cost).toBe(total);
    expect(result.incomplete).toBe(incomplete);
    if (total !== undefined) expect(result.cost?.currency).toBe('USD');
  });
});
