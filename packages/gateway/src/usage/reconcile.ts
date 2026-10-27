import type { Redis } from 'ioredis';
import type { Database } from '../db/client.js';
import { periodWindow, utcDay } from '../limits/periods.js';
import type { RedisBudgetGuard } from '../limits/redis-budgets.js';
import { streamLag } from './stream.js';

export interface ReconcileResult {
  drained: boolean;
  teams: number;
  adjusted: { team: string; period: string; before: number; after: number }[];
}

/**
 * Budget reconciliation (SPEC §9): Postgres rollups are authoritative.
 *
 * Redis counters are raised to the Postgres value whenever they are lower (increments lost, e.g.
 * Redis restarted). They are lowered only when the usage pipeline is drained (no lag, nothing
 * pending), because otherwise Redis legitimately holds spend that is still in the stream.
 */
export async function reconcileBudgets(opts: {
  database: Database;
  redis: Redis;
  guard: RedisBudgetGuard;
  stream: string;
  group: string;
  now?: Date;
}): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const lag = await streamLag(opts.redis, opts.stream, opts.group);
  const drained = lag !== null && lag.lag === 0 && lag.pending === 0;
  const month = periodWindow('monthly', now);
  const today = utcDay(now);
  const { sql } = opts.database;
  const rows = await sql<{ team: string; daily: number; monthly: number }[]>`
    with spend as (
      select team,
        coalesce(sum(cost_usd) filter (where day = ${today}::date), 0)::float8 as daily,
        coalesce(sum(cost_usd), 0)::float8 as monthly
      from usage_daily
      where day >= ${utcDay(month.start)}::date and day < ${utcDay(month.end)}::date
      group by team
    ), budgeted as (
      select distinct t.slug as team from budgets b join teams t on t.id = b.team_id
      where t.deleted_at is null
    )
    select coalesce(s.team, b.team) as team, coalesce(s.daily, 0) as daily, coalesce(s.monthly, 0) as monthly
    from spend s full outer join budgeted b on b.team = s.team`;
  const adjusted: ReconcileResult['adjusted'] = [];
  for (const r of rows) {
    const res = await opts.guard.reconcile(
      r.team,
      { daily: Number(r.daily), monthly: Number(r.monthly) },
      { allowDecrease: drained, at: now },
    );
    for (const period of ['daily', 'monthly'] as const) {
      const { before, after } = res[period];
      if (Math.abs(before - after) > 1e-9) adjusted.push({ team: r.team, period, before, after });
    }
  }
  return { drained, teams: rows.length, adjusted };
}
