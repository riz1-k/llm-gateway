import type { BudgetDecision, BudgetGuard, Team } from '../core/services.js';

/** Default budget guard: tracks spend in memory for observability but never blocks. */
export class NoopBudgetGuard implements BudgetGuard {
  private readonly spend = new Map<string, number>();

  async check(_input: {
    team: Team;
    route: string;
    preflightCostUsd: number;
  }): Promise<BudgetDecision> {
    return { allowed: true };
  }

  async record(input: { team: Team; route: string; costUsd: number }): Promise<void> {
    this.spend.set(input.team.slug, (this.spend.get(input.team.slug) ?? 0) + input.costUsd);
  }

  spentUsd(team: string): number {
    return this.spend.get(team) ?? 0;
  }
}
