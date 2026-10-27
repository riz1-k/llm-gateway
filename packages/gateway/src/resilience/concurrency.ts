import { ProviderError } from '../core/errors.js';
import { abortReason } from '../util/abort.js';

type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  signal: AbortSignal | undefined;
}

/**
 * FIFO counting semaphore with queue timeout and abort support. `max = 0` means unlimited.
 * Timing out in the queue throws a retryable `upstream_busy` ProviderError.
 */
export class Semaphore {
  private inflight = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly name: string,
    readonly max: number,
  ) {}

  get stats(): { inflight: number; queued: number; max: number } {
    return { inflight: this.inflight, queued: this.queue.length, max: this.max };
  }

  acquire(timeoutMs: number, signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.max <= 0 || this.inflight < this.max) {
      this.inflight++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          this.remove(waiter);
          reject(
            new ProviderError({
              status: 503,
              code: 'upstream_busy',
              message: `${this.name}: no concurrency slot within ${timeoutMs} ms (max ${this.max})`,
              provider: this.name,
              retryable: true,
              countsAsFailure: false,
            }),
          );
        }, timeoutMs),
        onAbort: () => {
          this.remove(waiter);
          reject(abortReason(signal!));
        },
      };
      waiter.timer.unref?.();
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private remove(w: Waiter): void {
    const i = this.queue.indexOf(w);
    if (i !== -1) this.queue.splice(i, 1);
    clearTimeout(w.timer);
    w.signal?.removeEventListener('abort', w.onAbort);
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve(this.makeRelease()); // slot handed over; inflight unchanged
      } else {
        this.inflight--;
      }
    };
  }
}

/** One semaphore per provider, created lazily from provider config. */
export class ConcurrencyManager {
  private readonly semaphores = new Map<string, Semaphore>();

  get(provider: string, max: number): Semaphore {
    let s = this.semaphores.get(provider);
    if (!s || s.max !== max) {
      // A changed limit (hot reload) gets a fresh semaphore; in-flight holders release the old one.
      s = new Semaphore(provider, max);
      this.semaphores.set(provider, s);
    }
    return s;
  }

  stats(): Record<string, { inflight: number; queued: number; max: number }> {
    return Object.fromEntries([...this.semaphores.entries()].map(([k, s]) => [k, s.stats]));
  }
}
