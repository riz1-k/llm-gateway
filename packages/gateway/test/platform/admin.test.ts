import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpAdminApi, LocalAdminApi } from '../../src/cli/admin-api.js';
import { seedDev } from '../../src/cli/seed.js';
import { silentLogger } from '../../src/observability/logger.js';
import { UsageWorker } from '../../src/usage/worker.js';
import { ADMIN, chatBody, harness, KEY, newRedis, type PlatformHarness } from './helpers.js';

let h: PlatformHarness;
beforeAll(async () => {
  h = await harness('admin');
});
afterAll(async () => h?.close());

const j = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;

describe('admin API', () => {
  it('requires the admin bearer token', async () => {
    expect((await h.admin('GET', '/teams', undefined, '')).status).toBe(401);
    expect((await h.admin('GET', '/teams', undefined, 'sk-sy-wrong-admin-token')).status).toBe(401);
    expect((await h.admin('GET', '/teams', undefined, KEY)).status).toBe(401);
    const res = await h.admin('POST', '/teams', { slug: 'nope' }, KEY);
    expect(res.status).toBe(401);
    expect((await j<{ error: { code: string } }>(res)).error.code).toBe('invalid_api_key');
  });

  it('manages teams: create, conflict, validation, get, patch, list, delete', async () => {
    const created = await h.admin('POST', '/teams', {
      slug: 'docs',
      name: 'Docs',
      rpm_limit: 50,
      budgets: { monthly: { limit_usd: 25 } },
    });
    expect(created.status).toBe(201);
    const team = await j<{
      id: string;
      slug: string;
      budgets: { period: string; limit_usd: number; soft_threshold: number; action: string }[];
    }>(created);
    expect(team.budgets).toEqual([
      { period: 'monthly', limit_usd: 25, soft_threshold: 0.8, action: 'block', webhook_url: null },
    ]);
    expect((await h.admin('POST', '/teams', { slug: 'docs' })).status).toBe(409);
    const bad = await h.admin('POST', '/teams', { slug: 'Bad Slug!' });
    expect(bad.status).toBe(400);
    expect((await j<{ error: { param: string } }>(bad)).error.param).toBe('slug');
    expect((await h.admin('POST', '/teams', { slug: 'x', bogus: 1 })).status).toBe(400);
    expect((await j<{ slug: string }>(await h.admin('GET', `/teams/${team.id}`))).slug).toBe(
      'docs',
    );
    const patched = await j<{ name: string; tpm_limit: number }>(
      await h.admin('PATCH', '/teams/docs', { name: 'DocsQA', tpm_limit: 9999 }),
    );
    expect(patched).toMatchObject({ name: 'DocsQA', tpm_limit: 9999 });
    expect(
      (await j<{ data: { slug: string }[] }>(await h.admin('GET', '/teams'))).data.map(
        (t) => t.slug,
      ),
    ).toContain('docs');
    await h.admin('POST', '/teams', { slug: 'tmp' });
    const del = await h.admin('DELETE', '/teams/tmp');
    expect(del.status).toBe(200);
    expect((await h.admin('GET', '/teams/tmp')).status).toBe(404);
    expect((await h.admin('POST', '/teams', { slug: 'tmp' })).status).toBe(409); // slug stays reserved
  });

  it('manages keys: plaintext once, masked listing, revoke, rotate', async () => {
    const res = await h.admin('POST', '/teams/docs/keys', {
      name: 'svc',
      allowed_routes: ['echo', 'free'],
    });
    expect(res.status).toBe(201);
    const { key, record } = await j<{
      key: string;
      record: { id: string; masked: string; status: string };
    }>(res);
    expect(record.status).toBe('active');
    const list = await h.admin('GET', '/teams/docs/keys');
    const text = await list.text();
    expect(text).not.toContain(key);
    expect(text).toContain(record.masked);
    expect((await h.admin('POST', '/teams/docs/keys', { allowed_routes: ['nope'] })).status).toBe(
      400,
    );
    expect(
      (await h.request('/v1/models', undefined, { authorization: `Bearer ${key}` })).status,
    ).toBe(200);
    const rot = await j<{ key: string; record: { id: string }; previous: { status: string } }>(
      await h.admin('POST', `/keys/${record.id}/rotate`, {}),
    );
    expect(rot.previous.status).toBe('revoked');
    expect(
      (await h.request('/v1/models', undefined, { authorization: `Bearer ${key}` })).status,
    ).toBe(401);
    expect(
      (await h.request('/v1/models', undefined, { authorization: `Bearer ${rot.key}` })).status,
    ).toBe(200);
    const rev = await j<{ status: string }>(await h.admin('POST', `/keys/${rot.record.id}/revoke`));
    expect(rev.status).toBe('revoked');
    expect(
      (await h.request('/v1/models', undefined, { authorization: `Bearer ${rot.key}` })).status,
    ).toBe(401);
    expect(
      (await h.admin('POST', '/keys/00000000-0000-0000-0000-000000000000/revoke')).status,
    ).toBe(404);
    expect(
      (await j<{ data: unknown[] }>(await h.admin('GET', '/teams/docs/keys?include_revoked=true')))
        .data.length,
    ).toBe(2);
  });

  it('enforces budgets end to end: 402 budget_exceeded and budget status with projection', async () => {
    await h.admin('POST', '/teams', { slug: 'broke' });
    expect(
      (
        await h.admin('PUT', '/teams/broke/budgets', {
          monthly: { limit_usd: 0.5, soft_threshold: 0.5 },
        })
      ).status,
    ).toBe(200);
    const { key } = await j<{ key: string }>(
      await h.admin('POST', '/teams/broke/keys', { name: 'k' }),
    );
    let status = 200;
    let last: Response | undefined;
    for (let i = 0; i < 100 && status === 200; i++) {
      last = await h.request(
        '/v1/chat/completions',
        chatBody(`spend some money please ${i}`, { max_tokens: 16 }),
        { authorization: `Bearer ${key}`, 'x-sy-cache': 'bypass' },
      );
      status = last.status;
    }
    expect(status).toBe(402);
    const err = await j<{ error: { code: string; type: string; message: string } }>(last!);
    expect(err.error).toMatchObject({ code: 'budget_exceeded', type: 'insufficient_quota' });
    expect(err.error.message).toContain('monthly');
    const b = await j<{
      spend: { monthly: number };
      budgets: {
        period: string;
        spent_usd: number;
        utilization: number;
        projected_usd: number;
        status: string;
        limit_usd: number;
      }[];
    }>(await h.admin('GET', '/teams/broke/budget'));
    const m = b.budgets.find((x) => x.period === 'monthly')!;
    expect(m.spent_usd).toBeGreaterThan(0.25);
    expect(m.spent_usd).toBeLessThanOrEqual(0.5 + 1e-9); // hard limit: pre-flight is an upper bound
    expect(m.utilization).toBeGreaterThan(0.5);
    expect(['soft', 'exceeded']).toContain(m.status);
    expect(m.projected_usd).toBeGreaterThanOrEqual(m.spent_usd);
    // Free routes (pre-flight cost 0) are never blocked.
    const free = await h.request(
      '/v1/chat/completions',
      { ...chatBody('free'), model: 'free' },
      { authorization: `Bearer ${key}` },
    );
    expect(free.status).toBe(200);
  });

  it('enforces rate limits end to end: 429 with x-ratelimit-* and retry-after', async () => {
    await h.admin('POST', '/teams', { slug: 'tight', rpm_limit: 2 });
    const { key } = await j<{ key: string }>(
      await h.admin('POST', '/teams/tight/keys', { name: 'k', tpm_limit: 100000 }),
    );
    const call = () =>
      h.request(
        '/v1/chat/completions',
        { ...chatBody('rl'), model: 'free' },
        { authorization: `Bearer ${key}` },
      );
    const r1 = await call();
    expect(r1.status).toBe(200);
    expect(r1.headers.get('x-ratelimit-limit-requests')).toBe('2');
    expect(r1.headers.get('x-ratelimit-remaining-requests')).toBe('1');
    expect(r1.headers.get('x-ratelimit-limit-tokens')).toBe('100000');
    expect(Number(r1.headers.get('x-ratelimit-remaining-tokens'))).toBeLessThan(100000);
    expect(r1.headers.get('x-ratelimit-reset-requests')).toMatch(/^\d+(m\d+)?s$|ms$/);
    expect((await call()).status).toBe(200);
    const r3 = await call();
    expect(r3.status).toBe(429);
    expect((await j<{ error: { code: string } }>(r3)).error.code).toBe('rate_limit_exceeded');
    expect(Number(r3.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(r3.headers.get('retry-after-ms'))).toBeGreaterThan(0);
    expect(r3.headers.get('x-ratelimit-remaining-requests')).toBe('0');
  });

  it('reports usage from the rollups after the worker ran', async () => {
    const blocking = newRedis();
    const w = new UsageWorker({
      redis: blocking,
      database: h.platform.database!,
      stream: h.ns.stream,
      group: 'writers',
      batchSize: 500,
      blockMs: 20,
      claimIdleMs: 60_000,
      retentionDays: 400,
      partitionsAhead: 1,
      logger: silentLogger(),
    });
    await h.gateway.services.usage.flush?.();
    await w.ensureGroup();
    for (let i = 0; i < 10; i++) await w.tick();
    blocking.disconnect();
    const byTeam = await j<{
      rows: { group: string; requests: number; cost_usd: number }[];
      totals: { requests: number };
    }>(await h.admin('GET', '/usage?group_by=team'));
    const broke = byTeam.rows.find((r) => r.group === 'broke')!;
    expect(broke.requests).toBeGreaterThan(1);
    expect(broke.cost_usd).toBeGreaterThan(0);
    expect(byTeam.totals.requests).toBeGreaterThanOrEqual(broke.requests);
    const byKey = await j<{ rows: { label: string }[] }>(
      await h.admin('GET', '/usage?group_by=key&team=broke'),
    );
    expect(byKey.rows[0]!.label).toMatch(/^k \(sk-sy-.{6}…\)$/);
    expect((await h.admin('GET', '/usage?group_by=nope')).status).toBe(400);
    expect((await h.admin('GET', '/usage?from=2026-10-30&to=2026-10-01')).status).toBe(400);
  });

  it('audit-logs every mutation and redacts config', async () => {
    const audit = await j<{ data: { action: string; actor: string }[] }>(
      await h.admin('GET', '/audit?limit=200'),
    );
    const actions = new Set(audit.data.map((a) => a.action));
    for (const a of [
      'team.create',
      'team.update',
      'team.delete',
      'key.create',
      'key.rotate',
      'key.revoke',
      'budgets.set',
    ])
      expect(actions).toContain(a);
    expect(audit.data.every((a) => a.actor.startsWith('api'))).toBe(true);
    const cfg = await h.admin('GET', '/config');
    const text = await cfg.text();
    expect(text).not.toContain(ADMIN);
    expect(text).not.toContain(KEY);
    expect(text).toContain('"routes"');
  });

  it('readiness reports Redis and Postgres', async () => {
    const r = await h.gateway.fetch(new Request('http://gateway.test/readyz'));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      status: 'ready',
      checks: { redis: { ok: true }, postgres: { ok: true } },
    });
  });
});

describe('CLI admin clients and seed-dev', () => {
  it('seed-dev is idempotent (local mode) and keys work', async () => {
    const api = new LocalAdminApi(h.platform.admin!, h.config, async () => undefined);
    const first = await seedDev(api);
    expect(first.map((r) => [r.team, r.keyStatus, r.monthlyBudgetUsd])).toEqual([
      ['docsqa', 'created', 50],
      ['opsagent', 'created', 50],
      ['evals', 'created', 100],
    ]);
    const evalsKey = first[2]!.key!;
    expect(
      (
        await h.request('/v1/chat/completions', chatBody('seeded'), {
          authorization: `Bearer ${evalsKey}`,
        })
      ).status,
    ).toBe(200);
    const second = await seedDev(api);
    expect(second.map((r) => r.keyStatus)).toEqual(['exists', 'exists', 'exists']);
    expect(second.every((r) => r.key === null && !r.teamCreated)).toBe(true);
    const rotated = await seedDev(api, { rotate: true });
    expect(rotated.map((r) => r.keyStatus)).toEqual(['rotated', 'rotated', 'rotated']);
    const budget = await api.budgetStatus('evals');
    expect(budget.budgets[0]).toMatchObject({ period: 'monthly', limit_usd: 100, action: 'block' });
  });

  it('remote mode talks to the admin API over HTTP', async () => {
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      h.gateway.fetch(new Request(input, init))) as typeof fetch;
    const api = new HttpAdminApi('http://gateway.test', ADMIN, fetchImpl);
    expect(await api.routes()).toContain('echo');
    const team = await api.createTeam({ slug: 'remote', budgets: { daily: { limit_usd: 1 } } });
    expect(team.budgets[0]!.period).toBe('daily');
    const k = await api.createKey('remote', { name: 'r1' });
    expect((await api.listKeys('remote', false))[0]!.prefix).toBe(k.key.slice(0, 12));
    expect(await api.getTeam('missing')).toBeNull();
    const audit = await h.platform.admin!.listAudit(5);
    expect(audit[0]!.actor).toMatch(/^api:cli-/);
    await expect(
      new HttpAdminApi('http://gateway.test', 'bad-token-xxxxxx', fetchImpl).listTeams(),
    ).rejects.toMatchObject({ status: 401 });
  });
});
