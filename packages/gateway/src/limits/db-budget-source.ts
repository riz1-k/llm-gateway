import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { budgets, teams } from '../db/schema.js';
import type { InvalidationBus } from '../platform/invalidation.js';
import type { BudgetDefinition, BudgetSource } from './redis-budgets.js';

/**
 * Budget definitions per team slug from Postgres, cached per process for `ttlMs` and dropped on
 * `budgets` / `team` / `all` invalidation messages (published by the admin API).
 */
export class DbBudgetSource implements BudgetSource {
  private readonly cache = new Map<string, { defs: BudgetDefinition[]; at: number }>();
  private readonly inflight = new Map<string, Promise<BudgetDefinition[]>>();

  constructor(
    private readonly database: Database,
    private readonly ttlMs: () => number,
    bus?: InvalidationBus,
    private readonly clock: () => number = Date.now,
  ) {
    bus?.on((msg) => {
      if (msg.type === 'budgets' || msg.type === 'team') this.cache.delete(msg.slug);
      else if (msg.type === 'all') this.cache.clear();
    });
  }

  invalidate(slug?: string): void {
    if (slug) this.cache.delete(slug);
    else this.cache.clear();
  }

  async forTeam(slug: string): Promise<BudgetDefinition[]> {
    const hit = this.cache.get(slug);
    if (hit && this.clock() - hit.at < this.ttlMs()) return hit.defs;
    // Coalesce concurrent misses for the same team into one query.
    let p = this.inflight.get(slug);
    if (!p) {
      p = this.load(slug).finally(() => this.inflight.delete(slug));
      this.inflight.set(slug, p);
    }
    return p;
  }

  private async load(slug: string): Promise<BudgetDefinition[]> {
    const rows = await this.database.db
      .select({ b: budgets })
      .from(budgets)
      .innerJoin(teams, eq(budgets.teamId, teams.id))
      .where(and(eq(teams.slug, slug), isNull(teams.deletedAt)));
    const defs: BudgetDefinition[] = rows.map(({ b }) => ({
      period: b.period,
      limitUsd: Number(b.limitUsd),
      softThreshold: Number(b.softThreshold),
      action: b.action,
      webhookUrl: b.webhookUrl,
    }));
    this.cache.set(slug, { defs, at: this.clock() });
    return defs;
  }
}
