import { afterAll, describe, expect, it } from 'vitest';
import type { ApiKeyRecord } from '../../src/core/services.js';
import { RedisRateLimiter } from '../../src/limits/redis-ratelimit.js';
import { silentLogger } from '../../src/observability/logger.js';
import { createRedisClient, RedisKeys } from '../../src/platform/redis.js';
import { testConfig } from '../helpers.js';
import { cleanupRedis, namespace, newRedis, rand } from './helpers.js';

const ns = namespace('rl');
const redis = newRedis();
const keys = new RedisKeys(ns.prefix);

function key(
  over: Partial<ApiKeyRecord> = {},
  team: Partial<ApiKeyRecord['team']> = {},
): ApiKeyRecord {
  const id = `k_${rand()}`;
  return {
    id,
    name: 'k',
    prefix: 'sk-sy-xxxxxx',
    team: { id: `team:${id}`, slug: `team_${rand()}`, name: 't', ...team },
    allowedRoutes: undefined,
    allowDirectModels: false,
    rpmLimit: undefined,
    tpmLimit: undefined,
    source: 'db',
    ...over,
  };
}

function limiter(defaults: Record<string, unknown> = {}, now?: () => number) {
  const config = testConfig({
    providers: { mock: { type: 'mock' } },
    models: { m: { provider: 'mock', model: 'mock-echo' } },
    routes: { r: { targets: ['m'] } },
    limits: { defaults },
  });
  return new RedisRateLimiter({
    redis,
    keys,
    config: () => config,
    logger: silentLogger(),
    ...(now ? { now } : {}),
  });
}

afterAll(async () => {
  await cleanupRedis(redis, ns);
  redis.disconnect();
});

describe('RedisRateLimiter (sliding window, Lua)', () => {
  it('enforces RPM per key and reports headers', async () => {
    let t = 1_000_000_020_000; // exactly at a window start
    const rl = limiter({}, () => t);
    const k = key({ rpmLimit: 3 });
    const decisions = [];
    for (let i = 0; i < 4; i++)
      decisions.push(await rl.check({ key: k, route: 'r', estimatedTokens: 10 }));
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions[0]!.headers['x-ratelimit-limit-requests']).toBe('3');
    expect(decisions[0]!.headers['x-ratelimit-remaining-requests']).toBe('2');
    expect(decisions[2]!.headers['x-ratelimit-remaining-requests']).toBe('0');
    const rejected = decisions[3]!;
    expect(rejected.rejectedBy).toBe('key:rpm');
    // All 3 hits are in the current window → must wait for the next one plus decay.
    expect(rejected.retryAfterMs).toBeGreaterThanOrEqual(40_000);
    t += 120_000; // two windows later everything has decayed
    expect((await rl.check({ key: k, route: 'r', estimatedTokens: 10 })).allowed).toBe(true);
  });

  it('weights the previous window (sliding estimate)', async () => {
    const W = 60_000;
    const base = Math.floor(2_000_000_000_000 / W) * W;
    let t = base + 59_000;
    const rl = limiter({}, () => t);
    const k = key({ rpmLimit: 10 });
    for (let i = 0; i < 10; i++)
      expect((await rl.check({ key: k, route: 'r', estimatedTokens: 0 })).allowed).toBe(true);
    // 1 s into the next window: estimate = 10 × 59/60 ≈ 9.83 → one more would exceed 10.
    t = base + W + 1000;
    const d = await rl.check({ key: k, route: 'r', estimatedTokens: 0 });
    expect(d.allowed).toBe(false);
    // Previous-window weight must drop to ≤ 9/10 → elapsed ≥ 6 s.
    expect(d.retryAfterMs).toBe(5000);
    t = base + W + 6000;
    expect((await rl.check({ key: k, route: 'r', estimatedTokens: 0 })).allowed).toBe(true);
  });

  it('is all-or-nothing across scopes (a team rejection does not consume the key budget)', async () => {
    const t = 3_000_000_010_000;
    const rl = limiter({}, () => t);
    const slug = `team_${rand()}`;
    const a = key({ rpmLimit: 100 }, { slug, rpmLimit: 2 });
    const b = key({ rpmLimit: 100 }, { slug, rpmLimit: 2 });
    expect((await rl.check({ key: a, route: 'r', estimatedTokens: 0 })).allowed).toBe(true);
    expect((await rl.check({ key: b, route: 'r', estimatedTokens: 0 })).allowed).toBe(true);
    const third = await rl.check({ key: a, route: 'r', estimatedTokens: 0 });
    expect(third.allowed).toBe(false);
    expect(third.rejectedBy).toBe('team:rpm');
    expect(third.headers['x-ratelimit-limit-requests']).toBe('2'); // tightest scope = team
    const keyCount = await redis.hget(keys.k('rl', 'key', a.id, 'rpm'), 'c');
    expect(keyCount).toBe('1');
  });

  it('reserves the TPM estimate and reconciles to actual usage', async () => {
    const t = 4_000_000_010_000;
    const rl = limiter({}, () => t);
    const k = key({ tpmLimit: 1000 });
    const d1 = await rl.check({ key: k, route: 'r', estimatedTokens: 800 });
    expect(d1.allowed).toBe(true);
    expect(d1.headers['x-ratelimit-remaining-tokens']).toBe('200');
    // A second 800-token request does not fit while the reservation is held…
    expect((await rl.check({ key: k, route: 'r', estimatedTokens: 800 })).allowed).toBe(false);
    // …but after reconciling to the actual 100 tokens it does.
    await rl.reconcile(d1, 100);
    expect(await redis.hget(keys.k('rl', 'key', k.id, 'tpm'), 'c')).toBe('100');
    const d3 = await rl.check({ key: k, route: 'r', estimatedTokens: 800 });
    expect(d3.allowed).toBe(true);
    expect(d3.headers['x-ratelimit-remaining-tokens']).toBe('100');
    // Positive deltas are applied too (actual > estimate), never below zero for negatives.
    await rl.reconcile(d3, 2000);
    expect(await redis.hget(keys.k('rl', 'key', k.id, 'tpm'), 'c')).toBe('2100');
  });

  it('rejects requests larger than the TPM limit with a one-window retry', async () => {
    const rl = limiter({}, () => 5_000_000_000_000);
    const d = await rl.check({ key: key({ tpmLimit: 100 }), route: 'r', estimatedTokens: 500 });
    expect(d.allowed).toBe(false);
    expect(d.rejectedBy).toBe('key:tpm');
    expect(d.retryAfterMs).toBe(60_000);
  });

  it('falls back to config defaults and skips unlimited scopes', async () => {
    const rl = limiter({ key: { rpm: 1 } });
    const k = key();
    expect((await rl.check({ key: k, route: 'r', estimatedTokens: 0 })).allowed).toBe(true);
    expect((await rl.check({ key: k, route: 'r', estimatedTokens: 0 })).allowed).toBe(false);
    const none = await limiter().check({ key: key(), route: 'r', estimatedTokens: 1e9 });
    expect(none).toEqual({ allowed: true, headers: {} });
  });

  it('never exceeds the limit under 100 concurrent requests (server clock)', async () => {
    const rl = limiter();
    const k = key({ rpmLimit: 10, tpmLimit: 1_000_000 });
    const results = await Promise.all(
      Array.from({ length: 100 }, () => rl.check({ key: k, route: 'r', estimatedTokens: 5 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed).every((r) => r.rejectedBy === 'key:rpm')).toBe(true);
    const tpm = await redis.hget(keys.k('rl', 'key', k.id, 'tpm'), 'c');
    expect(tpm).toBe('50'); // only admitted requests reserved tokens
  });

  it('never exceeds a team limit across many keys and concurrent callers', async () => {
    const rl1 = limiter();
    const rl2 = limiter(); // second replica
    const slug = `team_${rand()}`;
    const ks = Array.from({ length: 10 }, () => key({}, { slug, rpmLimit: 25 }));
    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        (i % 2 ? rl1 : rl2).check({ key: ks[i % 10]!, route: 'r', estimatedTokens: 1 }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(25);
  });

  it('fails open (or closed) when Redis is unreachable', async () => {
    const dead = createRedisClient('redis://127.0.0.1:1/1', {
      name: 'dead',
      commandTimeoutMs: 100,
      connectTimeoutMs: 100,
    });
    const config = testConfig({
      providers: { mock: { type: 'mock' } },
      models: { m: { provider: 'mock', model: 'mock-echo' } },
      routes: { r: { targets: ['m'] } },
    });
    const open = new RedisRateLimiter({
      redis: dead,
      keys,
      config: () => config,
      logger: silentLogger(),
    });
    expect(
      (await open.check({ key: key({ rpmLimit: 1 }), route: 'r', estimatedTokens: 1 })).allowed,
    ).toBe(true);
    const closed = new RedisRateLimiter({
      redis: dead,
      keys,
      config: () => config,
      logger: silentLogger(),
      failOpen: false,
    });
    await expect(
      closed.check({ key: key({ rpmLimit: 1 }), route: 'r', estimatedTokens: 1 }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'service_unavailable',
    });
    dead.disconnect();
  });
});
