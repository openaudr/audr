import { describe, expect, it } from 'vitest';

import { errorKind, formatDiagnostic } from '../src/diagnostics.js';
import {
  chatModality,
  chatObservation,
  embeddingsObservation,
  fitsRunId,
  providerFor,
  responsesObservation,
} from '../src/mapping.js';

describe('token arithmetic', () => {
  it('makes chat input exclusive of cache reads and output of reasoning', () => {
    expect(
      chatObservation({
        id: 'chatcmpl-1',
        model: 'gpt-5.4',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 60 },
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      }),
    ).toEqual({
      id: 'chatcmpl-1',
      model: 'gpt-5.4',
      usage: {
        input_tokens: 40,
        output_tokens: 30,
        cache_read_tokens: 60,
        reasoning_tokens: 20,
        requests: 1,
      },
      errorCode: undefined,
    });
  });

  it('makes responses input exclusive of cache reads and output of reasoning', () => {
    expect(
      responsesObservation(
        {
          id: 'resp_1',
          model: 'gpt-5.4',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 60 },
            output_tokens_details: { reasoning_tokens: 20 },
          },
        },
        'OPENAI_RESPONSE_FAILED',
      ),
    ).toEqual({
      id: 'resp_1',
      model: 'gpt-5.4',
      usage: {
        input_tokens: 40,
        output_tokens: 30,
        cache_read_tokens: 60,
        reasoning_tokens: 20,
        requests: 1,
      },
      errorCode: 'OPENAI_RESPONSE_FAILED',
    });
  });

  it('never goes below zero', () => {
    expect(
      chatObservation({
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 9 },
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      }).usage,
    ).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it('treats an absent or null counter as unreported', () => {
    expect(chatObservation({ usage: { prompt_tokens: 41, completion_tokens: 7 } }).usage).toEqual({
      input_tokens: 41,
      output_tokens: 7,
      requests: 1,
    });
    expect(chatObservation({ usage: null }).usage).toEqual({ requests: 1 });
    expect(chatObservation(null).usage).toEqual({ requests: 1 });
    expect(responsesObservation({ usage: { input_tokens: null } }, undefined).usage).toEqual({
      requests: 1,
    });
  });

  it('reads embedding input from prompt_tokens and never an id', () => {
    expect(embeddingsObservation({ model: 'e', usage: { prompt_tokens: 3 } })).toEqual({
      id: undefined,
      model: 'e',
      usage: { input_tokens: 3, requests: 1 },
      errorCode: undefined,
    });
    expect(embeddingsObservation('not an object').usage).toEqual({ requests: 1 });
  });
});

describe('provider from baseURL', () => {
  it('knows the hosts it lists, by name or subdomain', () => {
    expect(providerFor('https://api.openai.com/v1')).toEqual({ provider: 'openai' });
    expect(providerFor('https://eu.api.openai.com/v1')).toEqual({ provider: 'openai' });
    expect(providerFor('https://r.openai.azure.com/openai/v1')).toEqual({
      provider: 'azure-openai',
    });
    expect(providerFor('https://r.cognitiveservices.azure.com/openai/v1')).toEqual({
      provider: 'azure-openai',
    });
  });

  it('treats a loopback host as self-hosted ollama', () => {
    expect(providerFor('http://localhost:11434/v1')).toEqual({
      provider: 'ollama',
      deployment: 'self-hosted',
    });
    expect(providerFor('http://[::1]:11434/v1')).toEqual({
      provider: 'ollama',
      deployment: 'self-hosted',
    });
  });

  it('resolves nothing for an unknown, lookalike, absent or malformed URL', () => {
    expect(providerFor('https://llm.example.internal/v1')).toBeUndefined();
    expect(providerFor('https://api.openai.com.example.net/v1')).toBeUndefined();
    expect(providerFor('https://notapi.openai.com/v1')).toBeUndefined();
    expect(providerFor(undefined)).toBeUndefined();
    expect(providerFor('not a url')).toBeUndefined();
  });
});

describe('chat modality', () => {
  it('follows the declared modalities, defaulting to text', () => {
    expect(chatModality({ modalities: ['audio'] })).toBe('audio');
    expect(chatModality({ modalities: ['text', 'audio'] })).toBe('multimodal');
    expect(chatModality({ modalities: ['text'] })).toBe('text');
    expect(chatModality({ modalities: null })).toBe('text');
    expect(chatModality({})).toBe('text');
    expect(chatModality(undefined)).toBe('text');
  });

  it('defaults to text when the request cannot be read', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new RangeError('private value');
        },
      },
    );
    expect(chatModality(hostile)).toBe('text');
  });
});

describe('run identifiers', () => {
  it('accepts a response id of 8 to 64 characters as a run id', () => {
    expect(fitsRunId('12345678')).toBe(true);
    expect(fitsRunId('x'.repeat(64))).toBe(true);
    expect(fitsRunId('1234567')).toBe(false);
    expect(fitsRunId('x'.repeat(65))).toBe(false);
  });
});

describe('diagnostics', () => {
  it('prints the fields in a fixed order', () => {
    expect(
      formatDiagnostic('RECORD_NOT_QUEUED', {
        issues: 'INVALID_TYPE@/run/run_id',
        operation: 'responses.create',
        outcome: 'rejected_invalid',
      }),
    ).toBe(
      '@openaudr/audr-adapter-openai: RECORD_NOT_QUEUED (outcome=rejected_invalid, operation=responses.create, issues=INVALID_TYPE@/run/run_id)',
    );
  });

  it('classifies errors by built-in type, never by their own name', () => {
    const renamed = new TypeError('private value');
    renamed.name = 'private value';
    expect(errorKind(renamed)).toBe('TypeError');
    expect(errorKind(new SyntaxError('x'))).toBe('SyntaxError');
    expect(errorKind(new (class Custom extends Error {})('x'))).toBe('Error');
    expect(errorKind('x')).toBe('string');
  });

  it('cannot throw while classifying a hostile error', () => {
    const error = new Proxy(new Error('private value'), {
      getPrototypeOf(): never {
        throw new RangeError('private value');
      },
    });
    expect(errorKind(error)).toBe('unknown');
  });
});
