import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UsageEvent } from '../../src/core/services.js';
import { silentLogger } from '../../src/observability/logger.js';
import { PromMetrics } from '../../src/observability/metrics.js';
import { createRedisClient } from '../../src/platform/redis.js';
import { reconcileBudgets } from '../../src/usage/reconcile.js';
import { streamLag } from '../../src/usage/stream.js';
import { RedisStreamUsageSink } from '../../src/usage/stream-sink.js';
import { UsageWorker } from '../../src/usage/worker.js';
import { dropExpiredPartitions } from '../../src/usage/writer.js';
import { readSSE } from '../helpers.js';
import { chatBody, harness, newRedis, waitFor, type PlatformHarness } from './helpers.js';

let h: PlatformHarness;
const clients: ReturnType<typeof newRedis>[] = [];

function worker(opts: Partial<ConstructorParameters<typeof UsageWorker>[0]> = {}): UsageWorker {
  const blocking = newRedis();
  clients.push(blocking);
  return new UsageWorker({
    redis: blocking,
    database: h.platform.database!,
    stream: h.ns.stream,
    group: 'writers',
    batchSize: 100,
    blockMs: 20,
    claimIdleMs: 100,
    retentionDays: 400,
    partitionsAhead: 1,
    logger: silentLogger(),
    ...opts,
  });
}

/** Runs ticks until the consumer group has nothing left to deliver. */
async function drain(w: UsageWorker): Promise<void> {
  await w.ensureGroup();
  for (let i = 0; i < 50; i++) {
    await w.tick();
    const lag = await streamLag(h.redis, h.ns.stream, 'writers');
    if (lag && lag.lag === 0 && lag.pending === 0) return;
  }
  throw new Error('stream not drained');
}

const count = async (sql: string): Promise<number> =>
  Number((await h.database.sql.unsafe(sql))[0]?.n ?? 0);

beforeAll(async () => {
  h = await harness('usage');
});
afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await h?.close();
});

describe('usage pipeline: request → Redis stream → worker → Postgres', () => {
  it('writes events and daily rollups for JSON, streaming, error and cache-hit requests', async () => {
    const tag = `e2e-${Date.now()}`;
    const ok = await h.request('/v1/chat/completions', chatBody(`hello ${tag}`), {
      'x-sy-tags': 'eval,case:1',
      'x-sy-user': 'u1',
    });
    const okId = ok.headers.get('x-request-id')!;
    const okCost = Number(ok.headers.get('x-sy-cost-usd'));
    const st = await h.request('/v1/chat/completions', chatBody(`stream ${tag}`, { stream: true }));
    await readSSE(st);
    const bad = await h.request('/v1/chat/completions', chatBody(`err ${tag}`), {
      'x-mock-status': '400',
    });
    expect(bad.status).toBe(400);
    let hit: Response;
    await waitFor(async () => {
      hit = await h.request('/v1/chat/completions', chatBody(`hello ${tag}`));
      return hit.headers.get('x-sy-cache') === 'hit';
    });
    await h.gateway.services.usage.flush?.();

    const w = worker();
    await drain(w);
    expect(w.stats.inserted).toBeGreaterThanOrEqual(4);

    const rows = await h.database.sql<
      {
        request_id: string;
        team: string;
        route: string;
        status: number;
        cache: string;
        stream: boolean;
        cost_usd: string;
        saved_usd: string;
        tags: string[];
        end_user: string | null;
        ttft_ms: number | null;
        provider: string;
      }[]
    >`select * from usage_events where request_id = ${okId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      team: 'test',
      route: 'echo',
      status: 200,
      cache: 'miss',
      stream: false,
      tags: ['eval', 'case:1'],
      end_user: 'u1',
      provider: 'mock',
    });
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(okCost, 10);

    const events = await h.database.sql<
      {
        status: number;
        cache: string;
        stream: boolean;
        ttft_ms: number | null;
        saved_usd: string;
      }[]
    >`
      select status, cache, stream, ttft_ms, saved_usd from usage_events where route = 'echo' order by ts`;
    expect(events.some((e) => e.stream && e.ttft_ms !== null)).toBe(true);
    expect(events.some((e) => e.status === 400)).toBe(true);
    const hitRow = events.find((e) => e.cache === 'hit')!;
    expect(Number(hitRow.saved_usd)).toBeCloseTo(okCost, 10);

    const daily = await h.database.sql<
      {
        requests: number;
        errors: number;
        cache_hits: number;
        cost_usd: number;
        saved_usd: number;
      }[]
    >`
      select sum(requests)::int as requests, sum(errors)::int as errors, sum(cache_hits)::int as cache_hits,
        sum(cost_usd)::float8 as cost_usd, sum(saved_usd)::float8 as saved_usd
      from usage_daily where team = 'test' and route = 'echo'`;
    const evAgg = await h.database.sql<{ requests: number; cost: number }[]>`
      select count(*)::int as requests, sum(cost_usd)::float8 as cost from usage_events where team = 'test' and route = 'echo'`;
    expect(daily[0]!.requests).toBe(evAgg[0]!.requests);
    expect(daily[0]!.cost_usd).toBeCloseTo(evAgg[0]!.cost, 9);
    expect(daily[0]!.errors).toBeGreaterThanOrEqual(1);
    expect(daily[0]!.cache_hits).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent on (ts, request_id): re-delivered events are not double counted', async () => {
    const before = await count('select count(*)::int as n from usage_events');
    const dailyBefore = await h.database.sql<
      { r: number }[]
    >`select sum(requests)::int as r from usage_daily`;
    // Re-publish every entry already in the stream (simulates a crash after commit, before XACK).
    const entries = (await h.redis.xrange(h.ns.stream, '-', '+')) as [string, string[]][];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, fields] of entries) await h.redis.xadd(h.ns.stream, '*', ...fields);
    const w = worker();
    await drain(w);
    expect(w.stats.duplicates).toBe(entries.length);
    expect(w.stats.inserted).toBe(0);
    expect(await count('select count(*)::int as n from usage_events')).toBe(before);
    const dailyAfter = await h.database.sql<
      { r: number }[]
    >`select sum(requests)::int as r from usage_daily`;
    expect(dailyAfter[0]!.r).toBe(dailyBefore[0]!.r);
  });

  it('reclaims entries left pending by a crashed consumer (XAUTOCLAIM)', async () => {
    const ev = event({ request_id: `claim-${Date.now()}` });
    await h.redis.xadd(h.ns.stream, '*', 'e', JSON.stringify(ev));
    // "Crashed" consumer: reads but never acknowledges.
    await h.redis.call(
      'XREADGROUP',
      'GROUP',
      'writers',
      'crashed',
      'COUNT',
      10,
      'STREAMS',
      h.ns.stream,
      '>',
    );
    expect((await streamLag(h.redis, h.ns.stream, 'writers'))?.pending).toBe(1);
    await new Promise((r) => setTimeout(r, 150));
    const w = worker();
    await w.claimStale();
    expect(w.stats.claimed).toBe(1);
    expect(
      await count(
        `select count(*)::int as n from usage_events where request_id = '${ev.request_id}'`,
      ),
    ).toBe(1);
    expect((await streamLag(h.redis, h.ns.stream, 'writers'))?.pending).toBe(0);
  });

  it('dead-letters malformed entries and creates partitions for old months on demand', async () => {
    await h.redis.xadd(h.ns.stream, '*', 'e', '{broken');
    const old = event({ request_id: `old-${Date.now()}`, ts: '2025-01-15T10:00:00.000Z' });
    await h.redis.xadd(h.ns.stream, '*', 'e', JSON.stringify(old));
    const w = worker();
    await drain(w);
    expect(w.stats.deadLettered).toBe(1);
    expect(await h.redis.xlen(`${h.ns.stream}:dead`)).toBe(1);
    expect(
      await count(
        `select count(*)::int as n from usage_events_y2025m01 where request_id = '${old.request_id}'`,
      ),
    ).toBe(1);
    // Retention drops partitions that ended before the cutoff.
    const dropped = await dropExpiredPartitions(
      h.platform.database!,
      365,
      new Date('2026-10-27T00:00:00Z'),
    );
    expect(dropped).toEqual(['usage_events_y2025m01']);
  });

  it('keeps events in memory while Redis is down and drops the oldest beyond buffer_max', async () => {
    const dead = createRedisClient('redis://127.0.0.1:1/1', {
      name: 'dead',
      commandTimeoutMs: 50,
      connectTimeoutMs: 50,
    });
    const metrics = new PromMetrics({ defaultMetrics: false });
    const sink = new RedisStreamUsageSink({
      redis: dead,
      stream: 'sy:t:none',
      maxLen: 100,
      bufferMax: 3,
      logger: silentLogger(),
      metrics,
    });
    for (let i = 0; i < 5; i++) sink.emit(event({ request_id: `b${i}` }));
    expect(sink.buffered).toBe(3);
    expect(sink.droppedTotal).toBe(2);
    expect(await metrics.registry.metrics()).toContain('sy_usage_events_dropped_total 2');
    await sink.close();
    dead.disconnect();
  });

  it('reconciles budget counters from the rollups when the stream is drained', async () => {
    await h.platform.admin!.createTeam('test', {
      slug: 'test',
      budgets: { monthly: { limit_usd: 100, soft_threshold: 0.8, action: 'block' } },
    });
    const pg = await h.database.sql<{ c: number }[]>`
      select coalesce(sum(cost_usd), 0)::float8 as c from usage_daily
      where team = 'test' and day >= date_trunc('month', now() at time zone 'utc')::date`;
    // Corrupt the Redis counter upwards; reconciliation lowers it because nothing is in flight.
    const guard = h.platform.budgets!;
    await guard.record({
      team: { id: 'x', slug: 'test', name: 'test' },
      route: 'echo',
      costUsd: 42,
    });
    const res = await reconcileBudgets({
      database: h.platform.database!,
      redis: h.redis,
      guard,
      stream: h.ns.stream,
      group: 'writers',
    });
    expect(res.drained).toBe(true);
    expect((await guard.spend('test')).monthly).toBeCloseTo(pg[0]!.c, 9);
  });
});

function event(over: Partial<UsageEvent>): UsageEvent {
  return {
    ts: new Date().toISOString(),
    request_id: `r-${Math.random()}`,
    team_id: 'team:test',
    team: 'test',
    key_id: 'k',
    route: 'echo',
    kind: 'chat',
    provider: 'mock',
    model: 'mock-echo',
    status: 200,
    error_code: null,
    cache: 'miss',
    stream: false,
    prompt_tokens: 10,
    cached_tokens: 0,
    completion_tokens: 5,
    reasoning_tokens: 0,
    cost_usd: 0.02,
    saved_usd: 0,
    latency_ms: 12,
    ttft_ms: null,
    attempts: 1,
    fallbacks: 0,
    end_user: null,
    tags: [],
    ...over,
  };
}
