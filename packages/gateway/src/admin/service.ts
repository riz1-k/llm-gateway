import { and, count, desc, eq, inArray, isNull, sql as dsql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generateApiKey, hashKey, keyPrefix } from '../auth/keys.js';
import type { ResolvedConfig } from '../config/resolve.js';
import { GatewayError } from '../core/errors.js';
import type { Database, Db } from '../db/client.js';
import {
  apiKeys,
  auditLog,
  budgets,
  teams,
  type ApiKeyRow,
  type BudgetRow,
  type TeamRow,
} from '../db/schema.js';
import { periodWindow, projectSpend, utcDay, type BudgetPeriod } from '../limits/periods.js';
import type { RedisBudgetGuard } from '../limits/redis-budgets.js';
import type { Logger } from '../observability/logger.js';
import type { InvalidationBus } from '../platform/invalidation.js';
import { deleteByPattern, type RedisKeys } from '../platform/redis.js';
import { queryUsage, type UsageQuery, type UsageReport } from '../usage/reports.js';
import type {
  BudgetInput,
  BudgetsInput,
  CreateKeyInput,
  CreateTeamInput,
  PurgeInput,
  RotateKeyInput,
  UpdateTeamInput,
} from './schemas.js';

export interface BudgetView {
  period: BudgetPeriod;
  limit_usd: number;
  soft_threshold: number;
  action: 'block' | 'alert';
  webhook_url: string | null;
}

export interface TeamView {
  id: string;
  slug: string;
  name: string;
  metadata: Record<string, unknown>;
  rpm_limit: number | null;
  tpm_limit: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  active_keys: number;
  budgets: BudgetView[];
}

export interface KeyView {
  id: string;
  team_id: string;
  team: string;
  name: string;
  prefix: string;
  /** Display form, e.g. `sk-sy-ab12cd…`. */
  masked: string;
  allowed_routes: string[] | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
  status: 'active' | 'revoked' | 'expired';
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  rotated_from: string | null;
}

export interface CreatedKey {
  /** Plaintext — returned exactly once, never stored. */
  key: string;
  record: KeyView;
}

export interface BudgetStatus {
  period: BudgetPeriod;
  period_key: string;
  period_start: string;
  period_end: string;
  limit_usd: number;
  spent_usd: number;
  remaining_usd: number;
  utilization: number;
  projected_usd: number;
  projected_utilization: number;
  soft_threshold: number;
  action: 'block' | 'alert';
  status: 'ok' | 'soft' | 'exceeded';
}

export interface TeamBudgetReport {
  team: string;
  as_of: string;
  /** Real-time spend (Redis counters); `persisted` = Postgres rollups (authoritative, may lag). */
  spend: { daily: number; monthly: number; persisted: { daily: number; monthly: number } };
  budgets: BudgetStatus[];
}

export interface AdminServiceOptions {
  database: Database;
  redis?: Redis | undefined;
  keys: RedisKeys;
  bus?: InvalidationBus | undefined;
  budgets?: RedisBudgetGuard | undefined;
  config: () => ResolvedConfig;
  logger: Logger;
  clock?: () => Date;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_KINDS = ['chat', 'emb', 'embi', 'rr'] as const;
const globEscape = (s: string): string => s.replace(/[*?[\]\\]/g, (c) => `\\${c}`);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Admin operations (SPEC §12) shared by the HTTP admin API and the CLI. Every mutation runs in a
 * transaction together with its audit_log row, then invalidates caches on all replicas.
 */
export class AdminService {
  constructor(private readonly opts: AdminServiceOptions) {}

  private get db(): Db {
    return this.opts.database.db;
  }

  private now(): Date {
    return this.opts.clock?.() ?? new Date();
  }

  private async audit(
    tx: Executor,
    actor: string,
    action: string,
    target: string | null,
    data: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({ actor, action, target, data });
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  private budgetView(b: BudgetRow): BudgetView {
    return {
      period: b.period,
      limit_usd: Number(b.limitUsd),
      soft_threshold: Number(b.softThreshold),
      action: b.action,
      webhook_url: b.webhookUrl,
    };
  }

  private teamView(t: TeamRow, activeKeys: number, bs: BudgetRow[]): TeamView {
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      metadata: t.metadata,
      rpm_limit: t.rpmLimit,
      tpm_limit: t.tpmLimit,
      created_at: t.createdAt.toISOString(),
      updated_at: t.updatedAt.toISOString(),
      deleted_at: iso(t.deletedAt),
      active_keys: activeKeys,
      budgets: bs.map((b) => this.budgetView(b)).sort((a, b) => a.period.localeCompare(b.period)),
    };
  }

  keyView(k: ApiKeyRow, teamSlug: string): KeyView {
    const now = this.now().getTime();
    return {
      id: k.id,
      team_id: k.teamId,
      team: teamSlug,
      name: k.name,
      prefix: k.keyPrefix,
      masked: `${k.keyPrefix}…`,
      allowed_routes: k.allowedRoutes,
      rpm_limit: k.rpmLimit,
      tpm_limit: k.tpmLimit,
      status: k.revokedAt
        ? 'revoked'
        : k.expiresAt && k.expiresAt.getTime() <= now
          ? 'expired'
          : 'active',
      expires_at: iso(k.expiresAt),
      revoked_at: iso(k.revokedAt),
      last_used_at: iso(k.lastUsedAt),
      created_at: k.createdAt.toISOString(),
      rotated_from: k.rotatedFrom,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Teams
  // -------------------------------------------------------------------------------------------

  /** Resolves a team by uuid or slug (404 if missing or deleted, unless includeDeleted). */
  async findTeam(idOrSlug: string, opts: { includeDeleted?: boolean } = {}): Promise<TeamRow> {
    const cond = UUID.test(idOrSlug)
      ? eq(teams.id, idOrSlug)
      : eq(teams.slug, idOrSlug.toLowerCase());
    const rows = await this.db
      .select()
      .from(teams)
      .where(opts.includeDeleted ? cond : and(cond, isNull(teams.deletedAt)))
      .limit(1);
    const t = rows[0];
    if (!t) throw new GatewayError(404, 'not_found', `Team ${idOrSlug} not found`);
    return t;
  }

  private async loadTeamView(t: TeamRow): Promise<TeamView> {
    const [kc] = await this.db
      .select({ n: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.teamId, t.id), isNull(apiKeys.revokedAt)));
    const bs = await this.db.select().from(budgets).where(eq(budgets.teamId, t.id));
    return this.teamView(t, Number(kc?.n ?? 0), bs);
  }

  async getTeam(idOrSlug: string): Promise<TeamView> {
    return this.loadTeamView(await this.findTeam(idOrSlug));
  }

  async listTeams(opts: { includeDeleted?: boolean } = {}): Promise<TeamView[]> {
    const ts = await this.db
      .select()
      .from(teams)
      .where(opts.includeDeleted ? undefined : isNull(teams.deletedAt))
      .orderBy(teams.slug);
    if (ts.length === 0) return [];
    const ids = ts.map((t) => t.id);
    const counts = await this.db
      .select({ teamId: apiKeys.teamId, n: count() })
      .from(apiKeys)
      .where(and(inArray(apiKeys.teamId, ids), isNull(apiKeys.revokedAt)))
      .groupBy(apiKeys.teamId);
    const bs = await this.db.select().from(budgets).where(inArray(budgets.teamId, ids));
    const byTeam = new Map(counts.map((c) => [c.teamId, Number(c.n)]));
    return ts.map((t) =>
      this.teamView(
        t,
        byTeam.get(t.id) ?? 0,
        bs.filter((b) => b.teamId === t.id),
      ),
    );
  }

  async createTeam(actor: string, input: CreateTeamInput): Promise<TeamView> {
    try {
      const team = await this.db.transaction(async (tx) => {
        const [t] = await tx
          .insert(teams)
          .values({
            slug: input.slug,
            name: input.name ?? input.slug,
            metadata: input.metadata ?? {},
            rpmLimit: input.rpm_limit ?? null,
            tpmLimit: input.tpm_limit ?? null,
          })
          .returning();
        if (input.budgets) await this.applyBudgets(tx, t!.id, input.budgets);
        await this.audit(tx, actor, 'team.create', t!.id, { ...input });
        return t!;
      });
      await this.opts.bus?.publish({ type: 'team', slug: team.slug });
      return this.loadTeamView(team);
    } catch (err) {
      if (pgCode(err) === '23505')
        throw new GatewayError(409, 'conflict', `Team ${input.slug} already exists`);
      throw err;
    }
  }

  async updateTeam(actor: string, idOrSlug: string, patch: UpdateTeamInput): Promise<TeamView> {
    const t = await this.findTeam(idOrSlug);
    const updated = await this.db.transaction(async (tx) => {
      const [u] = await tx
        .update(teams)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
          ...(patch.rpm_limit !== undefined ? { rpmLimit: patch.rpm_limit } : {}),
          ...(patch.tpm_limit !== undefined ? { tpmLimit: patch.tpm_limit } : {}),
          updatedAt: dsql`now()`,
        })
        .where(eq(teams.id, t.id))
        .returning();
      await this.audit(tx, actor, 'team.update', t.id, { slug: t.slug, ...patch });
      return u!;
    });
    await this.invalidateTeamKeys(t);
    return this.loadTeamView(updated);
  }

  /** Soft delete: the slug stays reserved (usage history is keyed by slug); all keys are revoked. */
  async deleteTeam(actor: string, idOrSlug: string): Promise<TeamView> {
    const t = await this.findTeam(idOrSlug);
    const updated = await this.db.transaction(async (tx) => {
      const [u] = await tx
        .update(teams)
        .set({ deletedAt: dsql`now()`, updatedAt: dsql`now()` })
        .where(eq(teams.id, t.id))
        .returning();
      const revoked = await tx
        .update(apiKeys)
        .set({ revokedAt: dsql`now()` })
        .where(and(eq(apiKeys.teamId, t.id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      await this.audit(tx, actor, 'team.delete', t.id, {
        slug: t.slug,
        revoked_keys: revoked.length,
      });
      return u!;
    });
    await this.invalidateTeamKeys(t);
    return this.teamView(updated, 0, []);
  }

  private async invalidateTeamKeys(t: TeamRow): Promise<void> {
    const ks = await this.db
      .select({ hash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.teamId, t.id));
    if (this.opts.redis && ks.length > 0) {
      await this.opts.redis
        .unlink(...ks.map((k) => this.opts.keys.k('key', k.hash)))
        .catch(() => undefined);
    }
    await this.opts.bus?.publish({ type: 'team', slug: t.slug });
  }

  // -------------------------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------------------------

  private validateRoutes(routes: string[] | null | undefined): void {
    if (!routes) return;
    const cfg = this.opts.config();
    const unknown = routes.filter((r) => !cfg.routes[r] && !cfg.models[r]);
    if (unknown.length > 0)
      throw new GatewayError(
        400,
        'invalid_request',
        `Unknown routes in allowed_routes: ${unknown.join(', ')}`,
        {
          param: 'allowed_routes',
        },
      );
  }

  async createKey(actor: string, teamIdOrSlug: string, input: CreateKeyInput): Promise<CreatedKey> {
    const t = await this.findTeam(teamIdOrSlug);
    this.validateRoutes(input.allowed_routes);
    const plaintext = generateApiKey();
    const expiresAt = input.expires_at
      ? new Date(input.expires_at)
      : input.expires_in_days
        ? new Date(this.now().getTime() + input.expires_in_days * 86_400_000)
        : null;
    const row = await this.db.transaction(async (tx) => {
      const [k] = await tx
        .insert(apiKeys)
        .values({
          teamId: t.id,
          name: input.name,
          keyPrefix: keyPrefix(plaintext),
          keyHash: hashKey(plaintext),
          allowedRoutes: input.allowed_routes ?? null,
          rpmLimit: input.rpm_limit ?? null,
          tpmLimit: input.tpm_limit ?? null,
          metadata: input.metadata ?? {},
          expiresAt,
        })
        .returning();
      await this.audit(tx, actor, 'key.create', k!.id, {
        team: t.slug,
        name: input.name,
        prefix: k!.keyPrefix,
        allowed_routes: input.allowed_routes ?? null,
        expires_at: iso(expiresAt),
      });
      return k!;
    });
    // A negative cache entry may exist if someone probed this exact key before (practically never).
    await this.opts.redis?.unlink(this.opts.keys.k('key', row.keyHash)).catch(() => undefined);
    return { key: plaintext, record: this.keyView(row, t.slug) };
  }

  async listKeys(
    teamIdOrSlug: string,
    opts: { includeRevoked?: boolean } = {},
  ): Promise<KeyView[]> {
    const t = await this.findTeam(teamIdOrSlug, { includeDeleted: true });
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(
        opts.includeRevoked
          ? eq(apiKeys.teamId, t.id)
          : and(eq(apiKeys.teamId, t.id), isNull(apiKeys.revokedAt)),
      )
      .orderBy(desc(apiKeys.createdAt));
    return rows.map((k) => this.keyView(k, t.slug));
  }

  private async findKey(id: string): Promise<{ k: ApiKeyRow; slug: string }> {
    if (!UUID.test(id)) throw new GatewayError(404, 'not_found', `Key ${id} not found`);
    const rows = await this.db
      .select({ k: apiKeys, slug: teams.slug })
      .from(apiKeys)
      .innerJoin(teams, eq(apiKeys.teamId, teams.id))
      .where(eq(apiKeys.id, id))
      .limit(1);
    if (!rows[0]) throw new GatewayError(404, 'not_found', `Key ${id} not found`);
    return rows[0];
  }

  private async invalidateKey(hash: string): Promise<void> {
    await this.opts.redis?.unlink(this.opts.keys.k('key', hash)).catch(() => undefined);
    await this.opts.bus?.publish({ type: 'key', hash });
  }

  async revokeKey(actor: string, id: string): Promise<KeyView> {
    const { k, slug } = await this.findKey(id);
    if (k.revokedAt) return this.keyView(k, slug);
    const row = await this.db.transaction(async (tx) => {
      const [u] = await tx
        .update(apiKeys)
        .set({ revokedAt: dsql`now()` })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning();
      await this.audit(tx, actor, 'key.revoke', id, { team: slug, prefix: k.keyPrefix });
      return u ?? k;
    });
    await this.invalidateKey(k.keyHash);
    return this.keyView(row, slug);
  }

  /**
   * Issues a new key with the same team/name/scope/limits and retires the old one: immediately
   * (default) or after `grace_s` (the old key gets `expires_at = now + grace`).
   */
  async rotateKey(
    actor: string,
    id: string,
    input: RotateKeyInput,
  ): Promise<CreatedKey & { previous: KeyView }> {
    const { k, slug } = await this.findKey(id);
    if (k.revokedAt) throw new GatewayError(409, 'conflict', `Key ${id} is revoked`);
    const plaintext = generateApiKey();
    const { created, previous } = await this.db.transaction(async (tx) => {
      const [n] = await tx
        .insert(apiKeys)
        .values({
          teamId: k.teamId,
          name: k.name,
          keyPrefix: keyPrefix(plaintext),
          keyHash: hashKey(plaintext),
          allowedRoutes: k.allowedRoutes,
          rpmLimit: k.rpmLimit,
          tpmLimit: k.tpmLimit,
          metadata: k.metadata,
          expiresAt: k.expiresAt,
          rotatedFrom: k.id,
        })
        .returning();
      const [old] = await tx
        .update(apiKeys)
        .set(
          input.grace_s > 0
            ? { expiresAt: new Date(this.now().getTime() + input.grace_s * 1000) }
            : { revokedAt: dsql`now()` },
        )
        .where(eq(apiKeys.id, k.id))
        .returning();
      await this.audit(tx, actor, 'key.rotate', k.id, {
        team: slug,
        old_prefix: k.keyPrefix,
        new_id: n!.id,
        new_prefix: n!.keyPrefix,
        grace_s: input.grace_s,
      });
      return { created: n!, previous: old! };
    });
    await this.invalidateKey(k.keyHash);
    return {
      key: plaintext,
      record: this.keyView(created, slug),
      previous: this.keyView(previous, slug),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------------------------

  private async applyBudgets(tx: Executor, teamId: string, input: BudgetsInput): Promise<void> {
    for (const period of ['daily', 'monthly'] as const) {
      const v: BudgetInput | null | undefined = input[period];
      if (v === undefined) continue;
      if (v === null) {
        await tx.delete(budgets).where(and(eq(budgets.teamId, teamId), eq(budgets.period, period)));
        continue;
      }
      const values = {
        limitUsd: v.limit_usd,
        softThreshold: v.soft_threshold,
        action: v.action,
        webhookUrl: v.webhook_url ?? null,
      };
      await tx
        .insert(budgets)
        .values({ teamId, period, ...values })
        .onConflictDoUpdate({
          target: [budgets.teamId, budgets.period],
          set: { ...values, updatedAt: dsql`now()` },
        });
    }
  }

  async setBudgets(
    actor: string,
    teamIdOrSlug: string,
    input: BudgetsInput,
  ): Promise<BudgetView[]> {
    const t = await this.findTeam(teamIdOrSlug);
    await this.db.transaction(async (tx) => {
      await this.applyBudgets(tx, t.id, input);
      await this.audit(tx, actor, 'budgets.set', t.id, { team: t.slug, ...input });
    });
    await this.opts.bus?.publish({ type: 'budgets', slug: t.slug });
    const rows = await this.db.select().from(budgets).where(eq(budgets.teamId, t.id));
    return rows.map((b) => this.budgetView(b)).sort((a, b) => a.period.localeCompare(b.period));
  }

  /** Persisted (Postgres) spend for the current UTC day and month. */
  private async persistedSpend(
    slug: string,
    at: Date,
  ): Promise<{ daily: number; monthly: number }> {
    const m = periodWindow('monthly', at);
    const rows = await this.opts.database.sql<{ daily: number; monthly: number }[]>`
      select coalesce(sum(cost_usd) filter (where day = ${utcDay(at)}::date), 0)::float8 as daily,
             coalesce(sum(cost_usd), 0)::float8 as monthly
      from usage_daily
      where team = ${slug} and day >= ${utcDay(m.start)}::date and day < ${utcDay(m.end)}::date`;
    return { daily: Number(rows[0]?.daily ?? 0), monthly: Number(rows[0]?.monthly ?? 0) };
  }

  async budgetStatus(teamIdOrSlug: string): Promise<TeamBudgetReport> {
    const t = await this.findTeam(teamIdOrSlug);
    const at = this.now();
    const persisted = await this.persistedSpend(t.slug, at);
    let live = { ...persisted };
    if (this.opts.budgets) {
      try {
        const s = await this.opts.budgets.spend(t.slug, at);
        // Redis may be behind Postgres only if counters were lost; report the higher value.
        live = {
          daily: Math.max(s.daily, persisted.daily),
          monthly: Math.max(s.monthly, persisted.monthly),
        };
      } catch {
        // Redis unavailable: Postgres values only.
      }
    }
    const rows = await this.db.select().from(budgets).where(eq(budgets.teamId, t.id));
    const statuses: BudgetStatus[] = rows
      .map((b) => {
        const w = periodWindow(b.period, at);
        const limit = Number(b.limitUsd);
        const soft = Number(b.softThreshold);
        const spent = live[b.period];
        const projected = projectSpend(spent, w, at);
        const utilization = limit > 0 ? spent / limit : spent > 0 ? 1 : 0;
        return {
          period: b.period,
          period_key: w.key,
          period_start: w.start.toISOString(),
          period_end: w.end.toISOString(),
          limit_usd: limit,
          spent_usd: round6(spent),
          remaining_usd: round6(Math.max(0, limit - spent)),
          utilization: round4(utilization),
          projected_usd: round6(projected),
          projected_utilization: round4(limit > 0 ? projected / limit : 0),
          soft_threshold: soft,
          action: b.action,
          status: utilization >= 1 ? 'exceeded' : utilization >= soft ? 'soft' : 'ok',
        } satisfies BudgetStatus;
      })
      .sort((a, b) => a.period.localeCompare(b.period));
    return {
      team: t.slug,
      as_of: at.toISOString(),
      spend: { daily: round6(live.daily), monthly: round6(live.monthly), persisted },
      budgets: statuses,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Usage, cache, audit
  // -------------------------------------------------------------------------------------------

  async usage(q: Partial<UsageQuery> & Pick<UsageQuery, 'groupBy'>): Promise<UsageReport> {
    const now = this.now();
    const from = q.from ?? utcDay(periodWindow('monthly', now).start);
    const to = q.to ?? utcDay(now);
    return queryUsage(this.opts.database, { ...q, from, to });
  }

  /** Purges exact-cache entries (and semantic indexes) by route and/or team scope. */
  async purgeCache(actor: string, input: PurgeInput): Promise<{ deleted: number }> {
    const redis = this.opts.redis;
    if (!redis) throw new GatewayError(503, 'service_unavailable', 'Cache purge requires Redis');
    if (input.route && /[:\s]/.test(input.route))
      throw new GatewayError(400, 'invalid_request', 'Invalid route name', { param: 'route' });
    const route = input.route ? globEscape(input.route) : '*';
    const scope = input.team ? `team:${globEscape(input.team)}` : null;
    let deleted = 0;
    for (const kind of CACHE_KINDS) {
      const pattern = scope
        ? this.opts.keys.k('cache', kind, route, scope, '*')
        : this.opts.keys.k('cache', kind, route, '*');
      deleted += await deleteByPattern(redis, pattern);
    }
    deleted += await deleteByPattern(
      redis,
      scope ? this.opts.keys.k('sem', route, scope, '*') : this.opts.keys.k('sem', route, '*'),
    );
    await this.db.transaction(async (tx) =>
      this.audit(tx, actor, 'cache.purge', input.route ?? null, { ...input, deleted }),
    );
    return { deleted };
  }

  async listAudit(limit = 50): Promise<
    {
      id: number;
      at: string;
      actor: string;
      action: string;
      target: string | null;
      data: Record<string, unknown>;
    }[]
  > {
    const rows = await this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(Math.min(1000, Math.max(1, limit)));
    return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
  }
}

const round6 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : n);
const round4 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : n);
