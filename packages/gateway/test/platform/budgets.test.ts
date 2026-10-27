import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Team } from '../../src/core/services.js';
import { periodWindow } from '../../src/limits/periods.js';
import {
  RedisBudgetGuard,
  StaticBudgetSource,
  type BudgetAlert,
  type BudgetDefinition,
} from '../../src/limits/redis-budgets.js';
import { silentLogger } from '../../src/observability/logger.js';
import { PromMetrics } from '../../src/observability/metrics.js';
import { RedisKeys } from '../../src/platform/redis.js';
import { testConfig } from '../helpers.js';
import { cleanupRedis, namespace, newRedis, rand } from './helpers.js';

const ns = namespace('budget');
const redis = newRedis();
const keys = new RedisKeys(ns.prefix);
const AT = new Date('2026-10-27T12:00:00Z');

const monthly = (limitUsd: number, over: Partial<BudgetDefinition> = {}): BudgetDefinition => ({
  period: 'monthly',
  limitUsd,
  softThreshold: 0.8,
  action: 'block',
  webhookUrl: null,
  ...over,
});

function setup(defs: BudgetDefinition[], budgets: Record<string, unknown> = {}) {
  const slug = `team_${rand()}`;
  const team: Team = { id: `team:${slug}`, slug, name: slug };
  const source = new StaticBudgetSource({ [slug]: defs });
  const config = testConfig({
    providers: { mock: { type: 'mock' } },
    models: { m: { provider: 'mock', model: 'mock-echo' } },
    routes: { r: { targets: ['m'] } },
    budgets,
  });
  const alerts: BudgetAlert[] = [];
  const fetchMock = vi.fn(async () => new Response('ok'));
  const metrics = new PromMetrics({ defaultMetrics: false });
  const make = () =>
    new RedisBudgetGuard({
      redis,
      keys,
      source,
      config: () => config,
      logger: silentLogger(),
      metrics,
      clock: () => AT,
      fetch: fetchMock,
      onAlert: (a) => alerts.push(a),
    });
  return { team, source, guard: make(), make, alerts, fetchMock, metrics };
}

afterAll(async () => {
  await cleanupRedis(redis, ns);
  redis.disconnect();
});

describe('RedisBudgetGuard', () => {
  it('blocks when spent + preflight would exceed the limit (402 path)', async () => {
    const { team, guard } = setup([monthly(1)]);
    expect((await guard.check({ team, route: 'r', preflightCostUsd: 0.5 })).allowed).toBe(true);
    await guard.record({ team, route: 'r', costUsd: 0.7 });
    const d = await guard.check({ team, route: 'r', preflightCostUsd: 0.31 });
    expect(d).toMatchObject({ allowed: false, period: 'monthly', limitUsd: 1 });
    expect(d.remainingUsd).toBeCloseTo(0.3, 9);
    expect((await guard.check({ team, route: 'r', preflightCostUsd: 0.3 })).allowed).toBe(true);
  });

  it('never blocks requests that cannot cost money (pre-flight 0)', async () => {
    const { team, guard } = setup([monthly(0.1)]);
    await guard.record({ team, route: 'r', costUsd: 5 });
    expect((await guard.check({ team, route: 'r', preflightCostUsd: 0 })).allowed).toBe(true);
    expect((await guard.check({ team, route: 'r', preflightCostUsd: 0.0001 })).allowed).toBe(false);
  });

  it('tracks daily and monthly counters with TTL past period end and picks the tightest', async () => {
    const { team, guard } = setup([monthly(10), { ...monthly(1), period: 'daily' }]);
    await guard.record({ team, route: 'r', costUsd: 0.25 });
    await guard.record({ team, route: 'r', costUsd: 0.5 });
    expect(await guard.spend(team.slug, AT)).toEqual({ daily: 0.75, monthly: 0.75 });
    const dKey = keys.k('budget', team.slug, 'daily', periodWindow('daily', AT).key);
    const expireAt = await redis.expiretime(dKey);
    expect(expireAt).toBe(Date.UTC(2026, 9, 28) / 1000 + 86_400);
    const ok = await guard.check({ team, route: 'r', preflightCostUsd: 0.1 });
    expect(ok).toMatchObject({ allowed: true, period: 'daily' });
    expect(ok.remainingUsd).toBeCloseTo(0.25, 9);
    expect((await guard.check({ team, route: 'r', preflightCostUsd: 0.3 })).period).toBe('daily');
  });

  it('action=alert and enforcement soft/off never block', async () => {
    const a = setup([monthly(0.1, { action: 'alert' })]);
    await a.guard.record({ team: a.team, route: 'r', costUsd: 1 });
    expect((await a.guard.check({ team: a.team, route: 'r', preflightCostUsd: 1 })).allowed).toBe(
      true,
    );
    const s = setup([monthly(0.1)], { enforcement: 'soft' });
    await s.guard.record({ team: s.team, route: 'r', costUsd: 1 });
    expect((await s.guard.check({ team: s.team, route: 'r', preflightCostUsd: 1 })).allowed).toBe(
      true,
    );
    const off = setup([monthly(0.1)], { enforcement: 'off' });
    await off.guard.record({ team: off.team, route: 'r', costUsd: 1 });
    expect(
      (await off.guard.check({ team: off.team, route: 'r', preflightCostUsd: 1 })).allowed,
    ).toBe(true);
  });

  it('fires the soft-threshold alert exactly once per period across replicas (+ webhook)', async () => {
    const { team, make, alerts, fetchMock, metrics } = setup([
      monthly(1, { webhookUrl: 'https://hooks.example.test/budget' }),
    ]);
    const replicas = [make(), make(), make()];
    await replicas[0]!.record({ team, route: 'r', costUsd: 0.5 });
    expect(alerts).toHaveLength(0);
    // Many concurrent requests push spend over 80 % on different replicas.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        replicas[i % 3]!.record({ team, route: 'r', costUsd: 0.025 }),
      ),
    );
    expect(alerts.filter((a) => a.type === 'budget.soft_threshold')).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      team: team.slug,
      period: 'monthly',
      period_key: '202610',
      limit_usd: 1,
    });
    await replicas[1]!.record({ team, route: 'r', costUsd: 0.01 });
    expect(alerts).toHaveLength(1);
    // Crossing 100 % fires the "exceeded" alert, also once.
    await Promise.all(replicas.map((r) => r.record({ team, route: 'r', costUsd: 0.2 })));
    expect(alerts.map((a) => a.type)).toEqual(['budget.soft_threshold', 'budget.exceeded']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hooks.example.test/budget');
    expect(JSON.parse(init.body as string)).toMatchObject({
      type: 'budget.soft_threshold',
      team: team.slug,
    });
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      `sy_budget_alerts_total{team="${team.slug}",period="monthly",level="soft"} 1`,
    );
    expect(text).toMatch(
      new RegExp(`sy_budget_utilization_ratio\\{team="${team.slug}",period="monthly"\\} 1\\.`),
    );
  });

  it('reconciles: raises lower counters always, lowers only when drained', async () => {
    const { team, guard } = setup([monthly(10)]);
    await guard.record({ team, route: 'r', costUsd: 2 });
    // Postgres says 3 (Redis lost an increment) → raised.
    let r = await guard.reconcile(
      team.slug,
      { daily: 3, monthly: 3 },
      { allowDecrease: false, at: AT },
    );
    expect(r.monthly).toEqual({ before: 2, after: 3 });
    expect((await guard.spend(team.slug, AT)).monthly).toBe(3);
    // Postgres says 1 while events are still in flight → kept.
    await guard.reconcile(team.slug, { daily: 1, monthly: 1 }, { allowDecrease: false, at: AT });
    expect((await guard.spend(team.slug, AT)).monthly).toBe(3);
    // Drained pipeline → Postgres is exact.
    r = await guard.reconcile(team.slug, { daily: 1, monthly: 1 }, { allowDecrease: true, at: AT });
    expect(r.monthly).toEqual({ before: 3, after: 1 });
    expect(await guard.spend(team.slug, AT)).toEqual({ daily: 1, monthly: 1 });
  });

  it('fails open on Redis errors unless configured fail-closed', async () => {
    const { team } = setup([monthly(1)]);
    const broken = {
      mget: async () => {
        throw new Error('down');
      },
    } as never;
    const config = testConfig({
      providers: { mock: { type: 'mock' } },
      models: { m: { provider: 'mock', model: 'mock-echo' } },
      routes: { r: { targets: ['m'] } },
    });
    const source = new StaticBudgetSource({ [team.slug]: [monthly(1)] });
    const open = new RedisBudgetGuard({
      redis: broken,
      keys,
      source,
      config: () => config,
      logger: silentLogger(),
    });
    expect((await open.check({ team, route: 'r', preflightCostUsd: 5 })).allowed).toBe(true);
    const closed = new RedisBudgetGuard({
      redis: broken,
      keys,
      source,
      config: () => config,
      logger: silentLogger(),
      failOpen: false,
    });
    await expect(closed.check({ team, route: 'r', preflightCostUsd: 5 })).rejects.toMatchObject({
      status: 503,
    });
  });
});
