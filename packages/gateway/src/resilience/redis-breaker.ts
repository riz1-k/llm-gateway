import type { Redis } from 'ioredis';
import type { BreakerConfig } from '../config/schema.js';
import type { Logger } from '../observability/logger.js';
import { noopMetrics, type GatewayMetrics } from '../observability/metrics.js';
import { LuaScript } from '../platform/lua.js';
import type { RedisKeys } from '../platform/redis.js';
import {
  decide,
  initialBreakerState,
  record,
  windowStats,
  type BreakerDecision,
  type BreakerSnapshot,
  type BreakerState,
  type BreakerStore,
  type CircuitState,
  type Outcome,
} from './circuit-breaker.js';

/**
 * Compare-and-set of the serialized state in hash `sy:cb:{target}` field `s`.
 * KEYS[1] hash · ARGV[1] expected JSON ('' = field absent) · ARGV[2] new JSON · ARGV[3] ttl s
 * Reply: 1 if written, 0 if the state changed concurrently.
 */
const CAS = new LuaScript(
  'breaker_cas',
  `
local cur = redis.call('HGET', KEYS[1], 's')
if (cur == false and ARGV[1] == '') or cur == ARGV[1] then
  redis.call('HSET', KEYS[1], 's', ARGV[2])
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  return 1
end
return 0
`,
);

const MAX_CAS_ATTEMPTS = 16;

interface Pending {
  fn: (s: BreakerState) => { next: BreakerState; result: unknown };
  resolve: (v: unknown) => void;
  reject: (err: unknown) => void;
  cfg: BreakerConfig;
}

export interface RedisBreakerStoreOptions {
  redis: Redis;
  keys: RedisKeys;
  logger: Logger;
  metrics?: GatewayMetrics;
  /** How long a locally cached *closed* state may be used without asking Redis (default 1 s). */
  localCacheMs?: number;
  clock?: () => number;
  /** Targets reported by snapshot() even if never used (configured models). */
  knownTargets?: () => string[];
}

/**
 * Circuit breaker state shared by all replicas (SPEC §7). The state machine is the pure
 * `decide`/`record` pair from circuit-breaker.ts; this store only adds storage:
 *
 * - every transition is an optimistic compare-and-set (Lua) on the JSON state, retried on
 *   conflict, so concurrent replicas never lose a failure or double-claim the half-open probe;
 * - a closed breaker is cached locally for `localCacheMs`, so the hot path does not touch Redis
 *   for healthy targets (a trip made by another replica is seen within that window);
 * - if Redis is unavailable the store degrades to a process-local breaker.
 */
export class RedisBreakerStore implements BreakerStore {
  private readonly local = new Map<string, { state: BreakerState; raw: string; at: number }>();
  private readonly fallback = new Map<string, BreakerState>();
  private readonly queues = new Map<string, Pending[]>();
  private readonly metrics: GatewayMetrics;
  private readonly clock: () => number;
  private lastErrorLog = 0;

  constructor(private readonly opts: RedisBreakerStoreOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
    this.clock = opts.clock ?? Date.now;
  }

  private key(target: string): string {
    return this.opts.keys.k('cb', target);
  }

  private ttlSeconds(cfg: BreakerConfig): number {
    return Math.ceil(Math.max(cfg.window_s, cfg.max_cooldown_s) * 2 + 60);
  }

  private async load(target: string): Promise<{ state: BreakerState; raw: string }> {
    const raw = (await this.opts.redis.hget(this.key(target), 's')) ?? '';
    const state = raw ? (JSON.parse(raw) as BreakerState) : initialBreakerState();
    this.local.set(target, { state, raw, at: this.clock() });
    return { state, raw };
  }

  /**
   * Read-modify-write with CAS. Updates for the same target issued concurrently in this process
   * are queued and applied together (in order) in one CAS round, so contention is only between
   * replicas; conflicting rounds are retried with jitter.
   */
  private update<T>(
    target: string,
    cfg: BreakerConfig,
    fn: (s: BreakerState) => { next: BreakerState; result: T },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let q = this.queues.get(target);
      if (!q) {
        q = [];
        this.queues.set(target, q);
      }
      q.push({ fn, resolve: resolve as Pending['resolve'], reject, cfg });
      if (q.length === 1) void this.drain(target);
    });
  }

  private async drain(target: string): Promise<void> {
    const q = this.queues.get(target);
    while (q && q.length > 0) {
      const batch = q.slice();
      const cfg = batch[batch.length - 1]!.cfg;
      try {
        const results = await this.casRound(target, cfg, batch);
        q.splice(0, batch.length);
        batch.forEach((p, i) => p.resolve(results[i]));
      } catch (err) {
        q.splice(0, batch.length);
        batch.forEach((p) => p.reject(err));
      }
    }
    this.queues.delete(target);
  }

  private async casRound(target: string, cfg: BreakerConfig, batch: Pending[]): Promise<unknown[]> {
    for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
      const { state, raw } = await this.load(target);
      let cur = state;
      const results = batch.map((p) => {
        const { next, result } = p.fn(cur);
        cur = next;
        return result;
      });
      const nextRaw = JSON.stringify(cur);
      if (nextRaw === raw) return results;
      const ok = await CAS.run(
        this.opts.redis,
        [this.key(target)],
        [raw, nextRaw, this.ttlSeconds(cfg)],
      );
      if (ok === 1) {
        this.local.set(target, { state: cur, raw: nextRaw, at: this.clock() });
        return results;
      }
      await new Promise((r) => setTimeout(r, Math.random() * 5 * (i + 1)));
    }
    throw new Error(`breaker ${target}: too much contention`);
  }

  async acquire(target: string, cfg: BreakerConfig): Promise<BreakerDecision> {
    if (!cfg.enabled) return { allowed: true, state: 'closed', probe: false };
    const now = this.clock();
    const cached = this.local.get(target);
    if (cached && now - cached.at < (this.opts.localCacheMs ?? 1000)) {
      if (cached.state.state === 'closed') return { allowed: true, state: 'closed', probe: false };
      if (
        cached.state.state === 'open' &&
        cached.state.openUntil !== null &&
        now < cached.state.openUntil
      ) {
        return { allowed: false, state: 'open', probe: false, retryAt: cached.state.openUntil };
      }
    }
    try {
      return await this.update(target, cfg, (s) => {
        const { decision, next } = decide(s, this.clock(), cfg);
        return { next, result: decision };
      });
    } catch (err) {
      this.onError(err);
      const { decision, next } = decide(
        this.fallback.get(target) ?? initialBreakerState(),
        now,
        cfg,
      );
      this.fallback.set(target, next);
      return decision;
    }
  }

  async record(
    target: string,
    outcome: Outcome,
    cfg: BreakerConfig,
    probe = false,
  ): Promise<CircuitState> {
    if (!cfg.enabled) return 'closed';
    try {
      return await this.update(target, cfg, (s) => {
        const next = record(s, outcome, this.clock(), cfg, probe);
        return { next, result: next.state };
      });
    } catch (err) {
      this.onError(err);
      const next = record(
        this.fallback.get(target) ?? initialBreakerState(),
        outcome,
        this.clock(),
        cfg,
        probe,
      );
      this.fallback.set(target, next);
      return next.state;
    }
  }

  async snapshot(cfg: BreakerConfig): Promise<BreakerSnapshot[]> {
    const now = this.clock();
    const targets = new Set([...(this.opts.knownTargets?.() ?? []), ...this.local.keys()]);
    const list = [...targets].sort();
    if (list.length === 0) return [];
    const p = this.opts.redis.pipeline();
    for (const t of list) p.hget(this.key(t), 's');
    const res = (await p.exec()) ?? [];
    return list.map((target, i) => {
      const raw = res[i]?.[1] as string | null | undefined;
      const s = raw ? (JSON.parse(raw) as BreakerState) : initialBreakerState();
      return {
        target,
        state:
          s.state === 'open' && s.openUntil !== null && now >= s.openUntil ? 'half_open' : s.state,
        consecutiveFailures: s.consecutiveFailures,
        trips: s.trips,
        openUntil: s.openUntil,
        window: windowStats(s, now, cfg),
      };
    });
  }

  async reset(target?: string): Promise<void> {
    if (target) {
      this.local.delete(target);
      this.fallback.delete(target);
      await this.opts.redis.unlink(this.key(target));
      return;
    }
    const targets = new Set([...(this.opts.knownTargets?.() ?? []), ...this.local.keys()]);
    this.local.clear();
    this.fallback.clear();
    if (targets.size > 0) await this.opts.redis.unlink(...[...targets].map((t) => this.key(t)));
  }

  private onError(err: unknown): void {
    this.metrics.platformError('breaker');
    const now = Date.now();
    if (now - this.lastErrorLog > 10_000) {
      this.lastErrorLog = now;
      this.opts.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'breaker store degraded to local state',
      );
    }
  }
}
