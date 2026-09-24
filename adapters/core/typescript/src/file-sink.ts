import { type FileHandle, open } from 'node:fs/promises';

import { encodeRecord } from './codec.js';
import { errorName } from './errors.js';
import { type AudrRecord } from './record.js';
import { BatchResult, type Sink } from './sink.js';

export interface FileSinkOptions {
  /** Append to an existing file (default) or truncate it on first write. */
  readonly append?: boolean | undefined;
}

/**
 * A `Sink` that writes records as JSON Lines to a file.
 *
 * The file is opened on the first delivery and closed by `close()`, once every delivery
 * requested before it has been written. Batches are written one at a time, each with a
 * single call, even when `deliver()` is called concurrently; a failed write reports the
 * batch `retryable_failure`. Consumers of the file should de-duplicate on
 * `record_id`, which makes replays from `onFailure` safe.
 */
export class FileSink implements Sink {
  readonly #path: string | URL;
  readonly #flags: 'a' | 'w';
  #file: FileHandle | undefined;
  #closing: Promise<void> | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(path: string | URL, options: FileSinkOptions = {}) {
    this.#path = path;
    this.#flags = options.append === false ? 'w' : 'a';
  }

  deliver(batch: readonly AudrRecord[]): Promise<BatchResult> {
    if (this.#closing !== undefined) return Promise.resolve(BatchResult.closed());
    const written = this.#writes.then(() => this.#write(batch));
    this.#writes = written.catch(() => undefined);
    return written;
  }

  /** Refuse new deliveries, finish the ones already requested, then close the file. */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #write(batch: readonly AudrRecord[]): Promise<BatchResult> {
    const lines = batch.map((record) => `${encodeRecord(record)}\n`).join('');
    try {
      this.#file ??= await open(this.#path, this.#flags);
      await this.#file.appendFile(lines, 'utf8');
    } catch (error) {
      return BatchResult.failed({ retryable: true, detail: errorCode(error) });
    }
    return BatchResult.accepted();
  }

  async #close(): Promise<void> {
    await this.#writes;
    try {
      await this.#file?.close();
    } catch {
      // Closing is best-effort and never throws.
    }
  }
}

/** A Node system error code such as `ENOENT`; never the message, which names the path. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : errorName(error);
}
