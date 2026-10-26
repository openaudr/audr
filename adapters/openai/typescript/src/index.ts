/**
 * Meter OpenAI SDK chat completions, responses and embeddings, from OpenAI or any
 * OpenAI-compatible endpoint, as AUDR (Agent Usage Detail Record) records.
 */

export { type AudrContext, type RunContext, withAudr } from './attribution.js';
export type { DiagnosticCode } from './diagnostics.js';
export { RESPONSE_FAILED_CODE, RESPONSE_INCOMPLETE_CODE } from './mapping.js';
export {
  type Creates,
  instrumentOpenAI,
  type InstrumentOpenAIOptions,
  type OpenAILike,
  type ResourceMapping,
  type ResourceSource,
} from './openai.js';
export { VERSION } from './version.js';
