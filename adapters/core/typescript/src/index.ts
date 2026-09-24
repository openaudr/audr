/** Build, validate and deliver AUDR (Agent Usage Detail Record) usage records. */

export { Client, type ClientOptions } from './client.js';
export { decodeRecord, encodeRecord, parseRecord } from './codec.js';
export {
  AudrError,
  ConfigurationError,
  type ErrorCode,
  ValidationError,
  type ValidationIssue,
} from './errors.js';
export {
  type Attribution,
  type AudrRecord,
  type Cost,
  createRecord,
  type Emitter,
  type EmitterComponent,
  type Environment,
  type LlmCost,
  type LlmUsage,
  type Modality,
  type Operation,
  type RecordInput,
  type Resource,
  type ResourceType,
  type Run,
  type RunOutcome,
  type RunType,
  type Timing,
  type ToolCost,
  type ToolUsage,
  type Usage,
} from './record.js';
export { type ExtensionKey, SPEC_VERSION } from './schema.js';
export type {
  DeliveredCallback,
  DeliveryStats,
  Disposition,
  FailedRecord,
  FailureCallback,
  FailureReason,
  Logger,
  SubmitOutcome,
  SubmitResult,
} from './results.js';
export { type BatchOutcome, BatchResult, type RejectedRecord, type Sink } from './sink.js';
export { uuidv7 } from './uuid.js';
export { validate, type ValidateOptions } from './validate.js';
export { VERSION } from './version.js';
