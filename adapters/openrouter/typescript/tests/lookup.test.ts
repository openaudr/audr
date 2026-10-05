import { afterEach, describe, expect, it, vi } from 'vitest';

import { GenerationLookup, isGenerationId, type LookupOptions } from '../src/lookup.js';
import { chatResult, generation, harness, responsesResult } from './helpers.js';

interface Attempt {
  readonly request: unknown;
  readonly options: unknown;
  readonly at: number;
}

/** A client whose `getGeneration` answers from `script`, repeating its last step. */
function scripted(script: readonly (() => unknown)[]) {
  const attempts: Attempt[] = [];
  const client = {
    generations: {
      getGeneration(request: unknown, options?: unknown): Promise<unknown> {
        attempts.push({ request, options, at: performance.now() });
        const step = script[Math.min(attempts.length, script.length) - 1];
        return new Promise((resolve) => {
          resolve(step?.());
        });
      },
    },
  };
  return { client: client as never, attempts };
}

const reply = (): unknown =>
  generation({ providerName: 'Anthropic', isByok: true, upstreamInferenceCost: 2 });

const failing =
  (error: unknown): (() => never) =>
  () => {
    throw error;
  };

const status = (statusCode: number, name = 'OpenRouterError'): Error =>
  Object.assign(new Error('failure'), { statusCode, name });

const FAST: LookupOptions = { maxWaitMs: 200, initialDelayMs: 1, maxDelayMs: 2 };

afterEach(() => {
  vi.useRealTimers();
});

describe('a successful lookup', () => {
  it('asks for the generation id with a deadline and no SDK retries, and reads the four facts', async () => {
    const { client, attempts } = scripted([reply]);
    const outcome = await new GenerationLookup(client, FAST).find('gen-1');
    expect(outcome).toEqual({
      ok: true,
      facts: { providerName: 'Anthropic', cacheHit: false, isByok: true, upstream: 2 },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.request).toStrictEqual({ id: 'gen-1' });
    const options = attempts[0]?.options as { signal: AbortSignal; retries: unknown };
    expect(Object.keys(options).sort()).toEqual(['retries', 'signal']);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
    expect(options.retries).toEqual({ strategy: 'none' });
  });

  it('treats a response without data as no facts', async () => {
    const { client } = scripted([() => ({})]);
    expect(await new GenerationLookup(client, FAST).find('gen-1')).toEqual({
      ok: true,
      facts: { providerName: undefined, cacheHit: false, isByok: undefined, upstream: undefined },
    });
  });

  it('reads a response-cache replay from responseCacheSourceId', async () => {
    const { client } = scripted([() => generation({ responseCacheSourceId: 'gen-source' })]);
    const outcome = await new GenerationLookup(client, FAST).find('gen-1');
    expect(outcome.ok && outcome.facts.cacheHit).toBe(true);
    const empty = scripted([() => generation({ responseCacheSourceId: '' })]);
    const none = await new GenerationLookup(empty.client, FAST).find('gen-1');
    expect(none.ok && none.facts.cacheHit).toBe(false);
  });
});

describe('a failed lookup is retried when waiting can help', () => {
  it.each([
    ['404, statistics not there yet', status(404)],
    ['408', status(408)],
    ['429', status(429)],
    ['500', status(500)],
    ['502', status(502)],
    ['503', status(503)],
    ['529', status(529)],
    ['a network failure', new TypeError('fetch failed')],
    ['a connection error', Object.assign(new Error('x'), { name: 'ConnectionError' })],
    ['a request timeout', Object.assign(new Error('x'), { name: 'RequestTimeoutError' })],
    ['a value that is not an error', 'oops'],
  ])('%s', async (_name, error) => {
    const { client, attempts } = scripted([failing(error), failing(error), reply]);
    const outcome = await new GenerationLookup(client, FAST).find('gen-1');
    expect(outcome.ok).toBe(true);
    expect(attempts).toHaveLength(3);
  });
});

describe('a failed lookup stops at once when waiting cannot help', () => {
  it.each([
    ['400', status(400)],
    ['401, authentication', status(401)],
    ['402, payment', status(402)],
    ['403', status(403)],
    ['422', status(422)],
    ['a response the SDK could not validate', status(200, 'ResponseValidationError')],
    ['an invalid request', Object.assign(new Error('x'), { name: 'InvalidRequestError' })],
    ['a validation failure', Object.assign(new Error('x'), { name: 'SDKValidationError' })],
  ])('%s', async (_name, error) => {
    const { client, attempts } = scripted([failing(error), reply]);
    expect(await new GenerationLookup(client, FAST).find('gen-1')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(attempts).toHaveLength(1);
  });

  it('when the error cannot even be inspected', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new RangeError('private value');
        },
      },
    );
    const { client, attempts } = scripted([failing(hostile), reply]);
    expect(await new GenerationLookup(client, FAST).find('gen-1')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(attempts).toHaveLength(1);
  });
});

describe('a client without getGeneration', () => {
  it.each([
    ['no generations resource', {}],
    ['a generations resource without getGeneration', { generations: {} }],
  ])('rejects at once for %s instead of waiting out the budget', async (_name, client) => {
    const started = performance.now();
    await expect(
      new GenerationLookup(client as never, { maxWaitMs: 5_000 }).find('gen-1'),
    ).rejects.toThrow(TypeError);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('the retry budget', () => {
  it('gives up with "exhausted" once the total time is spent', async () => {
    const { client, attempts } = scripted([failing(status(404))]);
    const started = performance.now();
    const outcome = await new GenerationLookup(client, {
      maxWaitMs: 60,
      initialDelayMs: 5,
      maxDelayMs: 10,
    }).find('gen-1');
    expect(outcome).toEqual({ ok: false, reason: 'exhausted' });
    expect(attempts.length).toBeGreaterThan(2);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('abandons an attempt that outlives the budget', async () => {
    const client = {
      generations: {
        getGeneration: (_request: unknown, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      },
    };
    const started = performance.now();
    const outcome = await new GenerationLookup(client, {
      maxWaitMs: 40,
      initialDelayMs: 5,
    }).find('gen-1');
    expect(outcome).toEqual({ ok: false, reason: 'exhausted' });
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('is disabled by a budget of zero, and then makes no request', async () => {
    const { client, attempts } = scripted([reply]);
    expect(await new GenerationLookup(client, { maxWaitMs: 0 }).find('gen-1')).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(attempts).toHaveLength(0);
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['infinite', Number.POSITIVE_INFINITY],
    ['not a number', '10' as unknown as number],
  ])('falls back to the defaults for a %s setting', async (_name, value) => {
    const { client, attempts } = scripted([reply]);
    const outcome = await new GenerationLookup(client, {
      maxWaitMs: value,
      initialDelayMs: value,
      maxDelayMs: value,
    }).find('gen-1');
    expect(outcome.ok).toBe(true);
    expect(attempts).toHaveLength(1);
  });

  it('waits 250 ms, doubling to a 1000 ms cap, by default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const { client, attempts } = scripted([failing(status(404))]);
    const lookup = new GenerationLookup(client, undefined).find('gen-1');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await lookup).toEqual({ ok: false, reason: 'exhausted' });
    const times = attempts.map((attempt) => attempt.at - (attempts[0]?.at ?? 0));
    expect(times).toEqual([0, 250, 750, 1750, 2750, 3750, 4750]);
  });

  it('does not wait for a retry that would start after the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const { client, attempts } = scripted([failing(status(404))]);
    const lookup = new GenerationLookup(client, {
      maxWaitMs: 1000,
      initialDelayMs: 400,
      maxDelayMs: 400,
    }).find('gen-1');
    await vi.advanceTimersByTimeAsync(800);
    expect(await lookup).toEqual({ ok: false, reason: 'exhausted' });
    // The third wait would end at 1200 ms, past the 1000 ms budget, so it is skipped.
    const times = attempts.map((attempt) => attempt.at - (attempts[0]?.at ?? 0));
    expect(times).toEqual([0, 400, 800]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('isGenerationId', () => {
  it.each([
    ['gen-1759680000-AbCdEfGhIjKl', true],
    ['gen-abc123', true],
    [`gen-${'a'.repeat(124)}`, true],
    [`gen-${'a'.repeat(125)}`, false],
    ['gen-', false],
    ['resp_abc123', false],
    ['chatcmpl-791bcf62', false],
    ['gen_abc123', false],
    ['gen-abc 123', false],
    ['gen-abc/../x', false],
    ['', false],
  ])('%j: %s', (id, expected) => {
    expect(isGenerationId(id)).toBe(expected);
  });
});

describe('a lookup through the facade', () => {
  const REQUEST = { chatRequest: { model: 'm', messages: [] } };
  const BARE = chatResult({ openrouterMetadata: undefined });

  it('retries a generation that is not there yet and then records', async () => {
    const h = harness();
    h.fake
      .answer('chat.send', BARE)
      .fail('generations.getGeneration', status(404))
      .fail('generations.getGeneration', status(404))
      .answer('generations.getGeneration', generation({ providerName: 'Anthropic' }));
    await h.openrouter.chat.send(REQUEST);
    expect(h.fake.lookups).toHaveLength(3);
    expect((await h.records())[0]?.resource.provider).toBe('anthropic');
    expect(h.logger.lines).toEqual([]);
  });

  it.each(['resp_abc123', 'chatcmpl-791bcf62', 'gen-abc/../x'])(
    'does not look up the id %j, which is not a generation id',
    async (id) => {
      const h = harness();
      h.fake.answer('chat.send', chatResult({ id, openrouterMetadata: undefined }));
      await h.openrouter.chat.send(REQUEST);
      expect(h.fake.lookups).toHaveLength(0);
      expect((await h.records()).map((r) => r.resource.provider)).toEqual(['openrouter']);
      expect(h.logger.warnings).toEqual([
        '@openaudr/audr-adapter-openrouter: LOOKUP_FAILED (operation=chat.send, reason=no_id)',
        '@openaudr/audr-adapter-openrouter: PROVIDER_UNRESOLVED (operation=chat.send)',
      ]);
    },
  );

  it('records such a call once mapResource names the vendor', async () => {
    const h = harness({ mapResource: () => ({ provider: 'anthropic', name: 'claude' }) });
    h.fake.answer(
      'responses.send',
      responsesResult({ id: 'resp_abc123', openrouterMetadata: undefined }),
    );
    await h.openrouter.responses.send({ responsesRequest: {} });
    const [record] = await h.records();
    expect(record?.resource.provider).toBe('anthropic');
    expect(record?.run.run_id).toBe('resp_abc123');
    expect(h.fake.lookups).toHaveLength(0);
  });

  it('gives up after the budget, records openrouter, and still returns the native result', async () => {
    const h = harness({ lookup: { maxWaitMs: 40, initialDelayMs: 2, maxDelayMs: 5 } });
    h.fake.answer('chat.send', BARE);
    for (let n = 0; n < 50; n += 1) h.fake.fail('generations.getGeneration', status(404));
    await expect(h.openrouter.chat.send(REQUEST as never)).resolves.toBe(BARE);
    expect((await h.records()).map((r) => r.resource.provider)).toEqual(['openrouter']);
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-openrouter: LOOKUP_FAILED (operation=chat.send, reason=exhausted)',
      '@openaudr/audr-adapter-openrouter: PROVIDER_UNRESOLVED (operation=chat.send)',
    ]);
  });

  it('logs HOOK_FAILED at once, and still returns the native result, without getGeneration', async () => {
    const h = harness({ lookup: { maxWaitMs: 5_000 } });
    Object.assign(h.fake, { generations: {} });
    h.fake.answer('chat.send', BARE);
    const started = performance.now();
    await expect(h.openrouter.chat.send(REQUEST as never)).resolves.toBe(BARE);
    expect(performance.now() - started).toBeLessThan(250);
    expect(await h.records()).toEqual([]);
    expect(h.logger.errors).toEqual([
      '@openaudr/audr-adapter-openrouter: HOOK_FAILED (operation=chat.send, error=TypeError)',
    ]);
  });
});
