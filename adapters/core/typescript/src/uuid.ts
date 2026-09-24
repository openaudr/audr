import { v7 } from 'uuid';

/**
 * A random UUIDv7 (RFC 9562): a 48-bit Unix-millisecond timestamp followed by random bits,
 * so identifiers sort by creation time. AUDR uses it for `record_id`; adapters may use it
 * for `run.run_id`.
 */
export function uuidv7(now: number = Date.now()): string {
  return v7({ msecs: now });
}
