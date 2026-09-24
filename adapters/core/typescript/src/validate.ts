import * as z from 'zod/mini';

import { type ErrorCode, issue, type ValidationIssue } from './errors.js';
import { type AudrRecord } from './record.js';
import { audrRecord, MODEL_OPERATIONS, parseTimestamp, TOOL_OPERATIONS } from './schema.js';

export interface ValidateOptions {
  /** The moment `timing.event_time` is compared against. Defaults to now. */
  readonly now?: Date | undefined;
}

// Emitter clocks drift, so a record minted slightly ahead of the validator remains valid.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Every rule `value` breaks as an AUDR record; empty when it is conformant. Never throws.
 *
 * Structural rules (types, formats, closed objects) are checked first. The cross-field
 * rules the specification states in prose run once the record is structurally sound.
 */
export function validate(value: unknown, options: ValidateOptions = {}): ValidationIssue[] {
  return inspect(value, options).issues;
}

/** `validate`, also reporting whether `value` is well-formed enough to be a record. */
export function inspect(
  value: unknown,
  options: ValidateOptions = {},
): { issues: ValidationIssue[]; wellFormed: boolean } {
  const structural = z.safeParse(audrRecord, value).error?.issues ?? [];
  if (structural.length > 0) {
    // Only the record itself can fail at the root, and it is never merely absent.
    const issues = structural.map((found) =>
      found.path.length === 0
        ? issue('INVALID_TYPE', '/')
        : issue(found.message as ErrorCode, pointer(found.path)),
    );
    return { issues: dedupe(issues), wellFormed: false };
  }
  const now = options.now?.getTime() ?? Date.now();
  return { issues: dedupe(crossFieldIssues(value as AudrRecord, now)), wellFormed: true };
}

// Cross-field rules: what the specification states in prose or in `allOf` branches.

function crossFieldIssues(record: AudrRecord, now: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const eventTime = parseTimestamp(record.timing.event_time);
  if (eventTime && /[1-9]/.test(eventTime.fraction.slice(3))) {
    issues.push(issue('MILLISECOND_PRECISION', '/timing/event_time'));
  }
  if (eventTime && eventTime.epochMs > now + FUTURE_SKEW_MS) {
    issues.push(issue('FUTURE_EVENT_TIME', '/timing/event_time'));
  }

  const { resource, usage: counters, cost: asserted } = record;
  if ((counters.llm === undefined) === (counters.tool === undefined)) {
    issues.push(issue('INVALID_STRUCTURE', '/usage'));
  }
  if (isOneOf(resource.operation, MODEL_OPERATIONS)) {
    if (resource.type !== 'model') issues.push(issue('INVALID_STRUCTURE', '/resource/type'));
    if (resource.modality === undefined) issues.push(issue('REQUIRED', '/resource/modality'));
    if (counters.llm === undefined) issues.push(issue('INVALID_STRUCTURE', '/usage'));
    if (asserted?.tool !== undefined) issues.push(issue('FORBIDDEN', '/cost/tool'));
  } else if (isOneOf(resource.operation, TOOL_OPERATIONS)) {
    if (resource.type !== 'tool') issues.push(issue('INVALID_STRUCTURE', '/resource/type'));
    if (counters.tool === undefined) issues.push(issue('INVALID_STRUCTURE', '/usage'));
    if (asserted?.llm !== undefined) issues.push(issue('FORBIDDEN', '/cost/llm'));
  }

  const { environment, account_id, user_id } = record.attribution;
  if (environment === undefined) {
    issues.push(issue('REQUIRED', '/attribution/environment'));
  } else if (environment === 'production' && account_id === undefined) {
    issues.push(issue('REQUIRED', '/attribution/account_id'));
  }
  if (user_id?.includes('@')) {
    issues.push(issue('NON_PSEUDONYMOUS_ID', '/attribution/user_id'));
  }
  return issues;
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

/** The RFC 6901 pointer for a Zod issue path; `/` for the record itself. */
function pointer(path: readonly PropertyKey[]): string {
  const segments = path.map((segment) =>
    String(segment).replaceAll('~', '~0').replaceAll('/', '~1'),
  );
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const unique = new Map(issues.map((found) => [`${found.code} ${found.path}`, found]));
  return [...unique.values()];
}
