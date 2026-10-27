import type { Redis } from 'ioredis';
import type { UsageEvent, UsageSink } from '../core/services.js';
import type { Logger } from '../observability/logger.js';
import { noopMetrics, type GatewayMetrics } from '../observability/metrics.js';

export interface StreamSinkOptions {
  redis: Redis;
  /** Full stream key, e.g. `sy:usage`. */
  stream: string;
  maxLen: number;
  /** Events held in memory while Redis is unavailable (oldest dropped beyond this). */
  bufferMax: number;
  logger: Logger;
  metrics?: GatewayMetrics;
  /** Max events per XADD pipeline. */
  batchSize?: number;
}

/** Field name of the JSON payload in each stream entry. */
export const USAGE_FIELD = 'e';

/**
 * Usage events → Redis Stream (SPEC §10). `emit()` never blocks or throws: events are queued in
 * memory and written with pipelined `XADD … MAXLEN ~ n` on the next tick. While Redis is
 * unavailable the queue keeps up to `bufferMax` events (oldest dropped, counted in
 * `sy_usage_events_dropped_total`) and retries with backoff. `flush()`/`close()` drain the queue.
 */
export class RedisStreamUsageSink implements UsageSink {
  private readonly queue: UsageEvent[] = [];
  private readonly metrics: GatewayMetrics;
  private scheduled = false;
  private flushing: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private backoffMs = 0;
  private closed = false;
  private dropped = 0;

  constructor(private readonly opts: StreamSinkOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
  }

  get buffered(): number {
    return this.queue.length;
  }

  get droppedTotal(): number {
    return this.dropped;
  }

  emit(event: UsageEvent): void {
    this.queue.push(event);
    if (this.queue.length > this.opts.bufferMax) {
      const n = this.queue.length - this.opts.bufferMax;
      this.queue.splice(0, n);
      this.dropped += n;
      this.metrics.usageDropped(n);
    }
    this.metrics.usageBuffered(this.queue.length);
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.retryTimer || this.closed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  /** Writes queued events until empty or a write fails. */
  private drain(): Promise<void> {
    this.flushing ??= (async () => {
      try {
        while (this.queue.length > 0) {
          const ok = await this.writeBatch();
          if (!ok) {
            this.scheduleRetry();
            return;
          }
        }
        this.backoffMs = 0;
      } finally {
        this.flushing = undefined;
        this.metrics.usageBuffered(this.queue.length);
      }
    })();
    return this.flushing;
  }

  private async writeBatch(): Promise<boolean> {
    const batch = this.queue.slice(0, this.opts.batchSize ?? 500);
    const p = this.opts.redis.pipeline();
    for (const e of batch) {
      p.xadd(
        this.opts.stream,
        'MAXLEN',
        '~',
        this.opts.maxLen,
        '*',
        USAGE_FIELD,
        JSON.stringify(e),
      );
    }
    try {
      const res = (await p.exec()) ?? [];
      // Remove only the events that were written; failed ones stay queued in order.
      let written = 0;
      while (written < batch.length && res[written] && !res[written]![0]) written++;
      this.queue.splice(0, written);
      if (written < batch.length) {
        const err = res[written]?.[0];
        this.logFailure(err ?? new Error('xadd failed'));
        return false;
      }
      return true;
    } catch (err) {
      this.logFailure(err);
      return false;
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    this.backoffMs = Math.min(10_000, this.backoffMs ? this.backoffMs * 2 : 250);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.drain();
    }, this.backoffMs);
    this.retryTimer.unref();
  }

  private lastLog = 0;
  private logFailure(err: unknown): void {
    this.metrics.platformError('usage');
    const now = Date.now();
    if (now - this.lastLog > 10_000) {
      this.lastLog = now;
      this.opts.logger.warn(
        { err: err instanceof Error ? err.message : String(err), buffered: this.queue.length },
        'usage stream write failed; buffering in memory',
      );
    }
  }

  async flush(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 && Date.now() < deadline) {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
      await this.drain();
      if (this.queue.length > 0) await new Promise((r) => setTimeout(r, 100));
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.queue.length > 0) {
      this.opts.logger.error(
        { lost: this.queue.length },
        'usage events lost at shutdown (Redis unavailable)',
      );
      this.metrics.usageDropped(this.queue.length);
    }
  }
}
