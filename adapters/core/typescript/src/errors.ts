/** Machine-stable AUDR failure codes. Codes are added, never removed. */
export type ErrorCode =
  | 'REQUIRED'
  | 'FORBIDDEN'
  | 'UNKNOWN_PROPERTY'
  | 'INVALID_TYPE'
  | 'INVALID_ENUM'
  | 'INVALID_STRING'
  | 'STRING_TOO_LONG'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_DATETIME'
  | 'MILLISECOND_PRECISION'
  | 'FUTURE_EVENT_TIME'
  | 'INVALID_COUNTER'
  | 'INVALID_COST'
  | 'INVALID_CURRENCY'
  | 'INVALID_PROPERTY_NAME'
  | 'TOO_MANY_PROPERTIES'
  | 'NON_PSEUDONYMOUS_ID'
  | 'EMPTY_USAGE'
  | 'INVALID_STRUCTURE'
  | 'UNSUPPORTED_VERSION'
  | 'NOT_JSON';

/** Value-free messages. A message never includes a record value. */
const MESSAGES: Readonly<Record<ErrorCode, string>> = {
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
};

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

/** An error's class name, never its message: a message may carry record values. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
