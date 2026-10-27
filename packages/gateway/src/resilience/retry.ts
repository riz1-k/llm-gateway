import type { RetryConfig } from '../config/schema.js';

export type Random = () => number;

/**
 * Delay before retry number `retryIndex` (0 = first retry) using exponential backoff with full
 * jitter: `random(0, min(max_backoff, backoff * 2^retryIndex))`.
 *
 * If the upstream sent Retry-After, the delay is at least that long. Returns `null` when the
 * Retry-After exceeds `max_retry_after_ms` (the caller should fall back instead of waiting).
 */
export function computeBackoff(
  retryIndex: number,
  cfg: RetryConfig,
  retryAfterMs?: number,
  random: Random = Math.random,
): number | null {
  if (retryAfterMs !== undefined) {
    if (retryAfterMs > cfg.max_retry_after_ms) return null;
  }
  const ceiling = Math.min(cfg.max_backoff_ms, cfg.backoff_ms * 2 ** Math.max(0, retryIndex));
  const jittered = Math.floor(random() * ceiling);
  return retryAfterMs !== undefined ? Math.max(retryAfterMs, jittered) : jittered;
}

/** Whether another attempt fits before the deadline (with a small safety margin). */
export function fitsDeadline(
  delayMs: number,
  deadline: number,
  now: number,
  minAttemptMs = 50,
): boolean {
  return now + delayMs + minAttemptMs < deadline;
}
