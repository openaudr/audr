/** Meter OpenRouter chat, responses and embeddings as AUDR (Agent Usage Detail Record) records. */

export { type AudrContext, type RunContext, withAudr } from './attribution.js';
export type { DiagnosticCode } from './diagnostics.js';
export type { LookupOptions } from './lookup.js';
export { RESPONSE_FAILED_CODE, RESPONSE_INCOMPLETE_CODE } from './mapping.js';
export {
  instrumentOpenRouter,
  type InstrumentOpenRouterOptions,
  type OpenRouterLike,
  type ResourceMapping,
  type ResourceSource,
} from './openrouter.js';
export { VERSION } from './version.js';
