import type { Logger, SubmitResult } from '@openaudr/audr';

/** Stable codes for every diagnostic the adapter logs. Codes are added, never removed. */
export type DiagnosticCode =
  | 'ATTRIBUTION_UNRESOLVED'
  | 'MAP_RESOURCE_FAILED'
  | 'PROVIDER_UNMAPPED'
  | 'OPERATION_UNSUPPORTED'
  | 'RECORD_NOT_QUEUED'
  | 'HOOK_FAILED';

/**
 * The only keys a diagnostic may carry. Their values are AI SDK operation ids, hook names,
 * error class names, submit outcomes and `<code>@<json-pointer>` issues, never a record
 * value or an error message.
 */
export interface DiagnosticFields {
  /** Always the AI SDK `operationId`, e.g. `ai.generateText`. */
  readonly operation?: string | undefined;
  readonly hook?: string | undefined;
  readonly error?: string | undefined;
  readonly outcome?: string | undefined;
  readonly issues?: string | undefined;
}

const PREFIX = '@openaudr/audr-adapter-vercel-ai';
const FIELD_ORDER = ['hook', 'outcome', 'operation', 'issues', 'error'] as const;

/** `@openaudr/audr-adapter-vercel-ai: <CODE> (<key>=<value>, ...)`. */
export function formatDiagnostic(code: DiagnosticCode, fields: DiagnosticFields): string {
  const parts: string[] = [];
  for (const key of FIELD_ORDER) {
    const value = fields[key];
    if (value !== undefined) parts.push(`${key}=${value}`);
  }
  return parts.length === 0 ? `${PREFIX}: ${code}` : `${PREFIX}: ${code} (${parts.join(', ')})`;
}

/**
 * An error's allowlisted built-in class name, never its mutable `name` or message: either
 * may carry prompt or record values. Never throws because it runs while handling an error.
 */
export function errorName(error: unknown): string {
  try {
    if (error instanceof AggregateError) return 'AggregateError';
    if (error instanceof EvalError) return 'EvalError';
    if (error instanceof RangeError) return 'RangeError';
    if (error instanceof ReferenceError) return 'ReferenceError';
    if (error instanceof SyntaxError) return 'SyntaxError';
    if (error instanceof TypeError) return 'TypeError';
    if (error instanceof URIError) return 'URIError';
    return error instanceof Error ? 'Error' : typeof error;
  } catch {
    return 'unknown';
  }
}

/** `<code>@<path>` for every issue, comma-separated; `undefined` when there are none. */
export function formatIssues(result: SubmitResult): string | undefined {
  if (result.issues.length === 0) return undefined;
  return result.issues.map((found) => `${found.code}@${found.path}`).join(',');
}

/** The default logger: diagnostics are discarded. */
export const SILENT: Logger = {
  warn() {
    // Discarded: the adapter logs nothing unless the host supplies a logger.
  },
  error() {
    // Discarded: the adapter logs nothing unless the host supplies a logger.
  },
};

/** Writes value-free diagnostics to the host's logger, ignoring any error the logger throws. */
export class Diagnostics {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  warn(code: DiagnosticCode, fields: DiagnosticFields): void {
    try {
      this.#logger.warn(formatDiagnostic(code, fields));
    } catch {
      // Nowhere is left to report a logger that fails.
    }
  }

  error(code: DiagnosticCode, fields: DiagnosticFields): void {
    try {
      this.#logger.error(formatDiagnostic(code, fields));
    } catch {
      // Nowhere is left to report a logger that fails.
    }
  }
}
