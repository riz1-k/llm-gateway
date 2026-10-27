import type { Pricing } from '../config/schema.js';
import type { Usage } from '../core/types.js';

export interface CostBreakdown {
  costUsd: number;
  inputUsd: number;
  cachedInputUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  requestUsd: number;
  /** False when the model has no pricing entry (cost reported as 0). */
  priced: boolean;
}

const PER_MILLION = 1_000_000;

/**
 * Cost of one request from usage × pricing (USD per 1M tokens).
 * - cached input tokens are billed at `cached_input` (default: `input`)
 * - cache-write tokens are billed at `cache_write` (default: `input`)
 * - reasoning tokens are already part of `completion_tokens` and billed as output
 */
export function computeCost(usage: Usage | undefined, pricing: Pricing | undefined): CostBreakdown {
  const zero: CostBreakdown = {
    costUsd: 0,
    inputUsd: 0,
    cachedInputUsd: 0,
    cacheWriteUsd: 0,
    outputUsd: 0,
    requestUsd: 0,
    priced: pricing !== undefined,
  };
  if (!pricing) return zero;
  const requestUsd = pricing.per_request ?? 0;
  if (!usage) return { ...zero, costUsd: requestUsd, requestUsd };
  const cached = Math.max(0, usage.prompt_tokens_details?.cached_tokens ?? 0);
  const cacheWrite = Math.max(0, usage.prompt_tokens_details?.cache_write_tokens ?? 0);
  const uncached = Math.max(0, usage.prompt_tokens - cached - cacheWrite);
  const inputUsd = (uncached * pricing.input) / PER_MILLION;
  const cachedInputUsd = (cached * (pricing.cached_input ?? pricing.input)) / PER_MILLION;
  const cacheWriteUsd = (cacheWrite * (pricing.cache_write ?? pricing.input)) / PER_MILLION;
  const outputUsd = (Math.max(0, usage.completion_tokens) * pricing.output) / PER_MILLION;
  const costUsd = round(inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd + requestUsd);
  return { costUsd, inputUsd, cachedInputUsd, cacheWriteUsd, outputUsd, requestUsd, priced: true };
}

/** Pre-flight upper bound: estimated prompt at full input price + max completion at output price. */
export function estimateCost(
  promptTokens: number,
  maxCompletionTokens: number,
  pricing: Pricing | undefined,
): number {
  if (!pricing) return 0;
  return round(
    (promptTokens * pricing.input + maxCompletionTokens * pricing.output) / PER_MILLION +
      (pricing.per_request ?? 0),
  );
}

const round = (n: number): number => Math.round(n * 1e10) / 1e10;

/** Header representation: fixed 8 decimals, trailing zeros trimmed (e.g. "0.00042", "0"). */
export function formatUsd(n: number): string {
  if (n === 0) return '0';
  return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}
