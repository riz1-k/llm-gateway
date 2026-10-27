/** Abort reason used when a per-attempt or route deadline fires (distinguishable from client aborts). */
export class DeadlineExceededError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, what = 'upstream attempt') {
    super(`${what} timed out after ${timeoutMs} ms`);
    this.name = 'DeadlineExceededError';
    this.timeoutMs = timeoutMs;
  }
}

/** Abort reason used when the client disconnects. */
export class ClientAbortError extends Error {
  constructor(message = 'client closed the connection') {
    super(message);
    this.name = 'ClientAbortError';
  }
}

export interface ScopedSignal {
  signal: AbortSignal;
  /** True when this scope's own timer fired (not the parent). */
  timedOut(): boolean;
  /** Abort the scope manually. */
  abort(reason?: unknown): void;
  /** Clear the timer and detach from the parent. Always call when done. */
  dispose(): void;
}

/** Child signal that aborts when the parent aborts or after `timeoutMs`. */
export function scopedSignal(
  parent: AbortSignal | undefined,
  timeoutMs?: number,
  what?: string,
): ScopedSignal {
  const controller = new AbortController();
  let fired = false;
  let timer: NodeJS.Timeout | undefined;
  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && !controller.signal.aborted) {
    timer = setTimeout(
      () => {
        fired = true;
        controller.abort(new DeadlineExceededError(timeoutMs, what));
      },
      Math.max(0, timeoutMs),
    );
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    timedOut: () => fired,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** Promise-based sleep that rejects with the signal's reason when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r;
  return new ClientAbortError(typeof r === 'string' ? r : undefined);
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof DeadlineExceededError ||
    err instanceof ClientAbortError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  );
}
