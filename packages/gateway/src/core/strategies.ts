import type { ResolvedRoute, ResolvedRouteTarget } from '../config/resolve.js';
import type { Random } from '../resilience/retry.js';

/**
 * A routing strategy orders a route's targets for one request. The router walks the order,
 * skipping targets whose breaker is open, so every strategy degrades into fallback.
 */
export interface RoutingStrategy {
  readonly name: ResolvedRoute['strategy'];
  order(route: ResolvedRoute): ResolvedRouteTarget[];
  /** Feedback after each upstream attempt. */
  observe?(route: ResolvedRoute, target: string, latencyMs: number, ok: boolean): void;
}

/** Ordered fallback: targets in configured order. */
export class FallbackStrategy implements RoutingStrategy {
  readonly name = 'fallback' as const;
  order(route: ResolvedRoute): ResolvedRouteTarget[] {
    return route.targets;
  }
}

/**
 * Smooth weighted round-robin (nginx algorithm): deterministic, evenly interleaved picks
 * proportional to weight. Remaining targets follow by weight as fallbacks.
 */
export class WeightedStrategy implements RoutingStrategy {
  readonly name = 'weighted' as const;
  private readonly current = new Map<string, Map<string, number>>();

  order(route: ResolvedRoute): ResolvedRouteTarget[] {
    const cw = this.current.get(route.name) ?? new Map<string, number>();
    this.current.set(route.name, cw);
    const total = route.targets.reduce((a, t) => a + t.weight, 0);
    let best: ResolvedRouteTarget | undefined;
    let bestWeight = -Infinity;
    for (const t of route.targets) {
      const w = (cw.get(t.model) ?? 0) + t.weight;
      cw.set(t.model, w);
      if (w > bestWeight) {
        best = t;
        bestWeight = w;
      }
    }
    if (!best) return [];
    cw.set(best.model, bestWeight - total);
    const rest = route.targets.filter((t) => t !== best).sort((a, b) => b.weight - a.weight);
    return [best, ...rest];
  }
}

/**
 * Least latency: EWMA (α = 0.3) of successful upstream latency per target, ascending. Targets
 * without samples are tried first (exploration); with probability ε a random target leads.
 */
export class LeastLatencyStrategy implements RoutingStrategy {
  readonly name = 'least-latency' as const;
  private readonly ewma = new Map<string, number>();

  constructor(
    private readonly epsilon = 0.05,
    private readonly alpha = 0.3,
    private readonly random: Random = Math.random,
  ) {}

  order(route: ResolvedRoute): ResolvedRouteTarget[] {
    const sorted = [...route.targets].sort(
      (a, b) => (this.ewma.get(a.model) ?? 0) - (this.ewma.get(b.model) ?? 0),
    );
    if (sorted.length > 1 && this.random() < this.epsilon) {
      const i = Math.floor(this.random() * sorted.length);
      const [pick] = sorted.splice(i, 1);
      return [pick!, ...sorted];
    }
    return sorted;
  }

  observe(_route: ResolvedRoute, target: string, latencyMs: number, ok: boolean): void {
    if (!ok) return;
    const prev = this.ewma.get(target);
    this.ewma.set(
      target,
      prev === undefined ? latencyMs : this.alpha * latencyMs + (1 - this.alpha) * prev,
    );
  }

  latency(target: string): number | undefined {
    return this.ewma.get(target);
  }
}

/** Strategy instances live across config reloads so their learned state survives. */
export class StrategyRegistry {
  readonly fallback = new FallbackStrategy();
  readonly weighted = new WeightedStrategy();
  readonly leastLatency: LeastLatencyStrategy;

  constructor(random: Random = Math.random) {
    this.leastLatency = new LeastLatencyStrategy(0.05, 0.3, random);
  }

  get(name: ResolvedRoute['strategy']): RoutingStrategy {
    switch (name) {
      case 'weighted':
        return this.weighted;
      case 'least-latency':
        return this.leastLatency;
      default:
        return this.fallback;
    }
  }

  observe(route: ResolvedRoute, target: string, latencyMs: number, ok: boolean): void {
    // Latency is a property of the target, so always feed the latency model.
    this.leastLatency.observe(route, target, latencyMs, ok);
  }
}
