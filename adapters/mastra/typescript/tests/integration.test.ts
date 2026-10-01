/**
 * End to end: real Mastra agent runs with mock models and the AUDR exporter registered
 * on an Observability instance.
 */
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { Observability } from '@mastra/observability';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { harness, type Harness } from './helpers.js';

const USAGE = {
  inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: undefined },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
};

/** Calls the `lookup` tool on the first step, then answers. */
function mockModel(): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    provider: 'openai.chat',
    modelId: 'gpt-5.4',
    doGenerate: () => {
      calls += 1;
      const content =
        calls === 1
          ? [
              {
                type: 'tool-call' as const,
                toolCallId: 'tc-1',
                toolName: 'lookup',
                input: JSON.stringify({ id: '42' }),
              },
            ]
          : [{ type: 'text' as const, text: 'Order shipped.' }];
      return Promise.resolve({
        content,
        finishReason: { unified: calls === 1 ? 'tool-calls' : 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      });
    },
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'ok' },
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
          ],
        }),
      }),
  });
}

const lookup = createTool({
  id: 'lookup',
  description: 'Look up an order',
  inputSchema: z.object({ id: z.string() }),
  execute: () => Promise.resolve({ status: 'shipped' }),
});

function stack(observabilityConfig: Record<string, unknown> = {}): Harness & { agent: Agent } {
  const h = harness();
  const observability = new Observability({
    configs: {
      default: { serviceName: 'audr-test', exporters: [h.exporter], ...observabilityConfig },
    },
  });
  const agent = new Agent({
    id: 'support',
    name: 'Support',
    instructions: 'Help with orders.',
    model: mockModel(),
    tools: { lookup },
  });
  new Mastra({ agents: { agent }, observability });
  return { ...h, agent };
}

describe('agent.generate', () => {
  it('records one generation summed across steps and one tool call, sharing the trace id', async () => {
    const { agent, records } = stack();
    const result = await agent.generate('Where is order 42?', { maxSteps: 5 });
    const all = await records();
    const generations = all.filter((r) => r.resource.operation === 'generation');
    const tools = all.filter((r) => r.resource.operation === 'tool_execution');

    expect(generations).toHaveLength(1);
    expect(tools).toHaveLength(1);
    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(generations[0]!.run.run_id).toBe(result.traceId);
    expect(tools[0]!.run.run_id).toBe(result.traceId);
    expect(generations[0]!.resource).toEqual({
      provider: 'openai',
      type: 'model',
      name: 'gpt-5.4',
      operation: 'generation',
      modality: 'text',
    });
    expect(generations[0]!.usage.llm).toEqual({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_tokens: 40,
      reasoning_tokens: 20,
    });
    expect(tools[0]!.resource.name).toBe('lookup');
  });

  it('reads attribution from tracingOptions.metadata.audr', async () => {
    const { agent, records } = stack();
    await agent.generate('hi', {
      maxSteps: 5,
      tracingOptions: { metadata: { audr: { account_id: 'acct_ctx' } } },
    });
    const all = await records();
    expect(all).toHaveLength(2);
    for (const record of all) {
      expect(record.attribution).toEqual({ environment: 'test', account_id: 'acct_ctx' });
    }
  });

  it('reads attribution from a request context key', async () => {
    const { agent, records } = stack({ requestContextKeys: ['audr'] });
    const requestContext = new RequestContext();
    requestContext.set('audr', { subscription_id: 'sub_99' });
    await agent.generate('hi', { maxSteps: 5, requestContext });
    const all = await records();
    expect(all).toHaveLength(2);
    for (const record of all) {
      expect(record.attribution).toEqual({ environment: 'test', subscription_id: 'sub_99' });
    }
  });
});

describe('agent.stream', () => {
  it('records one generation once the stream is consumed', async () => {
    const { agent, records } = stack();
    const stream = await agent.stream('hello');
    await stream.consumeStream();
    const generations = (await records()).filter((r) => r.resource.operation === 'generation');
    expect(generations).toHaveLength(1);
  });
});

describe('observability config', () => {
  it('warns at registration when sampling can drop metered spans', () => {
    const { logger } = stack({ sampling: { type: 'ratio', probability: 0.5 } });
    expect(logger.warnings).toContain(
      '@openaudr/audr-adapter-mastra: CONFIG_DROPS_SPANS (setting=sampling)',
    );
  });
});
