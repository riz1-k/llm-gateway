import type { BreakerConfig } from '../config/schema.js';

/**
 * Circuit breaker per target.
 *
 * The state machine is a set of pure functions over a serializable `BreakerState`, so a Redis
 * implementation of `BreakerStore` (wave H: hash `sy:cb:{target}` + Lua) can reuse it verbatim.
 *
 *   closed ──(failure rate ≥ X% over ≥ N requests in window, or K consecutive failures)──▶ open
 *   open ──(cooldown elapsed; next request becomes the probe)──▶ half_open
 *   half_open ──probe success──▶ closed          half_open ──probe failure──▶ open (cooldown × 2, capped)
 */

export type CircuitState = 'closed' | 'open' | 'half_open';
export type Outcome = 'success' | 'failure' | 'neutral';

interface Bucket {
  /** Epoch second. */
  t: number;
  ok: number;
  fail: number;
}

export interface BreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  /** Consecutive trips without a successful close (drives exponential cooldown). */
  trips: number;
  openedAt: number | null;
  openUntil: number | null;
  probeStartedAt: number | null;
  buckets: Bucket[];
}

export interface BreakerDecision {
  allowed: boolean;
  state: CircuitState;
  /** True if this request is the half-open probe. */
  probe: boolean;
  /** When an open breaker will allow a probe (epoch ms). */
  retryAt?: number;
}

export const initialBreakerState = (): BreakerState => ({
  state: 'closed',
  consecutiveFailures: 0,
  trips: 0,
  openedAt: null,
  openUntil: null,
  probeStartedAt: null,
  buckets: [],
});

function prune(buckets: Bucket[], now: number, windowS: number): Bucket[] {
  const minT = Math.floor(now / 1000) - windowS + 1;
  return buckets.filter((b) => b.t >= minT);
}

function addToWindow(buckets: Bucket[], now: number, ok: boolean): Bucket[] {
  const t = Math.floor(now / 1000);
  const last = buckets[buckets.length - 1];
  if (last && last.t === t) {
    return [
      ...buckets.slice(0, -1),
      { t, ok: last.ok + (ok ? 1 : 0), fail: last.fail + (ok ? 0 : 1) },
    ];
  }
  return [...buckets, { t, ok: ok ? 1 : 0, fail: ok ? 0 : 1 }];
}

export function windowStats(
  state: BreakerState,
  now: number,
  cfg: BreakerConfig,
): { total: number; failures: number; rate: number } {
  const b = prune(state.buckets, now, cfg.window_s);
  const failures = b.reduce((a, x) => a + x.fail, 0);
  const total = b.reduce((a, x) => a + x.ok + x.fail, 0);
  return { total, failures, rate: total === 0 ? 0 : failures / total };
}

function cooldownMs(trips: number, cfg: BreakerConfig): number {
  return Math.min(cfg.max_cooldown_s, cfg.cooldown_s * 2 ** Math.max(0, trips - 1)) * 1000;
}

function open(state: BreakerState, now: number, cfg: BreakerConfig): BreakerState {
  const trips = state.trips + 1;
  return {
    ...state,
    state: 'open',
    trips,
    openedAt: now,
    openUntil: now + cooldownMs(trips, cfg),
    probeStartedAt: null,
  };
}

/** Decide whether a request may pass; may transition open → half_open (claiming the probe). */
export function decide(
  state: BreakerState,
  now: number,
  cfg: BreakerConfig,
): { decision: BreakerDecision; next: BreakerState } {
  if (!cfg.enabled)
    return { decision: { allowed: true, state: 'closed', probe: false }, next: state };
  switch (state.state) {
    case 'closed':
      return { decision: { allowed: true, state: 'closed', probe: false }, next: state };
    case 'open': {
      if (state.openUntil !== null && now < state.openUntil) {
        return {
          decision: { allowed: false, state: 'open', probe: false, retryAt: state.openUntil },
          next: state,
        };
      }
      const next: BreakerState = { ...state, state: 'half_open', probeStartedAt: now };
      return { decision: { allowed: true, state: 'half_open', probe: true }, next };
    }
    case 'half_open': {
      // A probe that never reported back (crashed request) is considered lost after one cooldown.
      const stale =
        state.probeStartedAt !== null &&
        now - state.probeStartedAt > cooldownMs(Math.max(1, state.trips), cfg);
      if (state.probeStartedAt === null || stale) {
        return {
          decision: { allowed: true, state: 'half_open', probe: true },
          next: { ...state, probeStartedAt: now },
        };
      }
      return { decision: { allowed: false, state: 'half_open', probe: false }, next: state };
    }
  }
}

/** Apply the outcome of a request. `probe` marks the half-open probe request. */
export function record(
  state: BreakerState,
  outcome: Outcome,
  now: number,
  cfg: BreakerConfig,
  probe = false,
): BreakerState {
  if (!cfg.enabled) return state;
  if (outcome === 'neutral') {
    return probe && state.state === 'half_open' ? { ...state, probeStartedAt: null } : state;
  }
  const ok = outcome === 'success';
  const buckets = addToWindow(prune(state.buckets, now, cfg.window_s), now, ok);

  if (state.state === 'half_open') {
    if (!probe) return { ...state, buckets };
    if (ok) return { ...initialBreakerState(), buckets: [] };
    return open(
      { ...state, buckets, consecutiveFailures: state.consecutiveFailures + 1 },
      now,
      cfg,
    );
  }
  if (state.state === 'open') {
    // Late results from requests admitted before the trip: record only.
    return { ...state, buckets };
  }
  if (ok) return { ...state, buckets, consecutiveFailures: 0 };
  const next: BreakerState = {
    ...state,
    buckets,
    consecutiveFailures: state.consecutiveFailures + 1,
  };
  const stats = windowStats(next, now, cfg);
  const tripByRate = stats.total >= cfg.min_requests && stats.rate >= cfg.failure_rate;
  const tripByStreak = next.consecutiveFailures >= cfg.consecutive_failures;
  return tripByRate || tripByStreak ? open(next, now, cfg) : next;
}

export interface BreakerSnapshot {
  target: string;
  state: CircuitState;
  consecutiveFailures: number;
  trips: number;
  openUntil: number | null;
  window: { total: number; failures: number; rate: number };
}

/**
 * Storage for breaker state. In-memory now; a Redis implementation (shared across replicas)
 * plugs in later without changing callers.
 */
export interface BreakerStore {
  acquire(target: string, cfg: BreakerConfig): Promise<BreakerDecision>;
  record(
    target: string,
    outcome: Outcome,
    cfg: BreakerConfig,
    probe?: boolean,
  ): Promise<CircuitState>;
  snapshot(cfg: BreakerConfig): Promise<BreakerSnapshot[]>;
  reset(target?: string): Promise<void>;
}

export class MemoryBreakerStore implements BreakerStore {
  private readonly states = new Map<string, BreakerState>();
  constructor(private readonly clock: () => number = Date.now) {}

  private get(target: string): BreakerState {
    return this.states.get(target) ?? initialBreakerState();
  }

  async acquire(target: string, cfg: BreakerConfig): Promise<BreakerDecision> {
    const { decision, next } = decide(this.get(target), this.clock(), cfg);
    this.states.set(target, next);
    return decision;
  }

  async record(
    target: string,
    outcome: Outcome,
    cfg: BreakerConfig,
    probe = false,
  ): Promise<CircuitState> {
    const next = record(this.get(target), outcome, this.clock(), cfg, probe);
    this.states.set(target, next);
    return next.state;
  }

  async snapshot(cfg: BreakerConfig): Promise<BreakerSnapshot[]> {
    const now = this.clock();
    return [...this.states.entries()].map(([target, s]) => ({
      target,
      state:
        s.state === 'open' && s.openUntil !== null && now >= s.openUntil ? 'half_open' : s.state,
      consecutiveFailures: s.consecutiveFailures,
      trips: s.trips,
      openUntil: s.openUntil,
      window: windowStats(s, now, cfg),
    }));
  }

  async reset(target?: string): Promise<void> {
    if (target) this.states.delete(target);
    else this.states.clear();
  }
}
