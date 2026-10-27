import type { Logger } from '../../observability/logger.js';
import { parseSSE } from '../../util/sse.js';
import type { FetchLike } from '../http.js';

/**
 * Shared subscription to opencode's `GET /event` SSE stream, demultiplexed by sessionID.
 *
 * One connection serves all concurrent requests of a provider. It is opened lazily on the first
 * subscription (resolving once `server.connected` arrives, so no events of a session created
 * afterwards are missed), kept open while subscribers exist, and closed after an idle period. If
 * the connection drops, every subscriber is notified via `onLost` and falls back to the
 * authoritative final message response.
 *
 * Relevant event shapes (opencode 1.18, verified live; see docs/opencode-bridge.md):
 *   message.updated       {sessionID, info: {id, role, tokens, error?, finish?}}
 *   message.part.updated  {sessionID, part: {id, messageID, type: 'text'|'reasoning'|'step-start'|…, text?}}
 *   message.part.delta    {sessionID, messageID, partID, field: 'text', delta}
 *   session.error         {sessionID, error}
 *   session.idle          {sessionID}
 */

export interface OpencodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface EventSubscriber {
  onEvent(ev: OpencodeEvent): void;
  onLost(err: Error): void;
}

export class OpencodeEventHub {
  private connection: { controller: AbortController; ready: Promise<void> } | undefined;
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchImpl: FetchLike,
    private readonly logger: Logger,
    private readonly opts: { connectTimeoutMs?: number; idleCloseMs?: number } = {},
  ) {}

  /** Subscribes to one session's events; resolves once the stream is connected. */
  async subscribe(sessionId: string, sub: EventSubscriber): Promise<() => void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(sub);
    try {
      await this.ensureConnected();
    } catch (err) {
      this.unsubscribe(sessionId, sub);
      throw err;
    }
    return () => this.unsubscribe(sessionId, sub);
  }

  get subscriberCount(): number {
    let n = 0;
    for (const s of this.subscribers.values()) n += s.size;
    return n;
  }

  private unsubscribe(sessionId: string, sub: EventSubscriber): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.subscribers.delete(sessionId);
    if (this.subscribers.size === 0 && this.connection && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = undefined;
        if (this.subscribers.size === 0) this.disconnect();
      }, this.opts.idleCloseMs ?? 30_000);
      this.idleTimer.unref?.();
    }
  }

  private ensureConnected(): Promise<void> {
    if (this.connection) return this.connection.ready;
    const controller = new AbortController();
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    const connection = { controller, ready };
    this.connection = connection;
    const timeout = setTimeout(() => {
      rejectReady(new Error('timed out connecting to opencode /event'));
      controller.abort();
    }, this.opts.connectTimeoutMs ?? 5000);
    timeout.unref?.();

    void (async () => {
      let connected = false;
      try {
        const res = await this.fetchImpl(this.url, {
          headers: { ...this.headers, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`opencode /event responded ${res.status}`);
        for await (const sse of parseSSE(res.body, controller.signal)) {
          let ev: OpencodeEvent;
          try {
            ev = JSON.parse(sse.data) as OpencodeEvent;
          } catch {
            continue;
          }
          if (!connected) {
            // `server.connected` is the first event; any event proves the stream is live.
            connected = true;
            clearTimeout(timeout);
            resolveReady();
          }
          this.dispatch(ev);
        }
        throw new Error('opencode /event stream ended');
      } catch (err) {
        clearTimeout(timeout);
        const error = err instanceof Error ? err : new Error(String(err));
        if (!connected) rejectReady(error);
        if (this.connection === connection) this.connection = undefined;
        if (!controller.signal.aborted) {
          this.logger.warn({ err: error.message }, 'opencode event stream lost');
          for (const set of this.subscribers.values()) for (const s of set) s.onLost(error);
        }
      }
    })();
    return ready;
  }

  private dispatch(ev: OpencodeEvent): void {
    const props = ev.properties ?? {};
    const sessionId =
      typeof props.sessionID === 'string'
        ? props.sessionID
        : typeof (props.part as { sessionID?: unknown } | undefined)?.sessionID === 'string'
          ? (props.part as { sessionID: string }).sessionID
          : undefined;
    if (!sessionId) return;
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    for (const s of set) {
      try {
        s.onEvent(ev);
      } catch (err) {
        this.logger.error({ err }, 'opencode event subscriber threw');
      }
    }
  }

  private disconnect(): void {
    const c = this.connection;
    this.connection = undefined;
    c?.controller.abort();
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.disconnect();
  }
}
