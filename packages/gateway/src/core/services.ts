/**
 * Pluggable subsystem interfaces. The core ships no-op / in-memory implementations; wave H plugs
 * in Postgres/Redis-backed ones without touching the pipeline.
 *
 * Pipeline order (core/pipeline.ts):
 *   auth(KeyStore) → validate → resolve route → estimate → RateLimiter.check → BudgetGuard.check
 *   → CacheStore.get → dispatch (router, BreakerStore) → account: cost → RateLimiter.reconcile
 *   → BudgetGuard.record → CacheStore.set → UsageSink.emit
 */
import type { SemanticIndex } from '../cache/semantic.js';
import type { BreakerStore } from '../resilience/circuit-breaker.js';
import type { ChatResponse, EmbeddingResponse, OperationKind, RerankResponse } from './types.js';

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

export interface Team {
  /** DB uuid, or `team:<slug>` for static keys whose team has no DB row. */
  id: string;
  /** Immutable, unique; usage, budgets and rate-limit counters are keyed by slug. */
  slug: string;
  name: string;
  /** Team-scope limit overrides (fall back to `limits.defaults.team`). */
  rpmLimit?: number | undefined;
  tpmLimit?: number | undefined;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** First 12 chars, safe to log. */
  prefix: string;
  team: Team;
  /** Route names this key may call; undefined = all. */
  allowedRoutes: string[] | undefined;
  allowDirectModels: boolean;
  rpmLimit: number | undefined;
  tpmLimit: number | undefined;
  source: 'static' | 'db';
}

export interface KeyStore {
  /** Returns the key record for a presented bearer token, or null if unknown/revoked/expired. */
  verify(token: string): Promise<ApiKeyRecord | null>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------------

export interface RateLimitInput {
  key: ApiKeyRecord;
  route: string;
  /** Pre-flight token estimate (prompt + max completion) reserved against TPM. */
  estimatedTokens: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** `x-ratelimit-*` headers for the tightest scope. */
  headers: Record<string, string>;
  retryAfterMs?: number;
  /** Which limit rejected the request, e.g. `key:rpm`. */
  rejectedBy?: string;
  /** Opaque reservation handle passed back to reconcile(). */
  reservation?: unknown;
}

export interface RateLimiter {
  check(input: RateLimitInput): Promise<RateLimitDecision>;
  /** Adjust TPM reservations by (actual − estimate) after completion. */
  reconcile(decision: RateLimitDecision, actualTokens: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

export interface BudgetDecision {
  allowed: boolean;
  /** Remaining USD in the tightest period, if known. */
  remainingUsd?: number;
  period?: 'daily' | 'monthly';
  limitUsd?: number;
}

export interface BudgetGuard {
  check(input: { team: Team; route: string; preflightCostUsd: number }): Promise<BudgetDecision>;
  record(input: { team: Team; route: string; costUsd: number }): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

export type CachedPayload =
  | { kind: 'chat'; response: ChatResponse }
  | { kind: 'embedding'; response: EmbeddingResponse }
  | { kind: 'rerank'; response: RerankResponse };

export interface CacheEntry {
  payload: CachedPayload;
  provider: string;
  model: string;
  /** Cost of the original request (reported as saved_usd on hits). */
  costUsd: number;
  createdAt: number;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void>;
  /** Batched lookup (per-item embedding cache). Falls back to parallel get() when absent. */
  getMany?(keys: string[]): Promise<(CacheEntry | null)[]>;
  setMany?(items: { key: string; entry: CacheEntry; ttlSeconds: number }[]): Promise<void>;
  purge?(prefix?: string): Promise<number>;
}

// ---------------------------------------------------------------------------------------------
// Usage events
// ---------------------------------------------------------------------------------------------

export interface UsageEvent {
  ts: string;
  request_id: string;
  team_id: string;
  team: string;
  key_id: string;
  route: string;
  kind: OperationKind;
  provider: string | null;
  model: string | null;
  status: number;
  error_code: string | null;
  cache: 'hit' | 'miss' | 'bypass' | 'semantic-hit';
  stream: boolean;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  saved_usd: number;
  latency_ms: number;
  ttft_ms: number | null;
  attempts: number;
  fallbacks: number;
  end_user: string | null;
  tags: string[];
}

export interface UsageSink {
  /** Must not throw or block the request path. */
  emit(event: UsageEvent): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export interface GatewayServices {
  keys: KeyStore;
  rateLimiter: RateLimiter;
  budgets: BudgetGuard;
  cache: CacheStore;
  usage: UsageSink;
  breakers: BreakerStore;
  /** Vector index for the semantic cache (opt-in per route); absent = semantic cache off. */
  semantic?: SemanticIndex | undefined;
}
