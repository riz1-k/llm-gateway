/**
 * In-memory fake of the opencode server API subset used by the adapter (no network): sessions,
 * synchronous message endpoint, abort, delete, health and the `/event` SSE feed with the event
 * shapes observed on opencode 1.18 (see docs/opencode-bridge.md).
 */

export interface FakeReply {
  text?: string;
  reasoning?: string;
  /** Text deltas emitted on /event before the reply resolves (default: text split in 3). */
  deltas?: string[];
  error?: { name: string; data?: Record<string, unknown> };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  delayMs?: number;
  httpStatus?: number;
}

export class FakeOpencode {
  readonly base = 'http://opencode.test';
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  readonly aborted: string[] = [];
  readonly prompts: { sessionId: string; body: Record<string, unknown> }[] = [];
  readonly authHeaders: (string | null)[] = [];
  replies: FakeReply[] = [];
  eventsEnabled = true;
  private readonly eventStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private seq = 0;

  get openSessions(): string[] {
    return this.created.filter((s) => !this.deleted.includes(s));
  }

  private emit(type: string, properties: Record<string, unknown>): void {
    const data = new TextEncoder().encode(
      `data: ${JSON.stringify({ id: `evt_${++this.seq}`, type, properties })}\n\n`,
    );
    for (const c of this.eventStreams) {
      try {
        c.enqueue(data);
      } catch {
        this.eventStreams.delete(c);
      }
    }
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    this.authHeaders.push(headers.get('authorization'));
    const path = url.pathname;
    const signal = init?.signal ?? undefined;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (path === '/event' && method === 'GET') {
      if (!this.eventsEnabled) return new Response('nope', { status: 500 });
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          ctrl = c;
          this.eventStreams.add(c);
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', properties: {} })}\n\n`,
            ),
          );
        },
        cancel: () => {
          this.eventStreams.delete(ctrl);
        },
      });
      signal?.addEventListener('abort', () => {
        this.eventStreams.delete(ctrl);
        try {
          ctrl.error(new DOMException('aborted', 'AbortError'));
        } catch {
          /* already closed */
        }
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/global/health') return json({ healthy: true, version: 'fake' });
    if (path === '/session' && method === 'POST') {
      const id = `ses_${this.created.length + 1}`;
      this.created.push(id);
      return json({ id, title: (JSON.parse(init?.body as string) as { title: string }).title });
    }
    const m = /^\/session\/([^/]+)(\/message|\/abort)?$/.exec(path);
    if (m) {
      const sid = decodeURIComponent(m[1]!);
      if (method === 'DELETE') {
        this.deleted.push(sid);
        return json(true);
      }
      if (m[2] === '/abort') {
        this.aborted.push(sid);
        return json(true);
      }
      if (m[2] === '/message' && method === 'POST') {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        this.prompts.push({ sessionId: sid, body });
        const reply = this.replies.shift() ?? { text: 'default reply' };
        if (reply.httpStatus) return json({ error: 'boom' }, reply.httpStatus);
        const userId = `msg_u${this.seq}`;
        const asstId = `msg_a${this.seq}`;
        const partId = `prt_t${this.seq}`;
        this.emit('message.updated', {
          sessionID: sid,
          info: { id: userId, role: 'user', sessionID: sid },
        });
        this.emit('message.part.updated', {
          sessionID: sid,
          part: {
            id: `prt_u${this.seq}`,
            messageID: userId,
            sessionID: sid,
            type: 'text',
            text: 'user prompt',
          },
          time: 1,
        });
        this.emit('message.updated', {
          sessionID: sid,
          info: { id: asstId, role: 'assistant', sessionID: sid },
        });
        if (reply.reasoning) {
          this.emit('message.part.updated', {
            sessionID: sid,
            part: {
              id: `prt_r${this.seq}`,
              messageID: asstId,
              sessionID: sid,
              type: 'reasoning',
              text: '',
            },
          });
          this.emit('message.part.delta', {
            sessionID: sid,
            messageID: asstId,
            partID: `prt_r${this.seq}`,
            field: 'text',
            delta: reply.reasoning,
          });
        }
        const text = reply.text ?? '';
        if (text) {
          this.emit('message.part.updated', {
            sessionID: sid,
            part: { id: partId, messageID: asstId, sessionID: sid, type: 'text', text: '' },
          });
          const deltas = reply.deltas ?? splitIn3(text);
          for (const d of deltas) {
            this.emit('message.part.delta', {
              sessionID: sid,
              messageID: asstId,
              partID: partId,
              field: 'text',
              delta: d,
            });
            await new Promise((r) => setTimeout(r, 1));
          }
          this.emit('message.part.updated', {
            sessionID: sid,
            part: { id: partId, messageID: asstId, sessionID: sid, type: 'text', text },
          });
        }
        if (reply.delayMs) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, reply.delayMs);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException('aborted', 'AbortError'),
              );
            });
          });
        }
        this.emit('session.idle', { sessionID: sid });
        const parts = [
          { type: 'step-start' },
          ...(reply.reasoning ? [{ type: 'reasoning', text: reply.reasoning }] : []),
          ...(text ? [{ type: 'text', text }] : []),
          { type: 'step-finish' },
        ];
        return json({
          info: {
            id: asstId,
            sessionID: sid,
            role: 'assistant',
            tokens: reply.tokens ?? {
              input: 10,
              output: 5,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            ...(reply.error ? { error: reply.error } : {}),
            finish: 'stop',
          },
          parts,
        });
      }
    }
    return json({ error: `unhandled ${method} ${path}` }, 404);
  };
}

function splitIn3(text: string): string[] {
  const n = Math.ceil(text.length / 3);
  return [text.slice(0, n), text.slice(n, 2 * n), text.slice(2 * n)].filter(Boolean);
}
