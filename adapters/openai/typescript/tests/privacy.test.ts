/**
 * A sentinel placed in every payload position of a request and a response must
 * reach no record and no log line.
 */
import { describe, expect, it } from 'vitest';

import { withAudr } from '../src/index.js';
import {
  chatChunks,
  chatCompletion,
  drain,
  embedding,
  harness,
  response,
  responseEvents,
} from './helpers.js';

const SENTINEL = 'SENTINEL-7f3a9c';

function leakyCompletion(): Record<string, unknown> {
  return chatCompletion({
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: SENTINEL,
          refusal: SENTINEL,
          tool_calls: [
            { id: SENTINEL, type: 'function', function: { name: SENTINEL, arguments: SENTINEL } },
          ],
        },
        finish_reason: 'tool_calls',
        logprobs: { content: [{ token: SENTINEL }] },
      },
    ],
    system_fingerprint: SENTINEL,
    service_tier: SENTINEL,
  });
}

function leakyResponse(): Record<string, unknown> {
  return response({
    output: [
      {
        type: 'message',
        id: SENTINEL,
        role: 'assistant',
        content: [{ type: 'output_text', text: SENTINEL, annotations: [SENTINEL] }],
      },
      { type: 'reasoning', id: SENTINEL, summary: [{ type: 'summary_text', text: SENTINEL }] },
      { type: 'function_call', id: SENTINEL, name: SENTINEL, arguments: SENTINEL },
    ],
    instructions: SENTINEL,
    metadata: { note: SENTINEL },
    previous_response_id: SENTINEL,
    user: SENTINEL,
    error: null,
    incomplete_details: null,
  });
}

describe('no payloads, no values in diagnostics', () => {
  it('sentinel in every payload position reaches no record and no log line', async () => {
    const h = harness();
    const messages = [
      { role: 'system' as const, content: SENTINEL },
      { role: 'user' as const, content: SENTINEL },
    ];
    const tools = [
      { type: 'function' as const, function: { name: SENTINEL, description: SENTINEL } },
    ];
    h.fake
      .json(leakyCompletion())
      .sse(chatChunks(leakyCompletion()))
      .json(leakyResponse())
      .sse(responseEvents(leakyResponse()))
      .json(embedding({ data: [{ object: 'embedding', index: 0, embedding: SENTINEL }] }))
      .json({ error: { type: SENTINEL, message: SENTINEL, code: SENTINEL } }, 400);

    await withAudr({ attribution: { labels: { feature: 'chat' } } }, async () => {
      await h.openai.chat.completions.create({
        model: 'gpt-5.4',
        messages,
        tools,
        user: SENTINEL,
        metadata: { k: SENTINEL },
      });
      await drain(
        await h.openai.chat.completions.create({
          model: 'gpt-5.4',
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
      );
      await h.openai.responses.create({
        model: 'gpt-5.4',
        input: SENTINEL,
        instructions: SENTINEL,
        metadata: { k: SENTINEL },
      });
      await drain(
        await h.openai.responses.create({ model: 'gpt-5.4', input: SENTINEL, stream: true }),
      );
      await h.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: [SENTINEL],
        user: SENTINEL,
      });
      await expect(
        h.openai.chat.completions.create({ model: 'gpt-5.4', messages }),
      ).rejects.toThrow(SENTINEL);
    });

    const records = await h.records();
    expect(records).toHaveLength(5);
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
    expect(h.logger.lines).toEqual([]);
    for (const line of h.clientLogger.lines) {
      expect(line).not.toContain(SENTINEL);
    }
  });
});
