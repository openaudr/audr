/**
 * The machine-stable AUDR failure codes, each with its value-free message. Codes are added,
 * never removed, and a message never includes a record value.
 */
const MESSAGES = {
  REQUIRED: 'required property is missing',
  FORBIDDEN: 'property is not allowed in this context',
  UNKNOWN_PROPERTY: 'property is not defined by the schema',
  INVALID_TYPE: 'value has the wrong type',
  INVALID_ENUM: 'value is not one of the allowed enumerants',
  INVALID_STRING: 'string is empty or does not match the required format',
  STRING_TOO_LONG: 'string exceeds the maximum allowed length',
  INVALID_IDENTIFIER: 'identifier is not in the required format',
  INVALID_DATETIME: 'value is not a valid RFC 3339 datetime',
  MILLISECOND_PRECISION: 'timestamp must have millisecond precision',
  FUTURE_EVENT_TIME: 'event_time must not be in the future',
  INVALID_COUNTER: 'counter must be a finite number greater than or equal to zero',
  INVALID_COST: 'cost amount must be a finite number within its allowed range',
  INVALID_CURRENCY: 'currency must be a three-letter ISO 4217 code',
  INVALID_PROPERTY_NAME: 'property name is not a valid AUDR key',
  TOO_MANY_PROPERTIES: 'too many properties were provided',
  NON_PSEUDONYMOUS_ID: 'user_id must be a pseudonymous identifier, not a raw personal value',
  EMPTY_USAGE: 'usage block must contain at least one counter',
  INVALID_STRUCTURE: 'record shape violates a cross-field rule',
  UNSUPPORTED_VERSION: 'spec_version is not a supported AUDR release',
  NOT_JSON: 'input is not valid JSON',
} as const satisfies Readonly<Record<string, string>>;

export type ErrorCode = keyof typeof MESSAGES;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(MESSAGES, value);
}

/** One rule a record breaks: a stable code and an RFC 6901 pointer, never a value. */
export interface ValidationIssue {
  readonly code: ErrorCode;
  readonly path: string;
  readonly message: string;
}

export function issue(code: ErrorCode, path: string): ValidationIssue {
  return { code, path, message: MESSAGES[code] };
}

/** Base class for every error this package throws. */
export class AudrError extends Error {
  override readonly name: string = 'AudrError';
}

/** Invalid constructor or method arguments. */
export class ConfigurationError extends AudrError {
  override readonly name: string = 'ConfigurationError';
}

/** A record failed to parse or validate; `issues` names every rule it breaks. */
export class ValidationError extends AudrError {
  override readonly name: string = 'ValidationError';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues.map((found) => `${found.code} at ${found.path}`).join('; ');
    super(`${String(issues.length)} issue(s): ${summary}`);
    this.issues = issues;
  }
}

/**
 * An error's class name, never its message: a message may carry record values. Never throws,
 * because it runs while an error is being handled.
 */
export function errorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error;
    const name: unknown = error.name;
    return typeof name === 'string' ? name : 'unknown';
  } catch {
    return 'unknown';
  }
}
