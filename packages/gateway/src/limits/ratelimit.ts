import type { RateLimitDecision, RateLimitInput, RateLimiter } from '../core/services.js';

/**
 * Default rate limiter: allows everything. Wave H replaces it with the Redis sliding-window Lua
 * implementation (key + team scopes, RPM + TPM, reservation reconciliation).
 */
export class NoopRateLimiter implements RateLimiter {
  async check(_input: RateLimitInput): Promise<RateLimitDecision> {
    return { allowed: true, headers: {} };
  }
  async reconcile(_decision: RateLimitDecision, _actualTokens: number): Promise<void> {}
}
