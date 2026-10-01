import type { UsageStats } from '@mastra/core/observability';
import type { LlmUsage } from '@openaudr/audr';

/** Written to `run.error_code` on a failed model generation that still reported usage. */
export const MODEL_ERROR_CODE = 'MASTRA_MODEL_ERROR';

/** Written to `run.error_code` on a failed tool call. */
export const TOOL_ERROR_CODE = 'MASTRA_TOOL_ERROR';

/** `resource.provider` for every tool Mastra executes. */
export const TOOL_PROVIDER = 'self-hosted';

/**
 * AI SDK provider ids whose vendor prefix is not the AUDR provider. Each entry matches the
 * id itself and every `<id>.<api>` below it; the first match wins. Kept identical to the
 * Vercel AI SDK adapter so records from both join on `resource.provider`.
 */
const PROVIDER_ALIASES: readonly (readonly [prefixes: readonly string[], slug: string])[] = [
  [['gateway'], 'vercel-ai-gateway'],
  [['azure'], 'azure-openai'],
  [['amazon-bedrock', 'bedrock', 'bedrock-mantle'], 'aws-bedrock'],
  [['google.vertex', 'googleVertex', 'vertex'], 'google-vertex'],
];

/** A reported counter, or `undefined` unless it is a finite integer >= 0. */
export function counter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A non-empty string, or `undefined`. */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * AUDR token counters from Mastra usage, or `undefined` when nothing was reported. Mastra's
 * `inputTokens` includes cache reads and writes and its `outputTokens` includes reasoning,
 * while AUDR counts each separately, so both totals are reduced. `inputDetails.text` is not
 * used: it also excludes audio and image tokens, which AUDR still counts as input.
 */
export function toLlmUsage(usage: UsageStats): LlmUsage | undefined {
  const cacheRead = counter(usage.inputDetails?.cacheRead);
  const cacheWrite = counter(usage.inputDetails?.cacheWrite);
  const reasoning = counter(usage.outputDetails?.reasoning);
  const llm = withoutUndefined({
    input_tokens: subtract(counter(usage.inputTokens), (cacheRead ?? 0) + (cacheWrite ?? 0)),
    output_tokens: subtract(counter(usage.outputTokens), reasoning ?? 0),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
  });
  return Object.keys(llm).length === 0 ? undefined : llm;
}

/**
 * The AUDR provider for a Mastra provider id: the alias table first, then the text before
 * the first `.`, lowercased, with runs of other characters replaced by `-`. `undefined`
 * when nothing valid remains.
 */
export function providerSlug(provider: unknown): string | undefined {
  if (typeof provider !== 'string') return undefined;
  for (const [prefixes, slug] of PROVIDER_ALIASES) {
    if (prefixes.some((prefix) => provider === prefix || provider.startsWith(`${prefix}.`))) {
      return slug;
    }
  }
  const head = provider.split('.', 1)[0] ?? '';
  const slug = head
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : undefined;
}

/** The span's end as the event time, and its duration when both ends are valid. */
export function spanTiming(
  startTime: unknown,
  endTime: unknown,
): { eventTime: Date; durationMs: number | undefined } {
  const start = toDate(startTime);
  const end = toDate(endTime);
  const durationMs =
    start !== undefined && end !== undefined && end >= start
      ? end.getTime() - start.getTime()
      : undefined;
  return { eventTime: end ?? start ?? new Date(), durationMs };
}

function toDate(value: unknown): Date | undefined {
  const date =
    value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  return date === undefined || Number.isNaN(date.getTime()) ? undefined : date;
}

function subtract(total: number | undefined, part: number): number | undefined {
  return total === undefined ? undefined : Math.max(total - part, 0);
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
