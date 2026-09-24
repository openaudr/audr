// Structural rules, transcribed from spec/audr.schema.json. `tests/schema.test.ts` fails if
// a property or enumerant here drifts from the schema. Every error is an `ErrorCode`, which
// `validate.ts` reads back from the issue message.
import * as z from 'zod/mini';

import { type ErrorCode } from './errors.js';

/** The one AUDR release this package implements. */
export const SPEC_VERSION = '1.0.0';
/** Every `spec_version` this package reads and validates: the 1.0.x releases. */
export const SUPPORTED_SPEC_VERSION = /^1\.0\.\d+$/;

export const EMITTER_COMPONENTS = ['harness', 'router', 'provider'] as const;
export const RESOURCE_TYPES = ['model', 'tool'] as const;
export const MODEL_OPERATIONS = ['generation', 'embedding', 'reranking'] as const;
export const TOOL_OPERATIONS = ['tool_execution', 'retrieval'] as const;
export const OPERATIONS = [...MODEL_OPERATIONS, ...TOOL_OPERATIONS] as const;
export const MODALITIES = ['text', 'image', 'audio', 'multimodal'] as const;
export const RUN_TYPES = ['agent_run', 'workflow', 'single_call'] as const;
export const RUN_OUTCOMES = ['resolved', 'escalated', 'abandoned', 'failed'] as const;
export const ENVIRONMENTS = ['production', 'staging', 'development', 'test', 'evaluation'] as const;

/** An `x_*` provider or implementation counter: a non-negative number. */
export type ExtensionKey = `x_${string}`;
type Extensions = Readonly<Record<ExtensionKey, number | undefined>>;

/** What `tests/schema.test.ts` compares against the schema for one object. */
export interface Shape {
  readonly required: readonly string[];
  readonly properties: readonly string[];
  /** The code for a bad `x_*` value; a shape without it admits no extensions. */
  readonly extensions?: ErrorCode | undefined;
}

const EXTENSION_KEY = /^x_[a-z0-9_]+$/;
const LABEL_KEY = /^[a-zA-Z0-9_.-]+$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
// Label keys are caller data, not schema names, so a label's path never includes its key.
const REDACTED = '*';
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `code` for a present value of the wrong type, `REQUIRED` for an absent one. */
function expected(code: ErrorCode = 'INVALID_TYPE') {
  return { error: (found: { input: unknown }) => (found.input === undefined ? 'REQUIRED' : code) };
}

/** A refinement reporting the first code `rule` returns for a value, if any. */
function first<T>(rule: (value: T) => ErrorCode | undefined) {
  return z.refine<T>((value) => rule(value) === undefined, {
    error: (found) => rule(found.input as T),
  });
}

function text(
  rules: { min?: number; max?: number; pattern?: RegExp; patternCode?: ErrorCode } = {},
) {
  const { min = 0, max = Infinity, pattern, patternCode = 'INVALID_STRING' } = rules;
  return z.string(expected()).check(
    first((value: string) => {
      if (codePoints(value) > max) return 'STRING_TOO_LONG';
      if (codePoints(value) < min) return 'INVALID_STRING';
      return pattern && !pattern.test(value) ? patternCode : undefined;
    }),
  );
}

function numeric(code: ErrorCode, rules: { integer?: boolean; max?: number } = {}) {
  const { integer = false, max = Infinity } = rules;
  // Zod rejects NaN and Infinity as a wrong type; the schema only rejects them for integers.
  const error = (found: { input: unknown }) =>
    typeof found.input === 'number' && !integer ? code : expected().error(found);
  return z.number({ error }).check(
    first((value: number) => {
      if (integer && !Number.isInteger(value)) return 'INVALID_TYPE';
      return value < 0 || value > max ? code : undefined;
    }),
  );
}

const oneOf = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, expected('INVALID_ENUM'));

const identifier = z
  .string(expected())
  .check(
    z.refine((value) => ULID.test(value) || UUID7.test(value), { error: 'INVALID_IDENTIFIER' }),
  );

const timestamp = z
  .string(expected())
  .check(z.refine((value) => parseTimestamp(value) !== undefined, { error: 'INVALID_DATETIME' }));

const forbidden = z.optional(z.never({ error: 'FORBIDDEN' }));

type Issues = readonly { readonly message: string; readonly path: readonly PropertyKey[] }[];

/**
 * A schema whose `check` sees the raw input and reports issues at paths relative to it.
 * Key checks cannot run on Zod's output: it drops keys such as `__proto__`.
 */
function raw<T>(check: (value: unknown, report: (issues: Issues, key?: string) => void) => void) {
  const schema = z.unknown().check(
    z.superRefine((value, ctx) => {
      check(value, (issues, key) => {
        for (const { message, path } of issues) {
          ctx.addIssue({
            code: 'custom',
            message,
            path: key === undefined ? [...path] : [key, ...path],
          });
        }
      });
    }),
  );
  return schema as unknown as z.ZodMiniType<T>;
}

const issuesOf = (schema: z.core.$ZodType, value: unknown): Issues =>
  z.safeParse(schema, value).error?.issues ?? [];
const failure = (message: ErrorCode): Issues => [{ message, path: [] }];

const labelValue = text({ max: 256 });
const labels = raw<Readonly<Record<string, string>>>((value, report) => {
  if (!isObject(value)) {
    report(failure('INVALID_TYPE'));
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > 20) report(failure('TOO_MANY_PROPERTIES'));
  for (const [key, label] of entries) {
    if (codePoints(key) > 64 || !LABEL_KEY.test(key)) {
      report(failure('INVALID_PROPERTY_NAME'), REDACTED);
    }
    // Unlike a property, a label set to `undefined` is present, so it has the wrong type.
    report(issuesOf(labelValue, label ?? null), REDACTED);
  }
});

/**
 * A closed object. `undefined` properties count as absent. With `extensions`, `x_*` keys
 * hold numbers checked under that code; with `nonEmpty`, an empty object fails with it.
 */
function object<S extends Record<string, z.core.$ZodType>, E extends ErrorCode | undefined>(
  properties: S,
  rules: { extensions?: E; nonEmpty?: ErrorCode } = {},
) {
  const known = z.object(properties, expected());
  const extension = rules.extensions && numeric(rules.extensions);
  type Closed = Readonly<z.output<typeof known>> & (E extends ErrorCode ? Extensions : unknown);
  const schema = raw<Closed>((value, report) => {
    report(issuesOf(known, value));
    if (!isObject(value)) return;
    const present = Object.keys(value).filter((key) => value[key] !== undefined);
    if (rules.nonEmpty && present.length === 0) report(failure(rules.nonEmpty));
    for (const key of present.filter((name) => !Object.hasOwn(properties, name))) {
      const unknown = !extension || !EXTENSION_KEY.test(key);
      report(unknown ? failure('UNKNOWN_PROPERTY') : issuesOf(extension, value[key]), key);
    }
  });
  const fields = Object.entries(properties);
  const shape: Shape = {
    required: fields.filter(([, field]) => field._zod.def.type !== 'optional').map(([k]) => k),
    properties: fields.map(([key]) => key),
    extensions: rules.extensions,
  };
  return Object.assign(schema, { shape });
}

const optional = z.optional;
const counter = numeric('INVALID_COUNTER', { integer: true });
const quantity = numeric('INVALID_COUNTER');
const amount = numeric('INVALID_COST');
const nonEmpty = text({ min: 1 });
const anyText = text();

export const emitter = object({
  component: oneOf(EMITTER_COMPONENTS),
  /** Package identifier for the emitter. */
  name: nonEmpty,
  /** Emitter release, used to attribute data-quality issues. */
  version: nonEmpty,
});

export const timing = object({
  /** RFC 3339 with millisecond precision. For streams, use stream termination. */
  event_time: timestamp,
  /** Set by the sink at ingest; an emitter never sends it. */
  received_time: forbidden,
  duration_ms: optional(counter),
});

export const resource = object({
  /** Canonical lowercase provider slug, such as `anthropic` or `self-hosted`. */
  provider: text({ pattern: /^[a-z0-9-]+$/ }),
  type: oneOf(RESOURCE_TYPES),
  /** Verbatim model identifier, or a stable logical tool name. */
  name: nonEmpty,
  operation: oneOf(OPERATIONS),
  /** Required for model operations. */
  modality: optional(oneOf(MODALITIES)),
  /** Credential label. Never key material or any part of it. */
  key_name: optional(anyText),
  region: optional(anyText),
  deployment: optional(nonEmpty),
});

export const run = object({
  run_id: text({ min: 8, max: 64 }),
  name: optional(nonEmpty),
  span_id: nonEmpty,
  parent_span_id: optional(nonEmpty),
  step: optional(counter),
  /** W3C trace identifier: 32 lowercase hex characters. */
  trace_id: optional(text({ pattern: /^[0-9a-f]{32}$/, patternCode: 'INVALID_IDENTIFIER' })),
  run_type: optional(oneOf(RUN_TYPES)),
  error_code: optional(nonEmpty),
  /** At most 32 characters. */
  error_reason: optional(text({ max: 32 })),
  /** Emitted only by the harness. */
  outcome: optional(oneOf(RUN_OUTCOMES)),
});

export const attribution = object({
  /** Required: a record without it is never rated. */
  environment: optional(oneOf(ENVIRONMENTS)),
  /** Pseudonymous identity of the user; never an email or name. */
  user_id: optional(anyText),
  /** The account that pays. Required when `environment` is `production`. */
  account_id: optional(nonEmpty),
  subscription_id: optional(anyText),
  /** Up to 20 non-billable dimensions. Never PII. */
  labels: optional(labels),
});

export const llmUsage = object(
  {
    input_tokens: optional(counter),
    output_tokens: optional(counter),
    cache_read_tokens: optional(counter),
    cache_write_tokens: optional(counter),
    reasoning_tokens: optional(counter),
    requests: optional(counter),
    images_processed: optional(counter),
    audio_input_seconds: optional(quantity),
    audio_output_seconds: optional(quantity),
  },
  { nonEmpty: 'EMPTY_USAGE', extensions: 'INVALID_COUNTER' },
);

export const toolUsage = object(
  {
    type: optional(nonEmpty),
    call_count: optional(counter),
    /** Sandbox wall-clock time in milliseconds. */
    sandbox_time: optional(quantity),
  },
  { nonEmpty: 'EMPTY_USAGE', extensions: 'INVALID_COUNTER' },
);

export const usage = object({ llm: optional(llmUsage), tool: optional(toolUsage) });

export const llmCost = object({
  total_token_cost: amount,
  input_token_cost: optional(amount),
  output_token_cost: optional(amount),
  cache_read_cost: optional(amount),
  cache_write_cost: optional(amount),
  reasoning_cost: optional(amount),
});

export const toolCost = object(
  { type: optional(nonEmpty), call_cost: optional(amount), sandbox_cost: optional(amount) },
  { nonEmpty: 'INVALID_STRUCTURE', extensions: 'INVALID_COST' },
);

export const cost = object({
  total_cost: amount,
  /** Uppercase ISO 4217 code. */
  currency: text({ pattern: /^[A-Z]{3}$/, patternCode: 'INVALID_CURRENCY' }),
  llm: optional(llmCost),
  tool: optional(toolCost),
  original_cost: optional(amount),
  discount_amount: optional(amount),
  discount_percent: optional(numeric('INVALID_COST', { max: 100 })),
});

export const audrRecord = object({
  spec_version: text({ pattern: SUPPORTED_SPEC_VERSION, patternCode: 'UNSUPPORTED_VERSION' }),
  /** ULID or UUIDv7, fresh for every record. */
  record_id: identifier,
  /** Left unset to let a `Client` stamp its own emitter on delivery. */
  emitter,
  /** The `record_id` of an earlier record this one fully restates. */
  corrects: optional(identifier),
  timing,
  resource,
  usage,
  run,
  attribution,
  cost: optional(cost),
});

/** Every object shape, keyed by its dotted path in the schema; `''` is the record. */
export const SHAPES: Readonly<Record<string, Shape>> = {
  '': audrRecord.shape,
  emitter: emitter.shape,
  timing: timing.shape,
  resource: resource.shape,
  run: run.shape,
  attribution: attribution.shape,
  usage: usage.shape,
  'usage.llm': llmUsage.shape,
  'usage.tool': toolUsage.shape,
  cost: cost.shape,
  'cost.llm': llmCost.shape,
  'cost.tool': toolCost.shape,
};

/** Epoch milliseconds and the raw fraction digits of an RFC 3339 timestamp, if it is one. */
export function parseTimestamp(value: string): { epochMs: number; fraction: string } | undefined {
  const match = TIMESTAMP.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = '', sign, offsetH, offsetM] = match;
  const [y, mo, d] = [Number(year), Number(month), Number(day)];
  const [h, mi, s] = [Number(hour), Number(minute), Number(second)];
  const [oh, om] = [Number(offsetH ?? 0), Number(offsetM ?? 0)];
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || s > 59) {
    return undefined;
  }
  if (oh > 23 || om > 59) return undefined;
  const offsetMinutes = (sign === '-' ? -1 : 1) * (oh * 60 + om);
  const millis = Number(fraction.slice(0, 3).padEnd(3, '0'));
  return { epochMs: Date.UTC(y, mo - 1, d, h, mi, s, millis) - offsetMinutes * 60_000, fraction };
}

/** A string's length in code points, as JSON Schema `minLength` and `maxLength` count it. */
function codePoints(value: string): number {
  return value.length - (value.match(SURROGATE_PAIR)?.length ?? 0);
}
