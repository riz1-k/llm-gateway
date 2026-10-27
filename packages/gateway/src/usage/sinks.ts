import type { Logger } from '../observability/logger.js';
import type { UsageEvent, UsageSink } from '../core/services.js';

/** Discards events. */
export class NoopUsageSink implements UsageSink {
  emit(_event: UsageEvent): void {}
}

/** Keeps the most recent N events in memory (tests, single-node debugging). */
export class MemoryUsageSink implements UsageSink {
  readonly events: UsageEvent[] = [];
  constructor(private readonly capacity = 10_000) {}
  emit(event: UsageEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity)
      this.events.splice(0, this.events.length - this.capacity);
  }
}

/**
 * Writes each usage event as a structured log line (`msg: "usage"`). Default in the core (no
 * Redis). Logs at `debug` by default: the `request completed` line at `info` already carries
 * team, route, provider, model, status, tokens, cost and cache, and a second line per request
 * roughly doubled the gateway's logging cost (see bench/RESULTS.md).
 */
export class LogUsageSink implements UsageSink {
  constructor(
    private readonly logger: Logger,
    private readonly level: 'debug' | 'info' = 'debug',
  ) {}
  emit(event: UsageEvent): void {
    this.logger[this.level]({ usage: event }, 'usage');
  }
}

/** Fan-out to several sinks; a failing sink never affects the others or the request. */
export class CompositeUsageSink implements UsageSink {
  constructor(private readonly sinks: UsageSink[]) {}
  emit(event: UsageEvent): void {
    for (const s of this.sinks) {
      try {
        s.emit(event);
      } catch {
        // swallow: usage emission must never break requests
      }
    }
  }
  async flush(): Promise<void> {
    await Promise.all(this.sinks.map(async (s) => s.flush?.()));
  }
  async close(): Promise<void> {
    await Promise.all(this.sinks.map(async (s) => s.close?.()));
  }
}
