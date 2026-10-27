/**
 * switchyard-gateway — public library API.
 *
 * ```ts
 * import { createGateway, loadConfig } from 'switchyard-gateway';
 * const gateway = createGateway({ config: loadConfig('gateway.yaml') });
 * export default gateway.app; // a Hono app
 * ```
 */
export { createGateway, type CreateGatewayOptions, type Gateway } from './app.js';
export { startServer, type RunningServer, type StartServerOptions } from './server.js';
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
export * from './core/types.js';
export {
  GatewayError,
  ProviderError,
  type GatewayErrorCode,
  type ProviderErrorCode,
} from './core/errors.js';
export type {
  ApiKeyRecord,
  BudgetDecision,
  BudgetGuard,
  CacheEntry,
  CacheStore,
  GatewayServices,
  KeyStore,
  RateLimitDecision,
  RateLimiter,
  Team,
  UsageEvent,
  UsageSink,
} from './core/services.js';
export type { AttemptRecord } from './core/router.js';
export type { RoutingStrategy } from './core/strategies.js';
export type {
  AdapterDeps,
  AttemptContext,
  ProviderAdapter,
  ProviderHealth,
} from './providers/base.js';
export type { AdapterFactory } from './providers/registry.js';
export { StaticKeyStore, ChainedKeyStore, hashKey } from './auth/keys.js';
export { NoopRateLimiter } from './limits/ratelimit.js';
export { NoopBudgetGuard } from './limits/budgets.js';
export { NoopCacheStore, MemoryCacheStore } from './cache/store.js';
export { canonicalJSON, chatCacheKey } from './cache/keys.js';
export { NoopUsageSink, MemoryUsageSink, LogUsageSink, CompositeUsageSink } from './usage/sinks.js';
export { computeCost, estimateCost, formatUsd } from './usage/pricing.js';
export {
  MemoryBreakerStore,
  type BreakerDecision,
  type BreakerSnapshot,
  type BreakerState,
  type BreakerStore,
  type CircuitState,
} from './resilience/circuit-breaker.js';
export { createLogger, type Logger } from './observability/logger.js';
