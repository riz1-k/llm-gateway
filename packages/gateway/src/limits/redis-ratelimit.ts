import type { ResolvedConfig } from '../config/resolve.js';
import { GatewayError } from '../core/errors.js';
import type { RateLimitDecision, RateLimitInput, RateLimiter } from '../core/services.js';
import type { Logger } from '../observability/logger.js';
import { noopMetrics, type GatewayMetrics } from '../observability/metrics.js';
import type { Redis } from 'ioredis';
import type { RedisKeys } from '../platform/redis.js';
import { RATE_CHECK, RATE_RECONCILE } from './lua.js';

export type LimitScope = 'key' | 'team';
export type LimitKind = 'rpm' | 'tpm';

interface LimitSpec {
  scope: LimitScope;
  kind: LimitKind;
  redisKey: string;
  limit: number;
  cost: number;
}

export interface LimitState {
  scope: LimitScope;
  kind: LimitKind;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
}

interface Reservation {
  window: number;
  estimate: number;
  tpmKeys: string[];
}

export interface RedisRateLimiterOptions {
  redis: Redis;
  keys: RedisKeys;
  config: () => ResolvedConfig;
  logger: Logger;
  metrics?: GatewayMetrics;
  failOpen?: boolean;
  /** Test hook: fixed clock in ms (default: Redis server time). */
  now?: () => number;
}

/** OpenAI-style duration: `850ms`, `12s`, `1m30s`. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${Math.ceil(ms)}ms`;
  const totalS = Math.ceil(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

/** Picks the most constrained of several limits (lowest remaining, then key before team). */
function tightest(states: LimitState[]): LimitState | undefined {
  return [...states].sort((a, b) => a.remaining - b.remaining)[0];
}

export function rateLimitHeaders(states: LimitState[]): Record<string, string> {
  const h: Record<string, string> = {};
  const req = tightest(states.filter((s) => s.kind === 'rpm'));
  const tok = tightest(states.filter((s) => s.kind === 'tpm'));
  if (req) {
    h['x-ratelimit-limit-requests'] = String(req.limit);
    h['x-ratelimit-remaining-requests'] = String(req.remaining);
    h['x-ratelimit-reset-requests'] = formatDuration(req.resetMs);
  }
  if (tok) {
    h['x-ratelimit-limit-tokens'] = String(tok.limit);
    h['x-ratelimit-remaining-tokens'] = String(tok.remaining);
    h['x-ratelimit-reset-tokens'] = formatDuration(tok.resetMs);
  }
  return h;
}

/**
 * RPM + TPM sliding-window limits at key and team scope (SPEC §8), one atomic EVALSHA per request.
 *
 * Limit resolution: key scope = key record override → `limits.defaults.key`; team scope = team
 * record override → `limits.defaults.team`. A missing limit is not enforced.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly metrics: GatewayMetrics;
  private lastErrorLog = 0;

  constructor(private readonly opts: RedisRateLimiterOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
  }

  private windowMs(): number {
    return (this.opts.config().raw.limits?.window_s ?? 60) * 1000;
  }

  private specs(input: RateLimitInput): LimitSpec[] {
    const defaults = this.opts.config().raw.limits?.defaults;
    const { key } = input;
    const team = key.team;
    const k = this.opts.keys;
    const candidates: (Omit<LimitSpec, 'limit'> & { limit: number | undefined })[] = [
      {
        scope: 'key',
        kind: 'rpm',
        redisKey: k.k('rl', 'key', key.id, 'rpm'),
        limit: key.rpmLimit ?? defaults?.key?.rpm,
        cost: 1,
      },
      {
        scope: 'key',
        kind: 'tpm',
        redisKey: k.k('rl', 'key', key.id, 'tpm'),
        limit: key.tpmLimit ?? defaults?.key?.tpm,
        cost: Math.max(0, Math.ceil(input.estimatedTokens)),
      },
      {
        scope: 'team',
        kind: 'rpm',
        redisKey: k.k('rl', 'team', team.slug, 'rpm'),
        limit: team.rpmLimit ?? defaults?.team?.rpm,
        cost: 1,
      },
      {
        scope: 'team',
        kind: 'tpm',
        redisKey: k.k('rl', 'team', team.slug, 'tpm'),
        limit: team.tpmLimit ?? defaults?.team?.tpm,
        cost: Math.max(0, Math.ceil(input.estimatedTokens)),
      },
    ];
    return candidates.filter((c): c is LimitSpec => c.limit !== undefined && c.limit > 0);
  }

  async check(input: RateLimitInput): Promise<RateLimitDecision> {
    const specs = this.specs(input);
    if (specs.length === 0) return { allowed: true, headers: {} };
    const args: (string | number)[] = [
      this.opts.now ? this.opts.now() : '',
      this.windowMs(),
      specs.length,
    ];
    for (const s of specs) args.push(s.limit, s.cost);
    let reply: number[];
    try {
      reply = (await RATE_CHECK.run(
        this.opts.redis,
        specs.map((s) => s.redisKey),
        args,
      )) as number[];
    } catch (err) {
      return this.onError(err);
    }
    const allowed = reply[0] === 1;
    const window = reply[2]!;
    const states: LimitState[] = specs.map((s, i) => ({
      scope: s.scope,
      kind: s.kind,
      limit: s.limit,
      remaining: reply[3 + i * 3]!,
      resetMs: reply[4 + i * 3]!,
      retryAfterMs: reply[5 + i * 3]!,
    }));
    const headers = rateLimitHeaders(states);
    if (allowed) {
      const tpm = specs.filter((s) => s.kind === 'tpm');
      const reservation: Reservation = {
        window,
        estimate: Math.max(0, Math.ceil(input.estimatedTokens)),
        tpmKeys: tpm.map((s) => s.redisKey),
      };
      return { allowed: true, headers, reservation };
    }
    // Reject: report the limit that needs the longest wait (all failing limits must clear).
    const failing = states.filter((s) => s.retryAfterMs !== 0);
    const worst = [...failing].sort(
      (a, b) => waitOf(b, this.windowMs()) - waitOf(a, this.windowMs()),
    )[0]!;
    // sy_ratelimit_rejections_total is recorded by the pipeline (one place for every limiter).
    return {
      allowed: false,
      headers,
      retryAfterMs: waitOf(worst, this.windowMs()),
      rejectedBy: `${worst.scope}:${worst.kind}`,
    };
  }

  async reconcile(decision: RateLimitDecision, actualTokens: number): Promise<void> {
    const r = decision.reservation as Reservation | undefined;
    if (!r || r.tpmKeys.length === 0) return;
    const delta = Math.max(0, Math.ceil(actualTokens)) - r.estimate;
    if (delta === 0) return;
    try {
      await RATE_RECONCILE.run(this.opts.redis, r.tpmKeys, [r.window, delta]);
    } catch (err) {
      this.logError(err, 'rate limit reconciliation failed');
    }
  }

  private onError(err: unknown): RateLimitDecision {
    this.logError(err, 'rate limiter unavailable');
    if (this.opts.failOpen === false) {
      throw new GatewayError(503, 'service_unavailable', 'Rate limiter unavailable', {
        cause: err,
      });
    }
    return { allowed: true, headers: {} };
  }

  private logError(err: unknown, msg: string): void {
    this.metrics.platformError('ratelimit');
    const now = Date.now();
    if (now - this.lastErrorLog > 10_000) {
      this.lastErrorLog = now;
      this.opts.logger.error({ err: err instanceof Error ? err.message : String(err) }, msg);
    }
  }
}

const waitOf = (s: LimitState, windowMs: number): number =>
  s.retryAfterMs < 0 ? windowMs : s.retryAfterMs;
