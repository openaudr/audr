/** A tool whose `execute` starts another AI SDK call: the child joins the parent's run. */
import { embed, generateText, isStepCount, type Telemetry, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { AudrRecord } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { embeddingModel, harness, model, PROVIDER_USAGE, withAudr } from './helpers.js';

function researchTool(telemetry: Telemetry) {
  return tool({
    inputSchema: z.object({ topic: z.string() }),
    execute: async () => {
      // The child passes its own attribution, which must not win over the parent's.
      const inner = await generateText({
        model: model({ toolCalls: [{ id: 'inner-tc', name: 'lookup', input: '{"id":"1"}' }] }),
        prompt: 'x',
        tools: {
          lookup: tool({
            inputSchema: z.object({ id: z.string() }),
            execute: () => Promise.resolve({ ok: true }),
          }),
        },
        stopWhen: isStepCount(3),
        ...withAudr(telemetry, { account_id: 'someone-else' }),
      });
      await embed({ model: embeddingModel(), value: 'x', ...withAudr(telemetry) });
      return { summary: inner.text };
    },
  });
}

function byRun(records: readonly AudrRecord[]): Map<string, AudrRecord[]> {
  const runs = new Map<string, AudrRecord[]>();
  for (const record of records) {
    runs.set(record.run.run_id, [...(runs.get(record.run.run_id) ?? []), record]);
  }
  return runs;
}

describe('spawned agents join the parent run', () => {
  it('a sub-agent in a tool shares the run, points at the tool span and inherits attribution', async () => {
    const h = harness({ attributionDefaults: { environment: 'production' } });
    await generateText({
      model: model({ toolCalls: [{ id: 'outer-tc', name: 'research', input: '{"topic":"t"}' }] }),
      prompt: 'x',
      tools: { research: researchTool(h.telemetry) },
      stopWhen: isStepCount(3),
      ...withAudr(h.telemetry, { account_id: 'acct_42' }),
    });
    const records = await h.records();
    const runs = byRun(records);
    expect(runs.size).toBe(1);
    const [runId] = runs.keys();
    const toolSpan = `tool:${runId!}:0:outer-tc`;

    const outer = records.filter((r) => r.run.parent_span_id === undefined);
    const inner = records.filter((r) => r.run.parent_span_id !== undefined);
    expect(outer.map((r) => r.resource.operation)).toEqual([
      'generation',
      'tool_execution',
      'generation',
    ]);
    expect(inner.map((r) => r.resource.operation).sort()).toEqual([
      'embedding',
      'generation',
      'generation',
      'tool_execution',
    ]);
    expect(inner.every((r) => r.run.parent_span_id === toolSpan)).toBe(true);
    for (const record of records) {
      expect(record.attribution).toEqual({ environment: 'production', account_id: 'acct_42' });
      expect(record.run.run_type).toBe('agent_run');
    }
    // The spawning tool's own record is emitted after its sub-agent's.
    const toolRecord = outer.find((r) => r.run.span_id === toolSpan)!;
    expect(inner.every((r) => r.run.step! < toolRecord.run.step!)).toBe(true);
  });

  it('spans and steps are unique across the parent and its sub-agents', async () => {
    const h = harness();
    await generateText({
      model: model({ toolCalls: [{ id: 'outer-tc', name: 'research', input: '{"topic":"t"}' }] }),
      prompt: 'x',
      tools: { research: researchTool(h.telemetry) },
      stopWhen: isStepCount(3),
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    expect(records).toHaveLength(7);
    expect(new Set(records.map((r) => r.run.span_id)).size).toBe(records.length);
    expect(records.map((r) => r.run.step).sort((a, b) => a! - b!)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('parallel tools each point their sub-agent at their own span', async () => {
    const h = harness();
    const spawn = tool({
      inputSchema: z.object({ n: z.string() }),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await generateText({ model: model(), prompt: 'x', ...withAudr(h.telemetry) });
        return { ok: true };
      },
    });
    await generateText({
      model: model({
        toolCalls: [
          { id: 'a', name: 'spawn', input: '{"n":"1"}' },
          { id: 'b', name: 'spawn', input: '{"n":"2"}' },
        ],
      }),
      prompt: 'x',
      tools: { spawn },
      stopWhen: isStepCount(3),
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    const runId = records[0]!.run.run_id;
    const children = records.filter((r) => r.run.parent_span_id !== undefined);
    expect(children).toHaveLength(2);
    expect(children.map((r) => r.run.parent_span_id).sort()).toEqual([
      `tool:${runId}:0:a`,
      `tool:${runId}:1:b`,
    ]);
    expect(records.every((r) => r.run.run_id === runId)).toBe(true);
  });

  it('executeTool is transparent to the value a tool resolves', async () => {
    const h = harness();
    const value = { nested: [1, 2, 3] };
    const result = await generateText({
      model: model({ toolCalls: [{ id: 'tc', name: 'echo', input: '{}' }] }),
      prompt: 'x',
      tools: {
        echo: tool({ inputSchema: z.object({}), execute: () => Promise.resolve(value) }),
      },
      stopWhen: isStepCount(1),
      ...withAudr(h.telemetry),
    });
    expect(result.toolResults[0]!.output).toBe(value);
  });

  it('executeTool is transparent to the error a tool rejects with', async () => {
    const h = harness();
    const error = new TypeError('boom');
    const result = await generateText({
      model: model({ toolCalls: [{ id: 'tc', name: 'fail', input: '{}' }] }),
      prompt: 'x',
      tools: {
        fail: tool({
          inputSchema: z.object({}),
          execute: (): Promise<{ ok: boolean }> => Promise.reject(error),
        }),
      },
      stopWhen: isStepCount(1),
      ...withAudr(h.telemetry),
    });
    const part = result.content.find((p) => p.type === 'tool-error');
    expect(part?.type === 'tool-error' ? part.error : undefined).toBe(error);
  });

  it('a call metered by another integration does not join the run', async () => {
    const outer = harness({ attributionDefaults: { environment: 'production', account_id: 'A' } });
    const inner = harness({ attributionDefaults: { environment: 'staging', account_id: 'B' } });
    const spawn = tool({
      inputSchema: z.object({}),
      execute: async () => {
        await generateText({
          model: model(),
          prompt: 'x',
          telemetry: { integrations: [inner.telemetry] },
        });
        return {};
      },
    });
    await generateText({
      model: model({ toolCalls: [{ id: 'tc', name: 'spawn', input: '{}' }] }),
      prompt: 'x',
      tools: { spawn },
      stopWhen: isStepCount(1),
      telemetry: { integrations: [outer.telemetry] },
    });
    const [outerRecords, innerRecords] = [await outer.records(), await inner.records()];
    expect(innerRecords).toHaveLength(1);
    expect(innerRecords[0]!.attribution).toEqual({ environment: 'staging', account_id: 'B' });
    expect(innerRecords[0]!.run.parent_span_id).toBeUndefined();
    expect(innerRecords[0]!.run.run_id).not.toBe(outerRecords[0]!.run.run_id);
  });

  it('a sub-agent under a reused tool call id points at its own execution', async () => {
    const h = harness();
    let calls = 0;
    const spawnTwice = new MockLanguageModelV4({
      provider: 'openai-compatible.chat',
      modelId: 'local-model',
      doGenerate: () => {
        calls += 1;
        const again = calls <= 2;
        return Promise.resolve({
          content: again
            ? [{ type: 'tool-call', toolCallId: 'call_0', toolName: 'spawn', input: '{}' }]
            : [{ type: 'text', text: 'ok' }],
          finishReason: again
            ? { unified: 'tool-calls', raw: 'tool_calls' }
            : { unified: 'stop', raw: 'stop' },
          usage: PROVIDER_USAGE,
          warnings: [],
        });
      },
    });
    const spawn = tool({
      inputSchema: z.object({}),
      execute: async () => {
        await generateText({ model: model(), prompt: 'x', ...withAudr(h.telemetry) });
        return {};
      },
    });
    await generateText({
      model: spawnTwice,
      prompt: 'x',
      tools: { spawn },
      stopWhen: isStepCount(5),
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    const toolSpans = records
      .filter((r) => r.resource.operation === 'tool_execution')
      .map((r) => r.run.span_id);
    const parents = records.flatMap((r) =>
      r.run.parent_span_id === undefined ? [] : [r.run.parent_span_id],
    );
    expect(toolSpans).toHaveLength(2);
    expect(new Set(toolSpans).size).toBe(2);
    expect(parents).toEqual(toolSpans);
  });

  it('a call inside a tool of an unmetered call resolves its own attribution', async () => {
    const h = harness({ attributionDefaults: {} });
    const spawn = tool({
      inputSchema: z.object({}),
      execute: async () => {
        await generateText({
          model: model(),
          prompt: 'x',
          ...withAudr(h.telemetry, { environment: 'test' }),
        });
        return {};
      },
    });
    await generateText({
      model: model({ toolCalls: [{ id: 'tc', name: 'spawn', input: '{}' }] }),
      prompt: 'x',
      tools: { spawn },
      stopWhen: isStepCount(1),
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    expect(records).toHaveLength(1);
    expect(records[0]!.run.parent_span_id).toBeUndefined();
    expect(h.logger.warnings).toEqual([
      '@openaudr/audr-adapter-vercel-ai: ATTRIBUTION_UNRESOLVED (operation=ai.generateText)',
    ]);
  });
});
