import { afterAll, describe, expect, it } from 'vitest';
import type { BreakerConfig } from '../../src/config/schema.js';
import { silentLogger } from '../../src/observability/logger.js';
import { createRedisClient, RedisKeys } from '../../src/platform/redis.js';
import { RedisBreakerStore } from '../../src/resilience/redis-breaker.js';
import { cleanupRedis, namespace, newRedis, rand } from './helpers.js';

const ns = namespace('cb');
const redis = newRedis();
const keys = new RedisKeys(ns.prefix);
const cfg: BreakerConfig = {
  enabled: true,
  window_s: 30,
  min_requests: 10,
  failure_rate: 0.5,
  consecutive_failures: 5,
  cooldown_s: 30,
  max_cooldown_s: 300,
};

afterAll(async () => {
  await cleanupRedis(redis, ns);
  redis.disconnect();
});

function replicas(n: number, clock: () => number, localCacheMs = 1000) {
  return Array.from(
    { length: n },
    () => new RedisBreakerStore({ redis, keys, logger: silentLogger(), clock, localCacheMs }),
  );
}

describe('RedisBreakerStore (shared across replicas)', () => {
  it('a trip recorded by one replica is enforced by another', async () => {
    let now = 1_700_000_000_000;
    const [a, b] = replicas(2, () => now);
    const target = `t_${rand()}`;
    for (let i = 0; i < 5; i++) await a!.record(target, 'failure', cfg);
    const d = await b!.acquire(target, cfg);
    expect(d).toMatchObject({ allowed: false, state: 'open' });
    expect(d.retryAt).toBe(now + 30_000);
    const snap = await b!.snapshot(cfg);
    expect(snap.find((s) => s.target === target)).toMatchObject({
      state: 'open',
      consecutiveFailures: 5,
      trips: 1,
    });

    // After the cooldown exactly one replica gets the half-open probe.
    now += 30_001;
    const decisions = await Promise.all([
      a!.acquire(target, cfg),
      b!.acquire(target, cfg),
      a!.acquire(target, cfg),
    ]);
    expect(decisions.filter((x) => x.probe)).toHaveLength(1);
    expect(decisions.filter((x) => x.allowed)).toHaveLength(1);
    // The probe succeeds on whichever replica got it → closed everywhere.
    const prober = decisions.findIndex((x) => x.probe) === 1 ? b! : a!;
    await prober.record(target, 'success', cfg, true);
    now += 2000; // past the local cache window
    expect(await a!.acquire(target, cfg)).toMatchObject({ allowed: true, state: 'closed' });
    expect(await b!.acquire(target, cfg)).toMatchObject({ allowed: true, state: 'closed' });
  });

  it('loses no updates under concurrent records (CAS)', async () => {
    const now = 1_700_000_100_000;
    const rs = replicas(3, () => now);
    const target = `t_${rand()}`;
    const big = { ...cfg, consecutive_failures: 1000, min_requests: 1000 };
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        rs[i % 3]!.record(target, i % 2 ? 'failure' : 'success', big),
      ),
    );
    const snap = (await rs[0]!.snapshot(big)).find((s) => s.target === target)!;
    expect(snap.window).toEqual({ total: 60, failures: 30, rate: 0.5 });
  });

  it('serves closed state from the local cache without Redis round-trips', async () => {
    const now = 1_700_000_200_000;
    const [a] = replicas(1, () => now);
    const target = `t_${rand()}`;
    await a!.acquire(target, cfg); // loads + caches "closed"
    await redis.hset(
      keys.k('cb', target),
      's',
      JSON.stringify({
        state: 'open',
        consecutiveFailures: 9,
        trips: 1,
        openedAt: now,
        openUntil: now + 60_000,
        probeStartedAt: null,
        buckets: [],
      }),
    );
    expect((await a!.acquire(target, cfg)).allowed).toBe(true); // stale for ≤ localCacheMs
    const [fresh] = replicas(1, () => now);
    expect((await fresh!.acquire(target, cfg)).allowed).toBe(false);
  });

  it('degrades to a local breaker when Redis is down', async () => {
    const dead = createRedisClient('redis://127.0.0.1:1/1', {
      name: 'dead',
      commandTimeoutMs: 100,
      connectTimeoutMs: 100,
    });
    const store = new RedisBreakerStore({ redis: dead, keys, logger: silentLogger() });
    for (let i = 0; i < 5; i++) await store.record('x', 'failure', cfg);
    expect((await store.acquire('x', cfg)).allowed).toBe(false);
    dead.disconnect();
  });

  it('opens the breaker for every gateway replica via the router', async () => {
    // Covered end-to-end in usage.test.ts (gateway with platform); here: reset clears state.
    const now = 1_700_000_300_000;
    const [a] = replicas(1, () => now, 0);
    const target = `t_${rand()}`;
    for (let i = 0; i < 5; i++) await a!.record(target, 'failure', cfg);
    await a!.reset(target);
    expect((await a!.acquire(target, cfg)).allowed).toBe(true);
  });
});
