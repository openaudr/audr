import type { Client, Logger, SubmitResult } from '@openaudr/audr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Diagnostics, errorKind, formatDiagnostic, formatIssues } from '../src/diagnostics.js';
import { instrumentOpenRouter } from '../src/index.js';
import {
  chatChunks,
  chatResult,
  drain,
  eventStream,
  FakeOpenRouter,
  harness,
  responsesEvents,
} from './helpers.js';

const CHAT = { chatRequest: { model: 'anthropic/claude-sonnet-4.5', messages: [] } };
const PREFIX = '@openaudr/audr-adapter-openrouter';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A `Client` whose `record()` throws `error`. */
function throwingClient(error: unknown): Client {
  return {
    record: () => {
      throw error;
    },
  } as unknown as Client;
}

describe('formatDiagnostic', () => {
  it('writes the code and the present fields in a fixed order', () => {
    expect(
      formatDiagnostic('RECORD_NOT_QUEUED', {
        error: 'TypeError',
        issues: 'pattern@/a',
        reason: 'ended',
        operation: 'chat.send',
        outcome: 'rejected',
      }),
    ).toBe(
      `${PREFIX}: RECORD_NOT_QUEUED (outcome=rejected, operation=chat.send, reason=ended, issues=pattern@/a, error=TypeError)`,
    );
  });

  it('leaves out fields that are absent', () => {
    expect(formatDiagnostic('MODEL_UNREPORTED', { operation: 'embeddings.generate' })).toBe(
      `${PREFIX}: MODEL_UNREPORTED (operation=embeddings.generate)`,
    );
  });
});

describe('errorKind', () => {
  it.each([
    [new TypeError('x'), 'TypeError'],
    [new RangeError('x'), 'RangeError'],
    [new SyntaxError('x'), 'SyntaxError'],
    [new ReferenceError('x'), 'ReferenceError'],
    [new Error('x'), 'Error'],
    [Object.assign(new Error('x'), { name: 'secret prompt text' }), 'Error'],
    ['text', 'string'],
    [7, 'number'],
    [undefined, 'undefined'],
    [{}, 'object'],
  ])('%#', (error, kind) => {
    expect(errorKind(error)).toBe(kind);
  });

  it('is "unknown" for a value that cannot be inspected', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new RangeError('private value');
        },
      },
    );
    expect(errorKind(hostile)).toBe('unknown');
  });
});

describe('formatIssues', () => {
  it('lists code and path for each issue, and nothing else', () => {
    const result = {
      outcome: 'rejected',
      queued: false,
      issues: [
        { code: 'pattern', path: '/resource/provider', message: 'private value', value: 'v' },
        { code: 'required', path: '/usage' },
      ],
    } as unknown as SubmitResult;
    expect(formatIssues(result)).toBe('pattern@/resource/provider,required@/usage');
  });

  it('is undefined without issues', () => {
    expect(formatIssues({ outcome: 'queued', queued: true, issues: [] } as never)).toBeUndefined();
  });
});

describe('Diagnostics', () => {
  it('routes warnings and errors to the matching logger method', () => {
    const logger = { warn: vi.fn(), error: vi.fn() } satisfies Logger;
    const diagnostics = new Diagnostics(logger);
    diagnostics.warn('USAGE_UNREPORTED', { operation: 'chat.send' });
    diagnostics.error('HOOK_FAILED', { operation: 'chat.send', error: 'Error' });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      `${PREFIX}: USAGE_UNREPORTED (operation=chat.send)`,
    );
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      `${PREFIX}: HOOK_FAILED (operation=chat.send, error=Error)`,
    );
  });

  it('swallows a logger that throws', () => {
    const diagnostics = new Diagnostics({
      warn() {
        throw new Error('logger down');
      },
      error() {
        throw new Error('logger down');
      },
    });
    expect(() => {
      diagnostics.warn('USAGE_UNREPORTED', { operation: 'chat.send' });
      diagnostics.error('HOOK_FAILED', { operation: 'chat.send' });
    }).not.toThrow();
  });
});

describe('by default', () => {
  it('logs nothing anywhere', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeOpenRouter();
    const facade = instrumentOpenRouter(fake, { client: throwingClient(new Error('x')) });
    fake.answer('chat.send', chatResult());
    await facade.chat.send(CHAT);
    fake.answer('chat.send', chatResult());
    await facade.chat.send(CHAT);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('a metering step that fails', () => {
  it('never changes the native result, and is logged by category only', async () => {
    const h = harness({ client: throwingClient(new TypeError('private prompt text')) });
    const native = chatResult();
    h.fake.answer('chat.send', native);
    expect(await h.openrouter.chat.send(CHAT as never)).toBe(native);
    expect(h.logger.errors).toEqual([
      `${PREFIX}: HOOK_FAILED (operation=chat.send, error=TypeError)`,
    ]);
    expect(h.logger.lines.join('\n')).not.toContain('private');
  });

  it.each([
    ['a thrown string', 'private text', 'string'],
    [
      'an error with a rewritten name',
      Object.assign(new Error('x'), { name: 'private text' }),
      'Error',
    ],
    ['an object', { message: 'private text' }, 'object'],
  ])('is categorised without its value for %s', async (_name, thrown, kind) => {
    const h = harness({ client: throwingClient(thrown) });
    h.fake.answer('chat.send', chatResult());
    await h.openrouter.chat.send(CHAT);
    expect(h.logger.errors).toEqual([
      `${PREFIX}: HOOK_FAILED (operation=chat.send, error=${kind})`,
    ]);
  });

  it('is survived when mapResource throws, with no record', async () => {
    const h = harness({
      mapResource: () => {
        throw new RangeError('private value');
      },
    });
    const native = chatResult();
    h.fake.answer('chat.send', native);
    expect(await h.openrouter.chat.send(CHAT as never)).toBe(native);
    expect(await h.records()).toEqual([]);
    expect(h.logger.errors).toEqual([
      `${PREFIX}: HOOK_FAILED (operation=chat.send, error=RangeError)`,
    ]);
  });

  it('is survived when the logger throws too', async () => {
    const h = harness({
      client: throwingClient(new Error('x')),
      logger: {
        warn() {
          throw new Error('logger down');
        },
        error() {
          throw new Error('logger down');
        },
      },
    });
    const native = chatResult();
    h.fake.answer('chat.send', native);
    expect(await h.openrouter.chat.send(CHAT as never)).toBe(native);
  });

  it('is survived by a stream: every frame arrives and the failure is logged once', async () => {
    const h = harness({ client: throwingClient(new Error('x')) });
    const chunks = chatChunks();
    h.fake.answer('chat.send', eventStream(chunks));
    const stream = await h.openrouter.chat.send(CHAT);
    expect(await drain(stream as AsyncIterable<unknown>)).toEqual(chunks);
    expect(h.logger.errors).toEqual([`${PREFIX}: HOOK_FAILED (operation=chat.send, error=Error)`]);
  });

  it('is survived by a Responses stream', async () => {
    const h = harness({ client: throwingClient(new Error('x')) });
    const events = responsesEvents();
    h.fake.answer('responses.send', eventStream(events));
    const stream = await h.openrouter.responses.send({ responsesRequest: {} });
    expect(await drain(stream as AsyncIterable<unknown>)).toEqual(events);
    expect(h.logger.errors).toEqual([
      `${PREFIX}: HOOK_FAILED (operation=responses.send, error=Error)`,
    ]);
  });
});

describe('a record the client does not queue', () => {
  it('is reported with the outcome and the issue paths, never the values', async () => {
    const h = harness({
      mapResource: () => ({ provider: 'Not A Slug', name: 'private-model-name' }),
    });
    h.fake.answer('chat.send', chatResult());
    await h.openrouter.chat.send(CHAT);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toHaveLength(1);
    expect(h.logger.warnings[0]).toMatch(
      new RegExp(
        `^${PREFIX}: RECORD_NOT_QUEUED \\(outcome=\\w+, operation=chat\\.send, issues=[\\w-]+@/resource/provider\\)$`,
      ),
    );
    expect(h.logger.lines.join('\n')).not.toContain('Not A Slug');
    expect(h.logger.lines.join('\n')).not.toContain('private-model-name');
  });
});

describe('results the adapter cannot meter', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'raw body'],
    ['a number', 42],
    ['an object without usage', { id: 'gen-aaaaaaaa', model: 'm' }],
  ])('chat.send() returning %s is passed through, with one warning', async (_name, native) => {
    const h = harness();
    h.fake.answer('chat.send', native);
    expect(await h.openrouter.chat.send(CHAT as never)).toBe(native);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([`${PREFIX}: USAGE_UNREPORTED (operation=chat.send)`]);
  });

  it('skips a result with no model, and says so', async () => {
    const h = harness();
    h.fake.answer('chat.send', chatResult({ model: undefined }));
    await h.openrouter.chat.send(CHAT);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([`${PREFIX}: MODEL_UNREPORTED (operation=chat.send)`]);
  });

  it('records a result with no model once mapResource names it', async () => {
    const h = harness({ mapResource: () => ({ provider: 'anthropic', name: 'claude-sonnet' }) });
    h.fake.answer('chat.send', chatResult({ model: undefined }));
    await h.openrouter.chat.send(CHAT);
    const [record] = await h.records();
    expect(record?.resource).toMatchObject({ provider: 'anthropic', name: 'claude-sonnet' });
    expect(h.logger.lines).toEqual([]);
  });
});
