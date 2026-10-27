import type { Redis } from 'ioredis';
import type { ResolvedConfig } from '../config/resolve.js';
import { GatewayError } from '../core/errors.js';
import type { BudgetDecision, BudgetGuard, Team } from '../core/services.js';
import type { Logger } from '../observability/logger.js';
import { noopMetrics, type GatewayMetrics } from '../observability/metrics.js';
import { LuaScript } from '../platform/lua.js';
import type { RedisKeys } from '../platform/redis.js';
import { periodWindow, type BudgetPeriod, type PeriodWindow } from './periods.js';

export interface BudgetDefinition {
  period: BudgetPeriod;
  limitUsd: number;
  softThreshold: number;
  action: 'block' | 'alert';
  webhookUrl: string | null;
}

/** Where budget definitions come from (Postgres in production; static in tests). */
export interface BudgetSource {
  forTeam(slug: string): Promise<BudgetDefinition[]>;
  invalidate?(slug?: string): void;
}

export class StaticBudgetSource implements BudgetSource {
  constructor(private readonly map: Record<string, BudgetDefinition[]>) {}
  async forTeam(slug: string): Promise<BudgetDefinition[]> {
    return this.map[slug] ?? [];
  }
  set(slug: string, defs: BudgetDefinition[]): void {
    this.map[slug] = defs;
  }
}

export interface BudgetAlert {
  type: 'budget.soft_threshold' | 'budget.exceeded';
  team: string;
  period: BudgetPeriod;
  period_key: string;
  spent_usd: number;
  limit_usd: number;
  utilization: number;
  soft_threshold: number;
  action: 'block' | 'alert';
  ts: string;
}

export interface RedisBudgetGuardOptions {
  redis: Redis;
  keys: RedisKeys;
  source: BudgetSource;
  config: () => ResolvedConfig;
  logger: Logger;
  metrics?: GatewayMetrics;
  failOpen?: boolean;
  clock?: () => Date;
  /** Webhook transport (tests). */
  fetch?: typeof fetch;
  /** Observes fired alerts (tests, extensions). */
  onAlert?: (alert: BudgetAlert) => void;
}

/**
 * Sets the counter to the Postgres value when that is higher (lost increments, e.g. after a Redis
 * restart) or when `allow_decrease` is set (the usage pipeline is drained, so Postgres is exact).
 * KEYS[1] counter · ARGV[1] authoritative value · ARGV[2] allow_decrease (0|1) · ARGV[3] expire-at (s)
 * Reply: previous value (string).
 */
const RECONCILE = new LuaScript(
  'budget_reconcile',
  `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local pg = tonumber(ARGV[1])
if pg > cur or (ARGV[2] == '1' and pg ~= cur) then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('EXPIREAT', KEYS[1], ARGV[3])
end
return tostring(cur)
`,
);

const DAY_S = 86_400;

/**
 * Per-team daily/monthly USD budgets (SPEC §9).
 *
 * - Spend counters: `sy:budget:{team}:{daily|monthly}:{YYYYMMDD|YYYYMM}` (INCRBYFLOAT, expire one
 *   day after the period ends). Counters are kept for every team, with or without a budget, so
 *   utilization can be shown as soon as a budget is set.
 * - Pre-flight: blocked iff enforcement is `hard`, the budget's action is `block`, the request can
 *   cost money (pre-flight > 0) and `spent + preflight > limit`.
 * - Alerts: crossing `soft_threshold × limit` and crossing `limit` each fire once per team and
 *   period (`SET NX` across replicas): structured log + `sy_budget_alerts_total` + optional webhook.
 * - Postgres rollups are authoritative; the worker calls `reconcile()` periodically.
 */
export class RedisBudgetGuard implements BudgetGuard {
  private readonly metrics: GatewayMetrics;
  private readonly firedLocal = new Set<string>();
  private lastErrorLog = 0;

  constructor(private readonly opts: RedisBudgetGuardOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
  }

  private get settings() {
    const b = this.opts.config().raw.budgets;
    return {
      enforcement: b?.enforcement ?? 'hard',
      webhook: b?.alert_webhook ?? null,
    };
  }

  private now(): Date {
    return this.opts.clock?.() ?? new Date();
  }

  counterKey(team: string, w: PeriodWindow): string {
    return this.opts.keys.k('budget', team, w.period, w.key);
  }

  /** Current spend per period for a team (0 when no counter exists). */
  async spend(team: string, at: Date = this.now()): Promise<Record<BudgetPeriod, number>> {
    const d = periodWindow('daily', at);
    const m = periodWindow('monthly', at);
    const [daily, monthly] = await this.opts.redis.mget(
      this.counterKey(team, d),
      this.counterKey(team, m),
    );
    return { daily: Number(daily ?? 0) || 0, monthly: Number(monthly ?? 0) || 0 };
  }

  async check(input: {
    team: Team;
    route: string;
    preflightCostUsd: number;
  }): Promise<BudgetDecision> {
    const { enforcement } = this.settings;
    if (enforcement === 'off') return { allowed: true };
    try {
      const defs = await this.opts.source.forTeam(input.team.slug);
      if (defs.length === 0) return { allowed: true };
      const spent = await this.spend(input.team.slug);
      let tightest: BudgetDecision | undefined;
      for (const def of defs) {
        const s = spent[def.period];
        this.reportUtilization(input.team.slug, def, s);
        const remaining = Math.max(0, def.limitUsd - s);
        const blocks =
          enforcement === 'hard' &&
          def.action === 'block' &&
          input.preflightCostUsd > 0 &&
          s + input.preflightCostUsd > def.limitUsd;
        if (blocks) {
          // sy_budget_rejections_total is recorded by the pipeline.
          return {
            allowed: false,
            period: def.period,
            limitUsd: def.limitUsd,
            remainingUsd: remaining,
          };
        }
        if (!tightest || remaining < (tightest.remainingUsd ?? Infinity)) {
          tightest = {
            allowed: true,
            period: def.period,
            limitUsd: def.limitUsd,
            remainingUsd: remaining,
          };
        }
      }
      return tightest ?? { allowed: true };
    } catch (err) {
      this.logError(err, 'budget check failed');
      if (this.opts.failOpen === false)
        throw new GatewayError(503, 'service_unavailable', 'Budget service unavailable', {
          cause: err,
        });
      return { allowed: true };
    }
  }

  async record(input: { team: Team; route: string; costUsd: number }): Promise<void> {
    if (!(input.costUsd > 0)) return;
    const at = this.now();
    const slug = input.team.slug;
    const d = periodWindow('daily', at);
    const m = periodWindow('monthly', at);
    try {
      const res = await this.opts.redis
        .multi()
        .incrbyfloat(this.counterKey(slug, d), input.costUsd)
        .expireat(this.counterKey(slug, d), Math.floor(d.end.getTime() / 1000) + DAY_S)
        .incrbyfloat(this.counterKey(slug, m), input.costUsd)
        .expireat(this.counterKey(slug, m), Math.floor(m.end.getTime() / 1000) + DAY_S)
        .exec();
      const daily = Number(res?.[0]?.[1] ?? 0);
      const monthly = Number(res?.[2]?.[1] ?? 0);
      if (this.settings.enforcement === 'off') return;
      const defs = await this.opts.source.forTeam(slug);
      for (const def of defs) {
        const spent = def.period === 'daily' ? daily : monthly;
        const w = def.period === 'daily' ? d : m;
        this.reportUtilization(slug, def, spent);
        if (def.limitUsd > 0 && spent >= def.limitUsd) {
          await this.alertOnce(slug, def, w, spent, 'exceeded');
        } else if (spent >= def.softThreshold * def.limitUsd) {
          await this.alertOnce(slug, def, w, spent, 'soft');
        }
      }
    } catch (err) {
      this.logError(err, 'budget record failed');
    }
  }

  /** Raises (or, when drained, sets) the period counters to the authoritative Postgres values. */
  async reconcile(
    team: string,
    authoritative: Record<BudgetPeriod, number>,
    opts: { allowDecrease: boolean; at?: Date },
  ): Promise<Record<BudgetPeriod, { before: number; after: number }>> {
    const at = opts.at ?? this.now();
    const out = {} as Record<BudgetPeriod, { before: number; after: number }>;
    for (const period of ['daily', 'monthly'] as const) {
      const w = periodWindow(period, at);
      const value = authoritative[period];
      const before = Number(
        await RECONCILE.run(
          this.opts.redis,
          [this.counterKey(team, w)],
          [
            value.toFixed(10),
            opts.allowDecrease ? 1 : 0,
            Math.floor(w.end.getTime() / 1000) + DAY_S,
          ],
        ),
      );
      const after = value > before || (opts.allowDecrease && value !== before) ? value : before;
      out[period] = { before, after };
    }
    return out;
  }

  private reportUtilization(team: string, def: BudgetDefinition, spent: number): void {
    this.metrics.budgetUtilization(
      team,
      def.period,
      def.limitUsd > 0 ? spent / def.limitUsd : spent > 0 ? 1 : 0,
    );
  }

  private async alertOnce(
    team: string,
    def: BudgetDefinition,
    w: PeriodWindow,
    spent: number,
    level: 'soft' | 'exceeded',
  ): Promise<void> {
    const id = `${team}:${w.period}:${w.key}:${level}`;
    if (this.firedLocal.has(id)) return;
    const ttl = Math.max(60, Math.ceil((w.end.getTime() - this.now().getTime()) / 1000) + DAY_S);
    const won = await this.opts.redis.set(
      this.opts.keys.k('budget-alert', id),
      '1',
      'EX',
      ttl,
      'NX',
    );
    this.firedLocal.add(id);
    if (this.firedLocal.size > 10_000) this.firedLocal.clear();
    if (won !== 'OK') return; // another replica (or an earlier process) already alerted
    const alert: BudgetAlert = {
      type: level === 'soft' ? 'budget.soft_threshold' : 'budget.exceeded',
      team,
      period: w.period,
      period_key: w.key,
      spent_usd: round6(spent),
      limit_usd: def.limitUsd,
      utilization: def.limitUsd > 0 ? round6(spent / def.limitUsd) : 1,
      soft_threshold: def.softThreshold,
      action: def.action,
      ts: this.now().toISOString(),
    };
    this.metrics.budgetAlert(team, w.period, level);
    this.opts.logger.warn(
      { alert },
      level === 'soft' ? 'budget soft threshold crossed' : 'budget exceeded',
    );
    this.opts.onAlert?.(alert);
    const url = def.webhookUrl ?? this.settings.webhook;
    if (url) void this.postWebhook(url, alert);
  }

  private async postWebhook(url: string, alert: BudgetAlert): Promise<void> {
    try {
      const res = await (this.opts.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'switchyard-budget-alert' },
        body: JSON.stringify(alert),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok)
        this.opts.logger.warn({ status: res.status, team: alert.team }, 'budget webhook failed');
    } catch (err) {
      this.opts.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'budget webhook failed',
      );
    }
  }

  private logError(err: unknown, msg: string): void {
    this.metrics.platformError('budget');
    const now = Date.now();
    if (now - this.lastErrorLog > 10_000) {
      this.lastErrorLog = now;
      this.opts.logger.error({ err: err instanceof Error ? err.message : String(err) }, msg);
    }
  }
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
