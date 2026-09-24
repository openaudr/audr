import type * as z from 'zod/mini';

import * as schema from './schema.js';
import { uuidv7 } from './uuid.js';

export type EmitterComponent = (typeof schema.EMITTER_COMPONENTS)[number];
export type ResourceType = (typeof schema.RESOURCE_TYPES)[number];
export type Operation = (typeof schema.OPERATIONS)[number];
export type Modality = (typeof schema.MODALITIES)[number];
export type RunType = (typeof schema.RUN_TYPES)[number];
export type RunOutcome = (typeof schema.RUN_OUTCOMES)[number];
export type Environment = (typeof schema.ENVIRONMENTS)[number];

// Every optional property also accepts `undefined`, which the SDK treats as absent, so
// records built from optional runtime values type-check under `exactOptionalPropertyTypes`.

/** The software component that wrote the record. */
export type Emitter = z.infer<typeof schema.emitter>;
/** When the operation happened and how long it took. */
export type Timing = z.infer<typeof schema.timing>;
/** The consumed model or tool. */
export type Resource = z.infer<typeof schema.resource>;
/** Groups metered operations into a run and span hierarchy. */
export type Run = z.infer<typeof schema.run>;
/** Billability and allocation dimensions. */
export type Attribution = z.infer<typeof schema.attribution>;
/** Exactly one of `llm` or `tool`, selected by `resource.operation`. */
export type Usage = z.infer<typeof schema.usage>;
/** Model-call counters. Absent means unreported; zero means measured as zero. */
export type LlmUsage = z.infer<typeof schema.llmUsage>;
/** Tool counters, reported by the component that executed the tool. */
export type ToolUsage = z.infer<typeof schema.toolUsage>;
/** An informational cost assertion that rating may use or ignore. */
export type Cost = z.infer<typeof schema.cost>;
export type LlmCost = z.infer<typeof schema.llmCost>;
export type ToolCost = z.infer<typeof schema.toolCost>;

/** One metered operation in an agent system. */
export interface AudrRecord extends Omit<z.infer<typeof schema.audrRecord>, 'emitter'> {
  /** Left unset to let a `Client` stamp its own emitter on delivery. */
  readonly emitter?: Emitter | undefined;
}

/** The fields `createRecord` needs; everything SDK-owned is optional. */
export interface RecordInput extends Omit<AudrRecord, 'spec_version' | 'record_id' | 'timing'> {
  readonly spec_version?: string | undefined;
  readonly record_id?: string | undefined;
  readonly timing?:
    (Omit<Timing, 'event_time'> & { readonly event_time?: Date | string | undefined }) | undefined;
}

/**
 * Build a record, filling what the SDK owns: `spec_version`, a fresh UUIDv7 `record_id`,
 * and `timing.event_time` (now, unless given). A `Date` is rendered as RFC 3339 with
 * millisecond precision. The record is not validated here; `Client.record()` does that.
 */
export function createRecord(input: RecordInput): AudrRecord {
  const { timing, ...rest } = input;
  const eventTime = timing?.event_time ?? new Date();
  return {
    ...rest,
    spec_version: input.spec_version ?? schema.SPEC_VERSION,
    record_id: input.record_id ?? uuidv7(),
    timing: {
      ...timing,
      event_time: typeof eventTime === 'string' ? eventTime : toTimestamp(eventTime),
    },
  };
}

function toTimestamp(date: Date): string {
  return Number.isNaN(date.getTime()) ? String(date) : date.toISOString();
}
