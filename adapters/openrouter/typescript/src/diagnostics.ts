import type { Logger, SubmitResult } from '@openaudr/audr';

/** Every diagnostic the adapter logs. */
export type DiagnosticCode =
  | 'ATTRIBUTION_UNRESOLVED'
  | 'PROVIDER_UNRESOLVED'
  | 'LOOKUP_FAILED'
  | 'BYOK_COST_INCOMPLETE'
  | 'MODEL_UNREPORTED'
  | 'USAGE_UNREPORTED'
  | 'STREAM_INCOMPLETE'
  | 'RECORD_NOT_QUEUED'
  | 'HOOK_FAILED';

/** The metered methods, the only operation names a diagnostic carries. */
export type OperationName = 'chat.send' | 'responses.send' | 'embeddings.generate';

/** Why a stream produced no record. */
export type IncompleteReason =
  'error_frame' | 'no_usage' | 'ended' | 'failed' | 'abandoned' | 'closed';

/**
 * Why a generation lookup produced nothing: it was turned off, the result had no id that
 * `getGeneration` accepts, the request failed for good, or the time budget ran out.
 */
export type LookupFailureReason = 'disabled' | 'no_id' | 'rejected' | 'exhausted';

/** The only keys a diagnostic carries. None of them can hold a record value or an error message. */
export interface DiagnosticFields {
  readonly operation: OperationName;
  readonly outcome?: string | undefined;
  readonly reason?: IncompleteReason | LookupFailureReason | undefined;
  /** `<code>@<json-pointer>` for each validation issue. */
  readonly issues?: string | undefined;
  /** A category from `errorKind`. */
  readonly error?: string | undefined;
}

const PREFIX = '@openaudr/audr-adapter-openrouter';
const FIELD_ORDER = ['outcome', 'operation', 'reason', 'issues', 'error'] as const;
const ERROR_TYPES = [TypeError, RangeError, SyntaxError, ReferenceError] as const;

/** `@openaudr/audr-adapter-openrouter: <CODE> (<key>=<value>, ...)`. */
export function formatDiagnostic(code: DiagnosticCode, fields: DiagnosticFields): string {
  const parts: string[] = [];
  for (const key of FIELD_ORDER) {
    const value = fields[key];
    if (value !== undefined) parts.push(`${key}=${value}`);
  }
  return `${PREFIX}: ${code} (${parts.join(', ')})`;
}

/**
 * A fixed error category. Never `error.name` or `error.message`: both are writable and may
 * carry prompt or record values.
 */
export function errorKind(error: unknown): string {
  try {
    const type = ERROR_TYPES.find((candidate) => error instanceof candidate);
    if (type !== undefined) return type.name;
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
    this.#write('warn', code, fields);
  }

  error(code: DiagnosticCode, fields: DiagnosticFields): void {
    this.#write('error', code, fields);
  }

  #write(level: 'warn' | 'error', code: DiagnosticCode, fields: DiagnosticFields): void {
    try {
      this.#logger[level](formatDiagnostic(code, fields));
    } catch {
      // Nowhere is left to report a logger that fails.
    }
  }
}
