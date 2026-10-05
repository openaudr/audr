import { describe, expect, it } from 'vitest';

import {
  chatObservation,
  declaredKinds,
  embeddingsObservation,
  fitsRunId,
  isRecord,
  isTerminalType,
  needsLookup,
  type Observation,
  OPENROUTER_PROVIDER,
  providerSlug,
  readFacts,
  readRouter,
  RESPONSE_FAILED_CODE,
  RESPONSE_INCOMPLETE_CODE,
  responsesObservation,
  servedProvider,
  statusErrorCode,
  terminalErrorCode,
} from '../src/mapping.js';
import {
  chatResult,
  chatUsage,
  embeddingsResult,
  responsesResult,
  responsesUsage,
  routerMetadata,
} from './helpers.js';

const NONE = new Set<never>();

const observed = (overrides: Partial<Observation> = {}): Observation => ({
  id: 'gen-aaaaaaaa',
  model: 'm',
  provider: 'Anthropic',
  isByok: false,
  charge: 1,
  upstream: undefined,
  usage: { requests: 1 },
  modality: 'text',
  errorCode: undefined,
  ...overrides,
});

describe('isRecord', () => {
  it.each([
    [{}, true],
    [[], true],
    [null, false],
    [undefined, false],
    ['text', false],
    [1, false],
  ])('%j', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('declaredKinds', () => {
  it('keeps the kinds AUDR names, in no particular order, and drops the rest', () => {
    expect([...declaredKinds(['audio', 'video', 'text', 'file', 'image'])].sort()).toEqual([
      'audio',
      'image',
      'text',
    ]);
  });

  it.each([undefined, null, 'text', 7, {}])('is empty for %j', (value) => {
    expect(declaredKinds(value).size).toBe(0);
  });
});

describe('error codes', () => {
  it.each([
    ['response.completed', undefined],
    ['response.failed', RESPONSE_FAILED_CODE],
    ['response.incomplete', RESPONSE_INCOMPLETE_CODE],
  ] as const)('a %s event', (type, code) => {
    expect(terminalErrorCode(type)).toBe(code);
    expect(isTerminalType(type)).toBe(true);
  });

  it.each([
    ['failed', RESPONSE_FAILED_CODE],
    ['incomplete', RESPONSE_INCOMPLETE_CODE],
    ['completed', undefined],
    ['cancelled', undefined],
    ['in_progress', undefined],
    [undefined, undefined],
  ])('a result with status %s', (status, code) => {
    expect(statusErrorCode(status)).toBe(code);
  });

  it.each(['response.created', 'response.output_text.delta', 'error', undefined, 1])(
    '%j is not a terminal event',
    (type) => {
      expect(isTerminalType(type)).toBe(false);
    },
  );
});

describe('fitsRunId', () => {
  it.each([
    [7, false],
    [8, true],
    [64, true],
    [65, false],
  ])('%d characters: %s', (length, fits) => {
    expect(fitsRunId('a'.repeat(length))).toBe(fits);
  });
});

describe('providerSlug', () => {
  it.each([
    ['Amazon Bedrock', 'amazon-bedrock'],
    ['Google Vertex', 'google-vertex'],
    ['OpenAI', 'openai'],
    ['Together', 'together'],
    ['  AI21  Labs! ', 'ai21-labs'],
    ['a/b_c.d', 'a-b-c-d'],
    ['', undefined],
    ['日本語', undefined],
    ['---', undefined],
  ])('%j', (name, slug) => {
    expect(providerSlug(name)).toBe(slug);
  });
});

describe('needsLookup', () => {
  it.each([
    ['everything is known', observed(), false],
    ['the vendor is missing', observed({ provider: undefined }), true],
    ['the BYOK status is missing', observed({ isByok: undefined }), true],
    ['a BYOK call lacks its upstream cost', observed({ isByok: true, upstream: undefined }), true],
    ['a BYOK call has its upstream cost', observed({ isByok: true, upstream: 2 }), false],
    ['a BYOK call has no fee to add to', observed({ isByok: true, charge: undefined }), false],
    ['a call that is not BYOK lacks an upstream cost', observed({ upstream: undefined }), false],
  ])('when %s: %s', (_name, observation, expected) => {
    expect(needsLookup(observation)).toBe(expected);
  });
});

describe('servedProvider', () => {
  const facts = (overrides = {}) => ({
    providerName: 'Google Vertex',
    cacheHit: false,
    isByok: undefined,
    upstream: undefined,
    ...overrides,
  });

  it('prefers router metadata to the lookup', () => {
    expect(servedProvider(observed(), facts())).toBe('Anthropic');
  });

  it('falls back to the lookup', () => {
    expect(servedProvider(observed({ provider: undefined }), facts())).toBe('Google Vertex');
  });

  it('is undefined when neither names a vendor', () => {
    expect(servedProvider(observed({ provider: undefined }), undefined)).toBeUndefined();
    expect(
      servedProvider(observed({ provider: undefined }), facts({ providerName: undefined })),
    ).toBeUndefined();
  });

  it('is openrouter for a replay, whatever else names', () => {
    expect(servedProvider(observed(), facts({ cacheHit: true }))).toBe(OPENROUTER_PROVIDER);
  });
});

describe('readRouter', () => {
  it('picks the selected endpoint among the available ones', () => {
    expect(readRouter(routerMetadata('Anthropic'))).toEqual({
      provider: 'Anthropic',
      isByok: false,
    });
  });

  it.each([undefined, null, 'text', 3])('is undefined for %j', (value) => {
    expect(readRouter(value)).toBeUndefined();
  });
});

describe('readFacts', () => {
  it('reads absent data as nothing known', () => {
    expect(readFacts(undefined)).toEqual({
      providerName: undefined,
      cacheHit: false,
      isByok: undefined,
      upstream: undefined,
    });
  });
});

describe('observations', () => {
  it('chat: no usage object, no observation', () => {
    expect(chatObservation(chatResult({ usage: undefined }), NONE)).toBeUndefined();
    expect(chatObservation(chatResult({ usage: null }), NONE)).toBeUndefined();
    expect(chatObservation('text', NONE)).toBeUndefined();
    expect(chatObservation(undefined, NONE)).toBeUndefined();
  });

  it('chat: a null completion_tokens_details is read as absent', () => {
    const result = chatObservation(
      chatResult({ usage: chatUsage({ completionTokensDetails: null }) }),
      NONE,
    );
    expect(result?.usage.output_tokens).toBe(300);
    expect(result?.usage.reasoning_tokens).toBeUndefined();
  });

  it('chat: the fallback router stands in when the chunk has none', () => {
    const result = chatObservation(chatResult({ openrouterMetadata: undefined }), NONE, {
      provider: 'Fallback',
      isByok: true,
    });
    expect(result?.provider).toBe('Fallback');
    const own = chatObservation(chatResult(), NONE, { provider: 'Fallback', isByok: true });
    expect(own?.provider).toBe('Amazon Bedrock');
  });

  it('chat: reads the usage flag before the metadata flag', () => {
    const result = chatObservation(
      chatResult({
        usage: chatUsage({ isByok: undefined }),
        openrouterMetadata: routerMetadata('Anthropic', { isByok: true }),
      }),
      NONE,
    );
    expect(result?.isByok).toBe(true);
  });

  it('responses: carries the error code it is given', () => {
    expect(responsesObservation(responsesResult(), NONE, RESPONSE_FAILED_CODE)?.errorCode).toBe(
      RESPONSE_FAILED_CODE,
    );
    expect(responsesObservation(responsesResult(), NONE, undefined)?.errorCode).toBeUndefined();
  });

  it('responses: no usage, no observation', () => {
    expect(responsesObservation(responsesResult({ usage: null }), NONE, undefined)).toBeUndefined();
    expect(responsesObservation(null, NONE, undefined)).toBeUndefined();
  });

  it('responses: modality comes from the declared kinds alone', () => {
    const result = responsesObservation(
      responsesResult({ usage: responsesUsage() }),
      new Set(['text', 'image'] as const),
      undefined,
    );
    expect(result?.modality).toBe('multimodal');
  });

  it('embeddings: no router metadata, so the vendor is never known from the result', () => {
    expect(embeddingsObservation(embeddingsResult())?.provider).toBeUndefined();
    expect(embeddingsObservation(embeddingsResult({ usage: undefined }))).toBeUndefined();
  });
});
