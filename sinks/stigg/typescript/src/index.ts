/**
 * The Stigg sink for AUDR: delivers usage records to Stigg's raw events endpoint, for
 * metering, entitlements and credits.
 */

export { type DimensionValue } from './event.js';
export { flattenRecord } from './flatten.js';
export { type RetryOptions } from './retry.js';
export { StiggSink, type StiggSinkOptions } from './sink.js';
export { VERSION } from './version.js';
