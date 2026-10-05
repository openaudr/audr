import type { IncompleteReason } from './diagnostics.js';

/** What the adapter does with a streamed frame. */
export type Verdict =
  /** Not a terminal frame; nothing to do. */
  | 'continue'
  /** The frame carried the usage and has been recorded. The stream needs no more attention. */
  | 'recorded'
  /** A terminal frame without usage: nothing can be recorded. */
  | 'no_usage'
  /** A frame that reports a failure; the stream may still end with usage. */
  | 'error';

/** An OpenRouter `EventStream`: an async-iterable `ReadableStream`. */
export type NativeStream = AsyncIterable<unknown> & {
  readonly cancel?: ((reason?: unknown) => Promise<void>) | undefined;
};

export function isStream(value: unknown): value is NativeStream {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * A proxy over `target` that answers `overrides` itself and forwards everything else, with
 * methods bound to `target` so that they run exactly as on the native object.
 */
export function forward<T extends object>(
  target: T,
  overrides: Readonly<Record<PropertyKey, unknown>>,
): T {
  return new Proxy(target, {
    get(object, key): unknown {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === 'function' ? (value as () => unknown).bind(object) : value;
    },
  });
}

/**
 * The native stream behind a proxy that offers every frame to `inspect` before yielding it
 * unchanged. A stream that ends before `inspect` records it is reported once through
 * `incomplete`, with the `IncompleteReason` it ended for.
 *
 * `inspect` runs to completion before the frame is yielded, so a record is submitted before
 * the caller sees the frame that completes the stream. `inspect` must not throw: an exception
 * would end the caller's stream.
 */
export function meterStream(
  stream: NativeStream,
  inspect: (frame: unknown) => Promise<Verdict>,
  incomplete: (reason: IncompleteReason) => void,
): NativeStream {
  let open = true;
  const end = (reason: IncompleteReason): void => {
    if (!open) return;
    open = false;
    incomplete(reason);
  };
  async function* iterate(): AsyncGenerator<unknown, void, undefined> {
    let failure = false;
    try {
      for await (const frame of stream) {
        if (open) {
          const verdict = await inspect(frame);
          if (verdict === 'recorded') open = false;
          else if (verdict === 'no_usage') end('no_usage');
          else if (verdict === 'error') failure = true;
        }
        yield frame;
      }
      end(failure ? 'error_frame' : 'ended');
    } catch (error) {
      end('failed');
      throw error;
    } finally {
      end('abandoned');
    }
  }
  const overrides: Record<PropertyKey, unknown> = { [Symbol.asyncIterator]: iterate };
  if (typeof stream.cancel === 'function') {
    const cancel = stream.cancel.bind(stream);
    overrides.cancel = (reason?: unknown): Promise<void> => {
      end('closed');
      return cancel(reason);
    };
  }
  return forward(stream, overrides);
}
