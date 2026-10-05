import { describe, expect, it } from 'vitest';

import { RESPONSE_FAILED_CODE, RESPONSE_INCOMPLETE_CODE, withAudr } from '../src/index.js';
import {
  chatChunks,
  chatResult,
  drain,
  eventStream,
  generation,
  GENERATION_ID,
  harness,
  LLM,
  recordingClient,
  responsesEvents,
  responsesResult,
  responsesUsage,
  routerMetadata,
  sleep,
} from './helpers.js';

const CHAT = { chatRequest: { model: 'anthropic/claude-sonnet-4.5', messages: [], stream: true } };
const RESPONSES = { responsesRequest: { model: 'anthropic/claude-sonnet-4.5', stream: true } };

const incomplete = (operation: string, reason: string): string =>
  `@openaudr/audr-adapter-openrouter: STREAM_INCOMPLETE (operation=${operation}, reason=${reason})`;

async function chatStream(
  frames: readonly unknown[],
  options: Parameters<typeof harness>[0] = {},
  streamOptions: { failAfter?: number } = {},
) {
  const h = harness(options);
  h.fake.answer('chat.send', eventStream(frames, streamOptions));
  const stream = (await h.openrouter.chat.send(CHAT)) as AsyncIterable<unknown> & {
    cancel(): Promise<void>;
  };
  return { h, stream };
}

async function responsesStream(
  frames: readonly unknown[],
  options: Parameters<typeof harness>[0] = {},
) {
  const h = harness(options);
  h.fake.answer('responses.send', eventStream(frames));
  const stream = (await h.openrouter.responses.send(RESPONSES)) as AsyncIterable<unknown>;
  return { h, stream };
}

/** Reads `count` frames and then stops, as a `break` out of `for await` does. */
async function breakAfter(stream: AsyncIterable<unknown>, count: number): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  for (let seen = 0; seen < count; seen += 1) await iterator.next();
  await iterator.return?.();
}

describe('chat.send() with a stream', () => {
  it('yields every chunk unchanged and records once, from the chunk that carries usage', async () => {
    const chunks = chatChunks();
    const { h, stream } = await chatStream(chunks);
    const frames = await drain(stream);
    expect(frames).toHaveLength(chunks.length);
    frames.forEach((frame, index) => {
      expect(frame).toBe(chunks[index]);
    });
    const records = await h.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      resource: { provider: 'amazon-bedrock', operation: 'generation', modality: 'text' },
      usage: { llm: LLM },
      cost: { total_cost: 0.0123, currency: 'USD' },
      run: { run_id: GENERATION_ID, span_id: `chat:${GENERATION_ID}`, run_type: 'single_call' },
    });
    expect(h.fake.lookups).toHaveLength(0);
    expect(h.logger.lines).toEqual([]);
  });

  it('returns a stream that is still the native one in type and members', async () => {
    const { stream } = await chatStream(chatChunks());
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(typeof stream.cancel).toBe('function');
    await stream.cancel();
  });

  it('submits the record before the caller sees the chunk that completes the stream', async () => {
    const sink = recordingClient();
    const { stream } = await chatStream(chatChunks(), { client: sink });
    const submittedAt: number[] = [];
    const iterator = stream[Symbol.asyncIterator]();
    while (!(await iterator.next()).done) submittedAt.push(sink.submitted.length);
    expect(submittedAt).toEqual([0, 0, 1]);
  });

  it('takes the vendor from metadata on an earlier chunk when the usage chunk has none', async () => {
    const chunks = chatChunks(chatResult({ openrouterMetadata: undefined }));
    chunks[0] = { ...(chunks[0] as object), openrouterMetadata: routerMetadata('Google Vertex') };
    const { h, stream } = await chatStream(chunks);
    await drain(stream);
    expect((await h.records())[0]?.resource.provider).toBe('google-vertex');
    expect(h.fake.lookups).toHaveLength(0);
  });

  it('prefers metadata on the usage chunk to metadata on an earlier chunk', async () => {
    const chunks = chatChunks();
    chunks[0] = { ...(chunks[0] as object), openrouterMetadata: routerMetadata('Google Vertex') };
    const { h, stream } = await chatStream(chunks);
    await drain(stream);
    expect((await h.records())[0]?.resource.provider).toBe('amazon-bedrock');
  });

  it('holds back only the terminal chunk while the lookup runs', async () => {
    const chunks = chatChunks(chatResult({ openrouterMetadata: undefined }));
    const h = harness({ lookup: { maxWaitMs: 1000 } });
    const release = h.fake.hold('generations.getGeneration');
    h.fake.answer('chat.send', eventStream(chunks));
    const stream = (await h.openrouter.chat.send(CHAT)) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toBe(chunks[0]);
    expect((await iterator.next()).value).toBe(chunks[1]);
    let delivered = false;
    const terminal = iterator.next().then((step) => {
      delivered = true;
      return step;
    });
    await sleep(30);
    expect(h.fake.lookups).toHaveLength(1);
    expect(delivered).toBe(false);

    release(generation({ providerName: 'Anthropic' }));
    expect((await terminal).value).toBe(chunks[2]);
    expect((await h.records())[0]?.resource.provider).toBe('anthropic');
    await iterator.return?.();
    expect(h.logger.lines).toEqual([]);
  });

  it('records once and stays quiet when chunks follow the usage chunk', async () => {
    const chunks = [...chatChunks(), { object: 'chat.completion.chunk', choices: [] }];
    const { h, stream } = await chatStream(chunks);
    expect(await drain(stream)).toHaveLength(4);
    expect(await h.records()).toHaveLength(1);
    expect(h.logger.lines).toEqual([]);
  });

  it('passes frames that are not objects through untouched', async () => {
    const chunks: unknown[] = ['[DONE]', null, 7, ...chatChunks()];
    const { h, stream } = await chatStream(chunks);
    const frames = await drain(stream);
    expect(frames.slice(0, 3)).toEqual(['[DONE]', null, 7]);
    expect(await h.records()).toHaveLength(1);
    expect(h.logger.lines).toEqual([]);
  });

  it('reads a plain async iterable that has no cancel()', async () => {
    const h = harness();
    const chunks = chatChunks();
    h.fake.answer(
      'chat.send',
      (async function* () {
        await Promise.resolve();
        yield* chunks;
      })(),
    );
    const stream = (await h.openrouter.chat.send(CHAT)) as AsyncIterable<unknown>;
    expect(await drain(stream)).toHaveLength(3);
    expect(await h.records()).toHaveLength(1);
  });

  it('keeps the attribution and run of the scope where the call started, after the scope ends', async () => {
    const h = harness();
    h.fake.answer('chat.send', eventStream(chatChunks()));
    const stream = await withAudr(
      {
        attribution: { account_id: 'acct_1', labels: { team: 'blue' } },
        run: { run_id: 'run-0000001', parent_span_id: 'span-1', name: 'planner' },
      },
      () => h.openrouter.chat.send(CHAT as never),
    );
    await drain(stream as AsyncIterable<unknown>);
    const [record] = await h.records();
    expect(record?.attribution).toMatchObject({
      environment: 'test',
      account_id: 'acct_1',
      labels: { team: 'blue' },
    });
    expect(record?.run).toMatchObject({
      run_id: 'run-0000001',
      parent_span_id: 'span-1',
      name: 'planner',
      run_type: 'agent_run',
      span_id: `chat:${GENERATION_ID}`,
    });
  });
});

describe('a chat stream that ends without a record', () => {
  it('reports "ended" once when the body ends without usage', async () => {
    const { h, stream } = await chatStream(chatChunks().slice(0, 2));
    expect(await drain(stream)).toHaveLength(2);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('chat.send', 'ended')]);
  });

  it('reports "abandoned" once when the loop stops early', async () => {
    const { h, stream } = await chatStream(chatChunks());
    await breakAfter(stream, 1);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('chat.send', 'abandoned')]);
  });

  it('reports "closed" once when cancel() is called', async () => {
    const { h, stream } = await chatStream(chatChunks());
    await stream.cancel();
    await drain(stream);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('chat.send', 'closed')]);
  });

  it('reports "failed" once, and rethrows the native error, when reading fails', async () => {
    const { h, stream } = await chatStream(chatChunks(), {}, { failAfter: 1 });
    await expect(drain(stream)).rejects.toThrow(TypeError);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('chat.send', 'failed')]);
  });

  it('reports "error_frame" once when a chunk carries an error and no usage follows', async () => {
    const frames = [chatChunks()[0], { error: { code: 500, message: 'private text' } }];
    const { h, stream } = await chatStream(frames);
    await drain(stream);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('chat.send', 'error_frame')]);
    expect(h.logger.lines.join('\n')).not.toContain('private text');
  });

  it('records a stream whose error chunk is followed by usage, and says nothing', async () => {
    const frames = [{ error: { code: 429 } }, ...chatChunks()];
    const { h, stream } = await chatStream(frames);
    await drain(stream);
    expect(await h.records()).toHaveLength(1);
    expect(h.logger.lines).toEqual([]);
  });

  it('does not report a stream twice when it is cancelled after it was abandoned', async () => {
    const { h, stream } = await chatStream(chatChunks());
    await breakAfter(stream, 1);
    await stream.cancel().catch(() => undefined);
    expect(h.logger.warnings).toEqual([incomplete('chat.send', 'abandoned')]);
  });

  it('says nothing about a stream that was recorded and then abandoned', async () => {
    const { h, stream } = await chatStream([...chatChunks(), chatChunks()[0]]);
    await breakAfter(stream, 3);
    expect(await h.records()).toHaveLength(1);
    expect(h.logger.lines).toEqual([]);
  });
});

describe('responses.send() with a stream', () => {
  it('yields every event unchanged and records once, from response.completed', async () => {
    const events = responsesEvents();
    const { h, stream } = await responsesStream(events);
    const frames = await drain(stream);
    frames.forEach((frame, index) => {
      expect(frame).toBe(events[index]);
    });
    const records = await h.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      resource: { provider: 'amazon-bedrock', operation: 'generation' },
      usage: { llm: LLM },
      cost: { total_cost: 0.0123, currency: 'USD' },
      run: { run_id: GENERATION_ID, span_id: `response:${GENERATION_ID}`, run_type: 'single_call' },
    });
    expect(records[0]?.run).not.toHaveProperty('error_code');
    expect(h.logger.lines).toEqual([]);
  });

  it('does not record response.created, even though it carries a response', async () => {
    const events = responsesEvents().slice(0, 2);
    const { h, stream } = await responsesStream(events);
    await drain(stream);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('responses.send', 'ended')]);
  });

  it.each([
    ['response.failed', RESPONSE_FAILED_CODE],
    ['response.incomplete', RESPONSE_INCOMPLETE_CODE],
  ] as const)('records %s with its usage and error code', async (type, code) => {
    const { h, stream } = await responsesStream(responsesEvents(type));
    await drain(stream);
    const [record] = await h.records();
    expect(record?.usage.llm).toEqual(LLM);
    expect(record?.run.error_code).toBe(code);
    expect(h.logger.lines).toEqual([]);
  });

  it.each(['response.failed', 'response.incomplete'] as const)(
    'records nothing for %s without usage, and reports "no_usage" once',
    async (type) => {
      const { h, stream } = await responsesStream(
        responsesEvents(type, responsesResult({ usage: null })),
      );
      await drain(stream);
      expect(await h.records()).toEqual([]);
      expect(h.logger.warnings).toEqual([incomplete('responses.send', 'no_usage')]);
    },
  );

  it('reports "error_frame" once for an error event and no terminal event', async () => {
    const { h, stream } = await responsesStream([
      responsesEvents()[0],
      { type: 'error', code: 'server_error', message: 'private text', sequenceNumber: 1 },
    ]);
    await drain(stream);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('responses.send', 'error_frame')]);
    expect(h.logger.lines.join('\n')).not.toContain('private text');
  });

  it('reports "abandoned" once when the loop stops early', async () => {
    const { h, stream } = await responsesStream(responsesEvents());
    await breakAfter(stream, 2);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('responses.send', 'abandoned')]);
  });

  it('looks the vendor up by the terminal response id when the event has no metadata', async () => {
    const events = responsesEvents(
      'response.completed',
      responsesResult({ openrouterMetadata: undefined, usage: responsesUsage() }),
    );
    const h = harness();
    h.fake
      .answer('responses.send', eventStream(events))
      .answer('generations.getGeneration', generation({ providerName: 'Together' }));
    const stream = await h.openrouter.responses.send(RESPONSES);
    await drain(stream as AsyncIterable<unknown>);
    expect(h.fake.lookups[0]?.args[0]).toEqual({ id: GENERATION_ID });
    expect((await h.records())[0]?.resource.provider).toBe('together');
  });

  it('ignores events that are not objects', async () => {
    const { h, stream } = await responsesStream([null, 'x', ...responsesEvents()]);
    expect(await drain(stream)).toHaveLength(5);
    expect(await h.records()).toHaveLength(1);
  });
});

describe('consuming a stream through getReader()', () => {
  it('is not metered, and is not disturbed either', async () => {
    const chunks = chatChunks();
    const { h, stream } = await chatStream(chunks);
    const reader = (stream as unknown as ReadableStream<unknown>).getReader();
    const frames: unknown[] = [];
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      frames.push(step.value);
    }
    expect(frames).toEqual(chunks);
    expect(await h.records()).toEqual([]);
    expect(h.logger.lines).toEqual([]);
  });
});
