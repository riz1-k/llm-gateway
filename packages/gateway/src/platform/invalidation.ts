import type { Redis } from 'ioredis';
import type { Logger } from '../observability/logger.js';

/** Cache invalidation messages broadcast to every gateway replica. */
export type InvalidationMessage =
  | { type: 'key'; hash: string }
  | { type: 'team'; slug: string }
  | { type: 'budgets'; slug: string }
  | { type: 'all' };

type Handler = (msg: InvalidationMessage) => void;

/**
 * Redis pub/sub channel `sy:invalidate`. Publishing is done by whoever mutates state (admin API,
 * CLI); every process holding caches subscribes. Delivery is best-effort, which is why every cache
 * entry also has a TTL.
 */
export class InvalidationBus {
  private readonly handlers = new Set<Handler>();
  private subscribed = false;

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis | undefined,
    readonly channel: string,
    private readonly logger: Logger,
  ) {}

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<void> {
    if (!this.subscriber || this.subscribed) return;
    this.subscribed = true;
    this.subscriber.on('message', (channel: string, payload: string) => {
      if (channel !== this.channel) return;
      let msg: InvalidationMessage;
      try {
        msg = JSON.parse(payload) as InvalidationMessage;
      } catch {
        return;
      }
      this.dispatch(msg);
    });
    // On reconnect, everything published while disconnected was missed.
    this.subscriber.on('ready', () => this.dispatch({ type: 'all' }));
    await this.subscriber.subscribe(this.channel);
  }

  /** Applies locally first (same-process caches are never stale), then broadcasts. */
  async publish(msg: InvalidationMessage): Promise<void> {
    this.dispatch(msg);
    try {
      await this.publisher.publish(this.channel, JSON.stringify(msg));
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'invalidation publish failed');
    }
  }

  private dispatch(msg: InvalidationMessage): void {
    for (const h of this.handlers) {
      try {
        h(msg);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'invalidation handler failed');
      }
    }
  }
}
