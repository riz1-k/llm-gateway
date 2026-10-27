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

/** The team (tenant) a key belongs to: unit of budgets, team limits and cost attribution. */
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

/** An authenticated API key (static or database-issued) with its team, scope and limits. */
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

/** Resolves a presented API key to its record (or `null` when unknown/revoked). */
export interface KeyStore {
  /** Returns the key record for a presented bearer token, or null if unknown/revoked/expired. */
  verify(token: string): Promise<ApiKeyRecord | null>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------------

/** What the rate limiter needs for one request: the key, its team and the token estimate. */
export interface RateLimitInput {
  key: ApiKeyRecord;
  route: string;
  /** Pre-flight token estimate (prompt + max completion) reserved against TPM. */
  estimatedTokens: number;
}

/** Result of a rate-limit check, including the `x-ratelimit-*` headers to return. */
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

/**
 * RPM/TPM enforcement per key and team. Reserves the token estimate, then reconciles actual usage.
 */
export interface RateLimiter {
  check(input: RateLimitInput): Promise<RateLimitDecision>;
  /** Adjust TPM reservations by (actual − estimate) after completion. */
  reconcile(decision: RateLimitDecision, actualTokens: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

/** Result of a pre-flight budget check: admitted or rejected with a 402 `budget_exceeded` error. */
export interface BudgetDecision {
  allowed: boolean;
  /** Remaining USD in the tightest period, if known. */
  remainingUsd?: number;
  period?: 'daily' | 'monthly';
  limitUsd?: number;
}

/** Per-team USD budget enforcement: pre-flight check before dispatch, spend recording after. */
export interface BudgetGuard {
  check(input: { team: Team; route: string; preflightCostUsd: number }): Promise<BudgetDecision>;
  record(input: { team: Team; route: string; costUsd: number }): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

/** The cached body: a chat completion, an embedding vector or a rerank response. */
export type CachedPayload =
  | { kind: 'chat'; response: ChatResponse }
  | { kind: 'embedding'; response: EmbeddingResponse }
  | { kind: 'rerank'; response: RerankResponse };

/** A cached response plus the metadata needed to report the hit (provider, model, saved cost). */
export interface CacheEntry {
  payload: CachedPayload;
  provider: string;
  model: string;
  /** Cost of the original request (reported as saved_usd on hits). */
  costUsd: number;
  createdAt: number;
}

/**
 * Response cache backend (exact-match keys). `MemoryCacheStore` for one process, Redis via
 * `createPlatform`.
 */
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

/** One accounted request (tokens, cost, cache, latency, attempts) emitted to the `UsageSink`. */
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

/** Destination for usage events (log, memory, Redis stream → Postgres worker). Must never throw. */
export interface UsageSink {
  /** Must not throw or block the request path. */
  emit(event: UsageEvent): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Pluggable subsystems of the request pipeline. Override any of them via `createGateway({ services
 * })`.
 */
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
