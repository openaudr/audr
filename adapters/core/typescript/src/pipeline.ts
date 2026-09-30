import { errorName } from './errors.js';
import { type AudrRecord } from './record.js';
import {
  type DeliveredCallback,
  type DeliveryStats,
  type Disposition,
  type FailureCallback,
  type FailureReason,
  type Logger,
  type SubmitResult,
} from './results.js';
import { type BatchResult, type Sink } from './sink.js';
import { isObject } from './validate.js';

/** The longest delay `setTimeout` honours; a longer one fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface PipelineOptions {
  readonly maxQueueSize: number;
  readonly batchMaxSize: number;
  readonly lingerMs: number;
  readonly ownsSink: boolean;
  readonly logger: Logger;
  readonly onFailure: FailureCallback | undefined;
  readonly onDelivered: DeliveredCallback | undefined;
}

/** A record taken off the queue. Its state leaves `in_flight` exactly once. */
interface InFlight {
  readonly record: AudrRecord;
  state: 'in_flight' | 'sent' | Disposition;
}

/**
 * Queue single records and deliver them to the sink in bounded micro-batches.
 *
 * A batch goes out when it is full, when `lingerMs` has passed since the queue became
 * non-empty, or at once while a flush or shutdown is draining. One batch is in flight at a
 * time. Every submitted record ends in exactly one of `sent`, `dropped` or `unknown`.
 */
export class Pipeline {
  readonly #sink: Sink;
  readonly #options: PipelineOptions;
  #queue: AudrRecord[] = [];
  readonly #inFlight = new Set<InFlight>();
  #delivering = false;
  #lingerTimer: ReturnType<typeof setTimeout> | undefined;
  #drainers = 0;
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #idleWaiters: (() => void)[] = [];
  readonly #abort = new AbortController();
  /** Promises returned by callbacks that have not settled yet; each resolves, never rejects. */
  readonly #callbacks = new Set<Promise<void>>();
  #submitted = 0;
  #sent = 0;
  #dropped = 0;
  #unknown = 0;
  #batches = 0;

  constructor(sink: Sink, options: PipelineOptions) {
    this.#sink = sink;
    this.#options = options;
  }

  get stats(): DeliveryStats {
    return {
      submitted: this.#submitted,
      sent: this.#sent,
      dropped: this.#dropped,
      unknown: this.#unknown,
      batches: this.#batches,
      queueDepth: this.#depth(),
      queueCapacity: this.#options.maxQueueSize,
    };
  }

  /** Queue one record and return immediately; delivery happens in the background. */
  submit(record: AudrRecord): SubmitResult {
    this.#submitted += 1;
    const depth = this.#depth();
    if (depth >= this.#options.maxQueueSize) {
      this.#dropped += 1;
      this.#options.logger.warn(`audr: record dropped, queue full (depth=${depth})`);
      this.#notifyFailure(record, 'dropped', 'queue_full', true);
      return { outcome: 'dropped_queue_full', queued: false, issues: [] };
    }
    this.#queue.push(record);
    this.#schedule();
    return { outcome: 'queued', queued: true, issues: [] };
  }

  /**
   * Deliver queued work now. Resolves `true` once idle, `false` if `timeoutMs` passes first.
   * Once stopping, it waits for `stop()` to finish instead.
   */
  async flush(timeoutMs: number): Promise<boolean> {
    return this.#stopping === undefined
      ? this.#drain(timeoutMs)
      : settlesWithin(this.#stopping, timeoutMs);
  }

  /** Report a record `Client.record()` rejected as invalid to `onFailure`. */
  reportInvalid(record: AudrRecord): void {
    this.#notifyFailure(record, 'dropped', 'invalid', false);
  }

  /**
   * Deliver what fits in `timeoutMs`, abort and account for the rest, then wait for pending
   * callbacks and close an owned sink, both within the same bound. Idempotent.
   */
  stop(timeoutMs: number): Promise<void> {
    this.#stopping ??= this.#stop(timeoutMs);
    return this.#stopping;
  }

  async #stop(timeoutMs: number): Promise<void> {
    this.#stopped = true;
    const deadline = Date.now() + timeoutMs;
    try {
      await this.#drain(timeoutMs);
    } finally {
      clearTimeout(this.#lingerTimer);
      this.#abort.abort();
      this.#abandonOutstanding();
      await this.#settleCallbacks(Math.max(0, deadline - Date.now()));
      if (this.#options.ownsSink) {
        const closed = Promise.resolve()
          .then(() => this.#sink.close())
          .catch((error: unknown) => {
            this.#options.logger.error(`audr: sink close failed (${errorName(error)})`);
          });
        if (!(await settlesWithin(closed, Math.max(0, deadline - Date.now())))) {
          this.#options.logger.warn('audr: sink close did not settle within the shutdown bound');
        }
      }
    }
  }

  #depth(): number {
    return this.#queue.length + this.#inFlight.size;
  }

  #batchDue(): boolean {
    return this.#queue.length >= this.#options.batchMaxSize || this.#drainers > 0 || this.#stopped;
  }

  /** Start delivering if a batch is due; otherwise make sure the linger timer is running. */
  #schedule(): void {
    if (this.#delivering || this.#queue.length === 0) return;
    if (this.#batchDue()) {
      void this.#run();
      return;
    }
    // Deliberately not unref'd: a pending batch keeps the process alive until it is sent.
    this.#lingerTimer ??= setTimeout(() => {
      this.#lingerTimer = undefined;
      void this.#run();
    }, this.#options.lingerMs);
  }

  async #run(): Promise<void> {
    if (this.#delivering) return;
    this.#delivering = true;
    clearTimeout(this.#lingerTimer);
    this.#lingerTimer = undefined;
    try {
      let batch = this.#queue.splice(0, this.#options.batchMaxSize);
      while (batch.length > 0) {
        await this.#deliver(batch);
        batch = this.#batchDue() ? this.#queue.splice(0, this.#options.batchMaxSize) : [];
      }
    } finally {
      this.#delivering = false;
      if (this.#queue.length > 0) {
        this.#schedule();
      } else {
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
      }
    }
  }

  /** Hand one batch to the sink and account for every record in it. Never throws. */
  async #deliver(records: AudrRecord[]): Promise<void> {
    const batch = records.map((record): InFlight => ({ record, state: 'in_flight' }));
    for (const item of batch) this.#inFlight.add(item);
    let thrown: string | undefined;
    try {
      const result = await this.#sink.deliver(records, { signal: this.#abort.signal });
      if (isObject(result) && batch.some((item) => item.state === 'in_flight')) {
        this.#batches += 1;
        this.#apply(batch, result);
      }
    } catch (error) {
      thrown = errorName(error);
    } finally {
      const unresolved = batch.filter((item) => this.#fail(item, 'unknown', 'inconclusive', true));
      for (const item of batch) this.#inFlight.delete(item);
      if (unresolved.length > 0) {
        const cause = thrown === undefined ? 'returned no valid result' : `threw ${thrown}`;
        this.#options.logger.error(
          `audr: ${unresolved.length} record(s) unknown, the sink ${cause}`,
        );
      }
    }
  }

  #apply(batch: readonly InFlight[], result: BatchResult): void {
    const { logger } = this.#options;
    switch (result.outcome) {
      case 'accepted': {
        const rejected = new Map(result.rejected?.map((entry) => [entry.recordId, entry.detail]));
        const unknown = new Set(result.unknown);
        for (const item of batch) {
          const id = item.record.record_id;
          if (rejected.has(id)) this.#fail(item, 'dropped', 'rejected', false, rejected.get(id));
          else if (unknown.has(id)) this.#fail(item, 'unknown', 'inconclusive', true);
          else this.#markSent(item);
        }
        this.#notifyDelivered(batch);
        return;
      }
      case 'retryable_failure':
      case 'permanent_failure': {
        const retryable = result.outcome === 'retryable_failure';
        logger.warn(`audr: batch dropped after ${result.outcome} (size=${batch.length})`);
        for (const item of batch) {
          this.#fail(item, 'dropped', 'sink_failure', retryable, result.detail);
        }
        return;
      }
      case 'closed':
        logger.error(`audr: batch dropped, the sink is closed (size=${batch.length})`);
        for (const item of batch) this.#fail(item, 'dropped', 'sink_closed', true);
        return;
      default: {
        // Unreachable for a typed sink. Records left in flight are accounted `unknown`.
        const unexpected: never = result;
        return unexpected;
      }
    }
  }

  async #drain(timeoutMs: number): Promise<boolean> {
    this.#drainers += 1;
    this.#schedule();
    try {
      const idle = new Promise<void>((resolve) => {
        if (!this.#delivering && this.#queue.length === 0) {
          resolve();
        } else {
          this.#idleWaiters.push(resolve);
        }
      });
      return await settlesWithin(idle, timeoutMs);
    } finally {
      this.#drainers -= 1;
    }
  }

  async #settleCallbacks(timeoutMs: number): Promise<void> {
    if (this.#callbacks.size === 0) return;
    if (!(await settlesWithin(Promise.all(this.#callbacks), timeoutMs))) {
      this.#options.logger.warn(
        `audr: shutdown left ${this.#callbacks.size} callback(s) unsettled`,
      );
    }
  }

  #abandonOutstanding(): void {
    const queued = this.#queue;
    this.#queue = [];
    for (const record of queued) {
      this.#dropped += 1;
      this.#notifyFailure(record, 'dropped', 'shutdown', true);
    }
    const unknown = [...this.#inFlight].filter((item) =>
      this.#fail(item, 'unknown', 'shutdown', true),
    );
    if (queued.length > 0 || unknown.length > 0) {
      this.#options.logger.warn(
        `audr: shutdown left ${queued.length} record(s) dropped and ${unknown.length} unknown`,
      );
    }
  }

  #markSent(item: InFlight): void {
    if (item.state !== 'in_flight') return;
    item.state = 'sent';
    this.#sent += 1;
  }

  /** Move `item` to `disposition`; `false` if it had already reached a terminal state. */
  #fail(
    item: InFlight,
    disposition: Disposition,
    reason: FailureReason,
    retryable: boolean,
    detail?: string,
  ): boolean {
    if (item.state !== 'in_flight') return false;
    item.state = disposition;
    if (disposition === 'dropped') this.#dropped += 1;
    else this.#unknown += 1;
    this.#notifyFailure(item.record, disposition, reason, retryable, detail);
    return true;
  }

  #notifyFailure(
    record: AudrRecord,
    disposition: Disposition,
    reason: FailureReason,
    retryable: boolean,
    detail?: string,
  ): void {
    const { onFailure } = this.#options;
    if (onFailure === undefined) return;
    this.#invoke('onFailure', () => onFailure({ record, disposition, reason, retryable, detail }));
  }

  #notifyDelivered(batch: readonly InFlight[]): void {
    const { onDelivered } = this.#options;
    const sent = batch.filter((item) => item.state === 'sent').map((item) => item.record);
    if (onDelivered === undefined || sent.length === 0) return;
    this.#invoke('onDelivered', () => onDelivered(sent));
  }

  /** Run a callback without awaiting it, logging whatever it throws or rejects with. */
  #invoke(name: 'onFailure' | 'onDelivered', callback: () => unknown): void {
    const report = (error: unknown): void => {
      this.#options.logger.warn(`audr: ${name} callback threw (${errorName(error)})`);
    };
    try {
      const result = callback();
      if (!isThenable(result)) return;
      const pending: Promise<void> = Promise.resolve(result)
        .then(() => undefined, report)
        .finally(() => {
          this.#callbacks.delete(pending);
        });
      this.#callbacks.add(pending);
    } catch (error) {
      report(error);
    }
  }
}

/**
 * Whether `work` settles within `timeoutMs`. A bound too long for a timer is no bound at
 * all. The timer keeps the process alive, so a caller awaiting a hung sink still reaches
 * the bound.
 */
async function settlesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    if (timeoutMs > MAX_TIMER_MS) return;
    timer = setTimeout(resolve, timeoutMs, false);
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}
