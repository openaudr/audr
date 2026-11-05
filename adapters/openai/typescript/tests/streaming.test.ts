import { Stream } from 'openai/streaming';
import { describe, expect, it } from 'vitest';

import { RESPONSE_FAILED_CODE } from '../src/index.js';
import {
  CHAT_PARAMS,
  chatChunks,
  drain,
  GENERATION_LLM,
  harness,
  response,
  responseEvents,
  RESPONSES_PARAMS,
} from './helpers.js';

const CHAT_STREAM = {
  ...CHAT_PARAMS,
  stream: true,
  stream_options: { include_usage: true },
} as const;
const RESPONSES_STREAM = { ...RESPONSES_PARAMS, stream: true } as const;

function incomplete(operation: string, reason: string): string {
  return `@openaudr/audr-adapter-openai: STREAM_INCOMPLETE (operation=${operation}, reason=${reason})`;
}

describe('streamed chat completions', () => {
  it('records the usage chunk and yields every chunk unchanged', async () => {
    const h = harness();
    const chunks = chatChunks();
    h.fake.sse(chunks);
    const stream = await h.openai.chat.completions.create(CHAT_STREAM);
    expect(stream).toBeInstanceOf(Stream);
    expect(await drain(stream)).toEqual(chunks);
    const [record, ...rest] = await h.records();
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      resource: { provider: 'openai', name: 'gpt-5.4-2026-03-01', operation: 'generation' },
      usage: { llm: GENERATION_LLM },
      run: { run_id: 'chatcmpl-01J9Z8QK4M', span_id: 'chat:chatcmpl-01J9Z8QK4M' },
    });
    expect(h.fake.requests[0]!.body).toMatchObject({ stream_options: { include_usage: true } });
    expect(h.logger.lines).toEqual([]);
  });

  it('submits the record before the usage chunk reaches the caller', async () => {
    const h = harness();
    h.fake.sse(chatChunks());
    const stream = await h.openai.chat.completions.create(CHAT_STREAM);
    const seen: number[] = [];
    for await (const chunk of stream) {
      seen.push(h.client.stats.submitted);
      if (chunk.usage) break;
    }
    expect(seen).toEqual([0, 0, 1]);
  });

  it('forwards other stream members to the native stream', async () => {
    const h = harness();
    h.fake.sse(chatChunks());
    const stream = await h.openai.chat.completions.create(CHAT_STREAM);
    expect(stream.controller).toBeInstanceOf(AbortController);
    expect(typeof stream.tee).toBe('function');
    await drain(stream);
    expect(await h.records()).toHaveLength(1);
  });

  it('a stream without include_usage ends with no record', async () => {
    const h = harness();
    const chunks = chatChunks().slice(0, 2);
    h.fake.sse(chunks);
    expect(
      await drain(await h.openai.chat.completions.create({ ...CHAT_PARAMS, stream: true })),
    ).toEqual(chunks);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('chat.completions.create', 'ended')]);
  });
});

describe('streamed responses', () => {
  it('records the response.completed event and yields every event unchanged', async () => {
    const h = harness();
    const events = responseEvents();
    h.fake.sse(events);
    const stream = await h.openai.responses.create(RESPONSES_STREAM);
    expect(await drain(stream)).toEqual(events);
    const [record, ...rest] = await h.records();
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      resource: { provider: 'openai', name: 'gpt-5.4-2026-03-01', operation: 'generation' },
      usage: { llm: GENERATION_LLM },
      run: { run_id: 'resp_01J9Z8QK4M', span_id: 'response:resp_01J9Z8QK4M' },
    });
    expect(record!.run.error_code).toBeUndefined();
    expect(h.logger.lines).toEqual([]);
  });

  it('records a response.failed event with its error code', async () => {
    const h = harness();
    h.fake.sse(responseEvents(response({ status: 'failed' }), 'response.failed'));
    await drain(await h.openai.responses.create(RESPONSES_STREAM));
    const [record] = await h.records();
    expect(record!.run.error_code).toBe(RESPONSE_FAILED_CODE);
    expect(record!.usage.llm).toEqual(GENERATION_LLM);
  });

  it('submits the record before the terminal event reaches the caller', async () => {
    const h = harness();
    h.fake.sse(responseEvents());
    const stream = await h.openai.responses.create(RESPONSES_STREAM);
    const seen: number[] = [];
    for await (const event of stream) {
      seen.push(h.client.stats.submitted);
      if (event.type === 'response.completed') break;
    }
    expect(seen).toEqual([0, 0, 1]);
  });
});

describe('incomplete streams produce no record', () => {
  it('a stream that ends without a terminal event', async () => {
    const h = harness();
    h.fake.sse(responseEvents().slice(0, 2));
    await drain(await h.openai.responses.create(RESPONSES_STREAM));
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('responses.create', 'ended')]);
  });

  it('an iteration failure, which still reaches the caller', async () => {
    const h = harness();
    h.fake.sse(chatChunks(), { failAfter: 1 });
    const stream = await h.openai.chat.completions.create(CHAT_STREAM);
    await expect(drain(stream)).rejects.toThrow();
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('chat.completions.create', 'failed')]);
  });

  it('a consumer that stops early', async () => {
    const h = harness();
    h.fake.sse(chatChunks());
    const stream = await h.openai.chat.completions.create(CHAT_STREAM);
    for await (const chunk of stream) {
      expect(chunk).toBeDefined();
      break;
    }
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('chat.completions.create', 'abandoned')]);
  });

  it('an SDK error event, which the SDK throws from the stream', async () => {
    const h = harness();
    h.fake.sse([
      responseEvents()[0],
      { type: 'error', code: 'server_error', message: 'x', param: null, sequence_number: 1 },
    ]);
    const stream = await h.openai.responses.create(RESPONSES_STREAM);
    await expect(drain(stream)).rejects.toThrow();
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('responses.create', 'failed')]);
  });
});
