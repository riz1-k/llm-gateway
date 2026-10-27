/**
 * switchyard-gateway — public library API.
 *
 * ```ts
 * import { createGateway, loadConfig } from 'switchyard-gateway';
 *
 * const gateway = createGateway({ config: loadConfig('gateway.yaml') });
 * export default gateway.app; // a Hono app: mount it, or serve gateway.fetch anywhere
 * ```
 *
 * Everything exported here is covered by semver. Other modules inside the package are internal
 * and may change in any release. See docs/LIBRARY.md for embedding guides.
 *
 * @packageDocumentation
 */

// --- Gateway and server ------------------------------------------------------------------------
export { createGateway, type CreateGatewayOptions, type Gateway } from './app.js';
export { startServer, type RunningServer, type StartServerOptions } from './server.js';

// --- Configuration -----------------------------------------------------------------------------
export {
  ConfigError,
  loadConfig,
  loadPricingFile,
  parseConfig,
  parseConfigText,
  type LoadOptions,
} from './config/load.js';
export { interpolate, InterpolationError } from './config/interpolate.js';
export {
  configSchema,
  type CustomProviderConfig,
  type GatewayConfig,
  type GatewayConfigInput,
  type Pricing,
  type ProviderConfig,
} from './config/schema.js';
export type {
  ResolvedConfig,
  ResolvedModel,
  ResolvedRoute,
  ResolvedRouteTarget,
} from './config/resolve.js';

// --- Wire types (OpenAI-shaped) and errors -----------------------------------------------------
export * from './core/types.js';
export {
  GatewayError,
  ProviderError,
  type GatewayErrorCode,
  type ProviderErrorCode,
} from './core/errors.js';

// --- Extension point: provider adapters --------------------------------------------------------
export type {
  AdapterDeps,
  AttemptContext,
  ProviderAdapter,
  ProviderHealth,
} from './providers/base.js';
export type { AdapterFactory } from './providers/registry.js';
export {
  ChunkAccumulator,
  makeChunk,
  makeUsage,
  responseToChunks,
  usageChunk,
  type ChunkMeta,
} from './core/chunks.js';

// --- Extension point: pluggable services -------------------------------------------------------
export type {
  ApiKeyRecord,
  BudgetDecision,
  BudgetGuard,
  CachedPayload,
  CacheEntry,
  CacheStore,
  GatewayServices,
  KeyStore,
  RateLimitDecision,
  RateLimiter,
  RateLimitInput,
  Team,
  UsageEvent,
  UsageSink,
} from './core/services.js';
export { StaticKeyStore, ChainedKeyStore, hashKey, generateApiKey } from './auth/keys.js';
export { NoopRateLimiter } from './limits/ratelimit.js';
export { NoopBudgetGuard } from './limits/budgets.js';
export { NoopCacheStore, MemoryCacheStore } from './cache/store.js';
export { NoopUsageSink, MemoryUsageSink, LogUsageSink, CompositeUsageSink } from './usage/sinks.js';
export {
  MemoryBreakerStore,
  type BreakerDecision,
  type BreakerSnapshot,
  type BreakerState,
  type BreakerStore,
  type CircuitState,
} from './resilience/circuit-breaker.js';
export { PromMetrics, noopMetrics, type GatewayMetrics } from './observability/metrics.js';
export { createLogger, type Logger } from './observability/logger.js';
export {
  startTracing,
  TRACE_ID_HEADER,
  TRACER_NAME,
  type StartTracingOptions,
  type TracingHandle,
} from './observability/tracing.js';
export { computeCost, estimateCost, formatUsd, type CostBreakdown } from './usage/pricing.js';

// --- Platform layer (Redis + Postgres) ---------------------------------------------------------
export {
  createPlatform,
  type Platform,
  type PlatformOptions,
  type ReadinessCheck,
} from './platform/index.js';
export { createDatabase, type Database, type DatabaseOptions } from './db/client.js';
export { runMigrations, migrationsFolder, type MigrationResult } from './db/migrate.js';
export { UsageWorker, type UsageWorkerOptions, type WorkerStats } from './usage/worker.js';
export { AdminService } from './admin/service.js';
export { queryUsage, type GroupBy, type UsageQuery, type UsageReport } from './usage/reports.js';
