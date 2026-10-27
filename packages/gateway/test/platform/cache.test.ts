import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisCacheStore } from '../../src/cache/redis-cache.js';
import { RedisVectorIndex } from '../../src/cache/semantic.js';
import type { CacheEntry } from '../../src/core/services.js';
import { silentLogger } from '../../src/observability/logger.js';
import { RedisKeys } from '../../src/platform/redis.js';
import { readSSE } from '../helpers.js';
import { chatBody, harness, waitFor, type PlatformHarness } from './helpers.js';

let h: PlatformHarness;
let otherKey: string;

beforeAll(async () => {
  h = await harness('cache');
  await h.platform.admin!.createTeam('test', { slug: 'other' });
  otherKey = (await h.platform.admin!.createKey('test', 'other', { name: 'k' })).key;
});
afterAll(async () => h?.close());

/** Repeats a request until the predicate holds (cache writes are asynchronous). */
async function until(
  fn: () => Promise<Response>,
  pred: (r: Response) => boolean,
): Promise<Response> {
  let last!: Response;
  await waitFor(async () => {
    last = await fn();
    return pred(last);
  });
  return last;
}

describe('RedisCacheStore / RedisVectorIndex', () => {
  it('round-trips entries, batches reads, and purges by prefix', async () => {
    const keys = new RedisKeys(`${h.ns.prefix}unit:`);
    const store = new RedisCacheStore({ redis: h.redis, keys, logger: silentLogger() });
    const entry: CacheEntry = {
      payload: {
        kind: 'embedding',
        response: {
          object: 'list',
          data: [],
          model: 'm',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        },
      },
      provider: 'p',
      model: 'm',
      costUsd: 0.5,
      createdAt: 1,
    };
    await store.set('chat:r1:team:a:1', entry, 60);
    await store.setMany([{ key: 'chat:r2:team:a:2', entry, ttlSeconds: 60 }]);
    expect(await store.get('chat:r1:team:a:1')).toEqual(entry);
    expect(await store.getMany(['chat:r1:team:a:1', 'nope', 'chat:r2:team:a:2'])).toEqual([
      entry,
      null,
      entry,
    ]);
    expect(await h.redis.ttl(keys.k('cache', 'chat:r1:team:a:1'))).toBeGreaterThan(50);
    await h.redis.set(keys.k('cache', 'corrupt'), 'garbage');
    expect(await store.get('corrupt')).toBeNull();
    expect(await store.purge('chat:r1:')).toBe(1);
    expect(await store.get('chat:r2:team:a:2')).toEqual(entry);
  });

  it('finds nearest neighbours above a cosine threshold', async () => {
    const idx = new RedisVectorIndex(h.redis, new RedisKeys(`${h.ns.prefix}unit:`), silentLogger());
    await idx.add('i1', [1, 0, 0], 'a', { k: 'a' }, 60);
    await idx.add('i1', [0, 1, 0], 'b', { k: 'b' }, 60);
    expect(await idx.search('i1', [1, 0.05, 0], 0.95)).toMatchObject({ element: 'a' });
    expect(await idx.search('i1', [0.7071, 0.7071, 0], 0.95)).toBeNull();
    const m = await idx.search('i1', [0.7071, 0.7071, 0], 0.7);
    expect(m?.similarity).toBeCloseTo(0.7071, 3);
    expect(await idx.search('missing', [1, 0, 0], 0.5)).toBeNull();
    await idx.remove('i1', 'a');
    expect((await idx.search('i1', [1, 0, 0], 0.5))?.element).not.toBe('a');
  });
});

describe('exact cache through the gateway', () => {
  it('miss → hit with cost 0, saved cost and identical body', async () => {
    const body = chatBody(`cache me ${Date.now()}`);
    const r1 = await h.request('/v1/chat/completions', body);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('x-sy-cache')).toBe('miss');
    const cost = Number(r1.headers.get('x-sy-cost-usd'));
    expect(cost).toBeGreaterThan(0);
    const j1 = (await r1.json()) as { choices: unknown };
    const r2 = await until(
      () => h.request('/v1/chat/completions', body),
      (r) => r.headers.get('x-sy-cache') === 'hit',
    );
    expect(r2.headers.get('x-sy-cost-usd')).toBe('0');
    expect(Number(r2.headers.get('x-sy-saved-usd'))).toBeCloseTo(cost, 10);
    expect(r2.headers.get('x-sy-provider')).toBe('mock');
    const j2 = (await r2.json()) as { choices: unknown; model: string };
    expect(j2.choices).toEqual(j1.choices);
    expect(j2.model).toBe('echo');
  });

  it('honors x-sy-cache: bypass (no read, no write) and refresh (no read, write)', async () => {
    const body = chatBody(`modes ${Date.now()}`);
    const b = await h.request('/v1/chat/completions', body, { 'x-sy-cache': 'bypass' });
    expect(b.headers.get('x-sy-cache')).toBe('bypass');
    await new Promise((r) => setTimeout(r, 50));
    expect((await h.request('/v1/chat/completions', body)).headers.get('x-sy-cache')).toBe('miss');
    await until(
      () => h.request('/v1/chat/completions', body),
      (r) => r.headers.get('x-sy-cache') === 'hit',
    );
    const refreshed = await h.request('/v1/chat/completions', body, { 'x-sy-cache': 'refresh' });
    expect(refreshed.headers.get('x-sy-cache')).toBe('miss');
    expect(Number(refreshed.headers.get('x-sy-cost-usd'))).toBeGreaterThan(0);
  });

  it('isolates teams unless the route is shared', async () => {
    const body = chatBody(`isolation ${Date.now()}`);
    await until(
      () => h.request('/v1/chat/completions', body),
      (r) => r.headers.get('x-sy-cache') === 'hit',
    );
    const other = await h.request('/v1/chat/completions', body, {
      authorization: `Bearer ${otherKey}`,
    });
    expect(other.status).toBe(200);
    expect(other.headers.get('x-sy-cache')).toBe('miss');

    const shared = { ...body, model: 'echo-shared' };
    await until(
      () => h.request('/v1/chat/completions', shared),
      (r) => r.headers.get('x-sy-cache') === 'hit',
    );
    const otherShared = await h.request('/v1/chat/completions', shared, {
      authorization: `Bearer ${otherKey}`,
    });
    expect(otherShared.headers.get('x-sy-cache')).toBe('hit');
  });

  it('replays cached responses as SSE with usage in the final chunk', async () => {
    const body = chatBody(`stream replay with several words in it ${Date.now()}`, {
      stream: true,
      stream_options: { include_usage: true },
    });
    const first = await h.request('/v1/chat/completions', body);
    expect(first.headers.get('x-sy-cache')).toBe('miss');
    const live = await readSSE(first);
    const r = await until(
      () => h.request('/v1/chat/completions', body),
      (x) => x.headers.get('x-sy-cache') === 'hit',
    );
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(r.headers.get('x-sy-cost-usd')).toBe('0');
    const replay = await readSSE(r);
    expect(replay.at(-1)).toBe('[DONE]');
    const chunks = replay.slice(0, -1) as {
      choices: { delta: { content?: string } }[];
      usage?: { total_tokens: number } | null;
    }[];
    const text = (cs: typeof chunks) => cs.map((c) => c.choices[0]?.delta.content ?? '').join('');
    expect(text(chunks)).toBe(text(live.slice(0, -1) as typeof chunks));
    const last = chunks.at(-1)!;
    expect(last.choices).toEqual([]);
    expect(last.usage?.total_tokens).toBeGreaterThan(0);
    // The non-streaming request is served from the same entry.
    const json = await h.request('/v1/chat/completions', {
      ...body,
      stream: false,
      stream_options: undefined,
    });
    expect(json.headers.get('x-sy-cache')).toBe('hit');
  });

  it('does not cache non-deterministic or uncached requests', async () => {
    const hot = await h.request(
      '/v1/chat/completions',
      chatBody(`temp ${Date.now()}`, { temperature: 0.7 }),
    );
    expect(hot.headers.get('x-sy-cache')).toBe('bypass');
    const nocache = await h.request('/v1/chat/completions', {
      ...chatBody('x'),
      model: 'echo-nocache',
    });
    expect(nocache.headers.get('x-sy-cache')).toBe('bypass');
    const failed = chatBody(`fail ${Date.now()}`);
    const r = await h.request('/v1/chat/completions', failed, { 'x-mock-status': '400' });
    expect(r.status).toBe(400);
    await new Promise((res) => setTimeout(res, 50));
    expect((await h.request('/v1/chat/completions', failed)).headers.get('x-sy-cache')).toBe(
      'miss',
    );
  });

  it('caches rerank responses', async () => {
    const body = { model: 'rerank', query: `q ${Date.now()}`, documents: ['alpha', 'beta q'] };
    expect((await h.request('/v1/rerank', body)).headers.get('x-sy-cache')).toBe('miss');
    await until(
      () => h.request('/v1/rerank', body),
      (r) => r.headers.get('x-sy-cache') === 'hit',
    );
  });

  it('purges by route via the admin API', async () => {
    const body = chatBody(`purge ${Date.now()}`);
    await until(
      () => h.request('/v1/chat/completions', body),
      (r) => r.headers.get('x-sy-cache') === 'hit',
    );
    const res = await h.admin('POST', '/cache/purge', { route: 'echo' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBeGreaterThan(0);
    expect((await h.request('/v1/chat/completions', body)).headers.get('x-sy-cache')).toBe('miss');
  });
});

describe('per-item embedding cache', () => {
  type Emb = { data: { index: number; embedding: number[] }[]; usage: { prompt_tokens: number } };
  it('embeds only uncached items and merges in order', async () => {
    const s = Date.now();
    const [a, b, c] = [`alpha ${s}`, `bravo ${s}`, `charlie ${s}`];
    const r1 = await h.request('/v1/embeddings', {
      model: 'embed',
      input: [a, b],
      input_type: 'document',
    });
    expect(r1.headers.get('x-sy-cache')).toBe('miss');
    expect(r1.headers.get('x-sy-cache-items')).toBe('0/2');
    const j1 = (await r1.json()) as Emb;
    const r2 = await until(
      () => h.request('/v1/embeddings', { model: 'embed', input: [b, c], input_type: 'document' }),
      (r) => r.headers.get('x-sy-cache-items') === '1/2',
    );
    expect(r2.headers.get('x-sy-cache')).toBe('miss');
    const j2 = (await r2.json()) as Emb;
    expect(j2.data.map((d) => d.index)).toEqual([0, 1]);
    expect(j2.data[0]!.embedding).toEqual(j1.data[1]!.embedding); // b from cache
    const r3 = await until(
      () =>
        h.request('/v1/embeddings', { model: 'embed', input: [c, a, b], input_type: 'document' }),
      (r) => r.headers.get('x-sy-cache') === 'hit',
    );
    expect(r3.headers.get('x-sy-cache-items')).toBe('3/3');
    expect(r3.headers.get('x-sy-cost-usd')).toBe('0');
    expect(Number(r3.headers.get('x-sy-saved-usd'))).toBeGreaterThan(0);
    const j3 = (await r3.json()) as Emb;
    expect(j3.data[1]!.embedding).toEqual(j1.data[0]!.embedding);
    expect(j3.usage.prompt_tokens).toBeGreaterThan(0);
    // input_type is part of the key: the same text as a query is a different item.
    const q = await h.request('/v1/embeddings', { model: 'embed', input: a, input_type: 'query' });
    expect(q.headers.get('x-sy-cache-items')).toBe('0/1');
  });
});

describe('semantic cache (Redis vector sets)', () => {
  it('serves paraphrases from the cache and misses on unrelated questions', async () => {
    const s = Date.now();
    const sys = { role: 'system', content: `You are helpful ${s}` };
    const ask = (content: string, system = sys) =>
      h.request('/v1/chat/completions', {
        model: 'sem',
        messages: [system, { role: 'user', content }],
      });
    const first = await ask('What is the capital of France?');
    expect(first.headers.get('x-sy-cache')).toBe('miss');
    const cost = Number(first.headers.get('x-sy-cost-usd'));
    const para = await until(
      () => ask('what is the capital of france'),
      (r) => r.headers.get('x-sy-cache') === 'semantic-hit',
    );
    expect(Number(para.headers.get('x-sy-semantic-similarity'))).toBeGreaterThan(0.99);
    expect(Number(para.headers.get('x-sy-saved-usd'))).toBeCloseTo(cost, 10);
    expect(para.headers.get('x-sy-cost-usd')).toBe('0');
    expect((await ask('How do I bake sourdough bread at home?')).headers.get('x-sy-cache')).toBe(
      'miss',
    );
    // A different system prompt is a different scope.
    expect(
      (
        await ask('what is the capital of france', { role: 'system', content: 'Different' })
      ).headers.get('x-sy-cache'),
    ).toBe('miss');
    // Tool requests never use the semantic cache.
    const tools = await h.request('/v1/chat/completions', {
      model: 'sem',
      messages: [sys, { role: 'user', content: 'what is the capital of france' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    });
    expect(tools.headers.get('x-sy-cache')).not.toBe('semantic-hit');
  });
});
