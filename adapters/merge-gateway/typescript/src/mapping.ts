import type { Cost, LlmUsage } from '@openaudr/audr';

/** `resource.provider` for every call served through Merge Gateway. */
export const GATEWAY_PROVIDER = 'merge-gateway';

/** Written to `run.error_code` when a response reports `status: 'failed'`. */
export const RESPONSE_FAILED_CODE = 'MERGE_GATEWAY_RESPONSE_FAILED';

/**
 * Every field the adapter reads from a native response, an embeddings response or a stream
 * frame; it reads nothing else. The `merge-gateway-sdk` 0.4 declarations omit `vendor`,
 * `usage.cost` and the cache and reasoning counters, so the shape Gateway documents is
 * declared here.
 */
export interface GatewayResult {
  readonly id?: string | undefined;
  /** On a stream frame: `response.stream`, `response.done` or `response.error`. */
  readonly object?: string | undefined;
  /** The model that served the call, e.g. `openai/gpt-5.4`. */
  readonly model?: string | undefined;
  /** The execution vendor that served it, e.g. `openai` or `bedrock`. */
  readonly vendor?: string | undefined;
  readonly status?: string | undefined;
  readonly usage?: GatewayUsage | null | undefined;
}

/** Gateway reports a counter it cannot count, such as an automatic route's cache writes, as `null`. */
export interface GatewayUsage {
  /** `/v1/responses`: the whole prompt, cache reads and writes included. */
  readonly input_tokens?: number | null | undefined;
  /** `/v1/responses`: the whole completion, reasoning included. */
  readonly output_tokens?: number | null | undefined;
  readonly cache_read_input_tokens?: number | null | undefined;
  readonly cache_creation_input_tokens?: number | null | undefined;
  readonly reasoning_output_tokens?: number | null | undefined;
  /** `/v1/embeddings`: the input. */
  readonly prompt_tokens?: number | null | undefined;
  /** USD for the route and tier that served the call, net of discounts; `null` when unpriced. */
  readonly cost?: number | null | undefined;
}

/**
 * AUDR counters from a `/v1/responses` usage object. AUDR's `input_tokens` excludes cache
 * reads and writes and its `output_tokens` excludes reasoning, so each is reduced by the
 * counters Gateway reports alongside it. When cache reads are `null`, `input_tokens` cannot
 * exclude them and is omitted. Writes Gateway reports as `null` are billed at the input rate,
 * so they stay in `input_tokens`. When reasoning is `null`, no `reasoning_tokens` is written,
 * so `output_tokens` keeps the whole completion. An absent split did not apply and is
 * treated as zero. `total_tokens` is never copied.
 */
export function responseUsage(usage: GatewayUsage | null | undefined): LlmUsage {
  const cacheRead = usage?.cache_read_input_tokens;
  const cacheWrite = usage?.cache_creation_input_tokens;
  const reasoning = usage?.reasoning_output_tokens;
  return {
    input_tokens:
      cacheRead === null
        ? undefined
        : exclusive(usage?.input_tokens, (cacheRead ?? 0) + (cacheWrite ?? 0)),
    output_tokens: exclusive(usage?.output_tokens, reasoning ?? 0),
    cache_read_tokens: cacheRead ?? undefined,
    cache_write_tokens: cacheWrite ?? undefined,
    reasoning_tokens: reasoning ?? undefined,
    requests: 1,
  };
}

/** AUDR counters from a `/v1/embeddings` usage object: `prompt_tokens` is the input. */
export function embeddingUsage(usage: GatewayUsage | null | undefined): LlmUsage {
  return { input_tokens: usage?.prompt_tokens ?? undefined, requests: 1 };
}

/**
 * Gateway's per-call `usage.cost` as `total_cost` in USD. It is net of discounts and can
 * include hosted image generation, so it is never broken down by token type.
 */
export function toCost(usage: GatewayUsage | null | undefined): Cost | undefined {
  const cost = usage?.cost;
  return cost == null ? undefined : { total_cost: cost, currency: 'USD' };
}

/** Whether a response id can serve as `run.run_id`, which AUDR limits to 8 to 64 characters. */
export function fitsRunId(id: string): boolean {
  return id.length >= 8 && id.length <= 64;
}

/** `total` less `part`, never below zero; `undefined` when Gateway did not report `total`. */
function exclusive(total: number | null | undefined, part: number): number | undefined {
  return total == null ? undefined : Math.max(total - part, 0);
}
