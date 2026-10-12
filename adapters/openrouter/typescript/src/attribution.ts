import { AsyncLocalStorage } from 'node:async_hooks';

import type { Attribution } from '@openaudr/audr';

/** What `withAudr` applies: the billing identity and, optionally, the host's own run. */
export interface AudrContext {
  readonly attribution?: Attribution | undefined;
  readonly run?: RunContext | undefined;
}

/** A run the host already has, so that every call in the scope joins it. */
export interface RunContext {
  /** 8 to 64 characters, or the `Client` rejects the record. */
  readonly run_id: string;
  /** The host's span that the scope's calls belong to. */
  readonly parent_span_id?: string | undefined;
  /** A display name for the run. */
  readonly name?: string | undefined;
}

/** The attribution and run in effect where a call starts. */
export interface Scope {
  readonly attribution: Attribution;
  readonly run: RunContext | undefined;
}

const EMPTY: Scope = { attribution: {}, run: undefined };

/**
 * One store for the whole process. Under Node 22 every `AsyncLocalStorage` that has ever run
 * slows every async operation, so the adapter never creates a second one.
 */
const scopes = new AsyncLocalStorage<Scope>();

/**
 * Run `body` with `context` applied to every OpenRouter call an instrumented client starts
 * inside it, including calls in promises `body` creates. Scopes nest: inner fields replace
 * outer ones and `labels` merge by key. Returns exactly what `body` returns.
 *
 * ```ts
 * await withAudr({ attribution: { account_id: 'acct_42' } }, () =>
 *   openrouter.chat.send({
 *     chatRequest: { model: 'openai/gpt-5.4', messages: [{ role: 'user', content: 'Hi' }] },
 *   }),
 * );
 * ```
 *
 * Only an exception from `body` propagates: a context that cannot be read is ignored and
 * `body` runs under the outer scope.
 */
export function withAudr<T>(context: AudrContext, body: () => T): T {
  return scopes.run(nest(currentScope(), context), body);
}

/** The scope in effect in the current async context. */
export function currentScope(): Scope {
  return scopes.getStore() ?? EMPTY;
}

/**
 * `override` over `base`, field by field, with `labels` merged by key. Only AUDR's
 * attribution fields are copied, so nothing else a host passes can reach a record.
 */
export function mergeAttribution(
  base: Attribution,
  override: Attribution | undefined,
): Attribution {
  const labels = { ...base.labels, ...override?.labels };
  return {
    environment: override?.environment ?? base.environment,
    account_id: override?.account_id ?? base.account_id,
    subscription_id: override?.subscription_id ?? base.subscription_id,
    user_id: override?.user_id ?? base.user_id,
    labels: Object.keys(labels).length > 0 ? labels : undefined,
  };
}

function nest(outer: Scope, context: AudrContext): Scope {
  try {
    return {
      attribution: mergeAttribution(outer.attribution, context.attribution),
      run: nestRun(outer.run, context.run),
    };
  } catch {
    return outer;
  }
}

/**
 * A run with the outer run's id keeps the outer `parent_span_id` and `name` unless it sets
 * its own; a run with another id replaces the outer run entirely.
 */
function nestRun(
  outer: RunContext | undefined,
  run: RunContext | undefined,
): RunContext | undefined {
  if (run === undefined) return outer;
  const same = outer?.run_id === run.run_id ? outer : undefined;
  return {
    run_id: run.run_id,
    parent_span_id: run.parent_span_id ?? same?.parent_span_id,
    name: run.name ?? same?.name,
  };
}
