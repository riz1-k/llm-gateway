import type { Redis } from 'ioredis';
import { AdminService } from '../admin/service.js';
import { PlatformKeyStore } from '../auth/db-key-store.js';
import { RedisCacheStore } from '../cache/redis-cache.js';
import { RedisVectorIndex } from '../cache/semantic.js';
import type { ResolvedConfig } from '../config/resolve.js';
import type { GatewayServices } from '../core/services.js';
import { createDatabase, type Database } from '../db/client.js';
import { DbBudgetSource } from '../limits/db-budget-source.js';
import { RedisBudgetGuard, type BudgetAlert } from '../limits/redis-budgets.js';
import { RedisRateLimiter } from '../limits/redis-ratelimit.js';
import type { Logger } from '../observability/logger.js';
import { PromMetrics } from '../observability/metrics.js';
import { RedisBreakerStore } from '../resilience/redis-breaker.js';
import { streamLag } from '../usage/stream.js';
import { RedisStreamUsageSink } from '../usage/stream-sink.js';
import { UsageWorker } from '../usage/worker.js';
import { InvalidationBus } from './invalidation.js';
import { createRedisClient, pingRedis, quitQuietly, RedisKeys } from './redis.js';

/** Result of one readiness probe (Redis, Postgres, …) shown by `/readyz`. */
export interface ReadinessCheck {
  ok: boolean;
  detail?: string;
}

/**
 * Everything the Redis/Postgres platform layer adds to a gateway: services for the pipeline,
 * metrics, the admin service, readiness checks and lifecycle. Created from config by
 * `createPlatform()` and handed to `createGateway({ platform })` (startServer does this).
 */
export interface Platform {
  readonly services: Partial<GatewayServices>;
  readonly metrics: PromMetrics | undefined;
  readonly admin: AdminService | undefined;
  readonly redis: Redis | undefined;
  readonly database: Database | undefined;
  readonly keys: RedisKeys;
  readonly budgets: RedisBudgetGuard | undefined;
  readonly worker: UsageWorker | undefined;
  /** Called by the gateway after a config reload (routes, limits, budgets settings). */
  setConfig(config: ResolvedConfig): void;
  /** Connects pub/sub and starts the in-process usage writer (if configured). */
  start(): Promise<void>;
  readiness(): Promise<Record<string, ReadinessCheck>>;
  close(): Promise<void>;
}

/** Options for `createPlatform`. */
export interface PlatformOptions {
  logger: Logger;
  /** Pass a registry to share it (tests), `false` to disable metrics. Default: from config. */
  metrics?: PromMetrics | false;
  /** Postgres schema (tests use one per file). */
  dbSchema?: string;
  /** Overrides `redis.url` / `database.url` (tests). */
  redisUrl?: string;
  databaseUrl?: string;
  onBudgetAlert?: (alert: BudgetAlert) => void;
  /** Which parts to build (CLI admin commands need no usage sink/worker). */
  role?: 'gateway' | 'admin';
}

/**
 * Builds the Redis/Postgres platform layer (keys, limits, budgets, caches, breakers, usage stream,
 * metrics, admin) from config. `startServer` calls it for you.
 */
export function createPlatform(config: ResolvedConfig, opts: PlatformOptions): Platform {
  let current = config;
  const cfg = (): ResolvedConfig => current;
  const { logger } = opts;
  const raw = config.raw;
  const role = opts.role ?? 'gateway';
  const keys = new RedisKeys(raw.redis?.key_prefix ?? 'sy:');

  const metricsEnabled = raw.metrics.enabled && raw.observability.metrics;
  const metrics =
    opts.metrics === false
      ? undefined
      : (opts.metrics ??
        (metricsEnabled
          ? new PromMetrics({ defaultMetrics: raw.metrics.default_metrics })
          : undefined));

  const redisUrl = opts.redisUrl ?? raw.redis?.url;
  const databaseUrl = opts.databaseUrl ?? raw.database?.url;
  const failOpen = raw.redis?.fail_open ?? true;
  const connectTimeoutMs = raw.redis?.connect_timeout_ms ?? 5000;

  const redis = redisUrl
    ? createRedisClient(redisUrl, { name: role, connectTimeoutMs, commandTimeoutMs: 2000, logger })
    : undefined;
  const subscriber =
    redisUrl && databaseUrl && role === 'gateway'
      ? createRedisClient(redisUrl, { name: 'sub', connectTimeoutMs, logger })
      : undefined;
  const database = databaseUrl
    ? createDatabase(databaseUrl, {
        max: role === 'admin' ? 2 : (raw.database?.pool_max ?? 10),
        applicationName: `switchyard-${role}`,
        ...(opts.dbSchema ? { schema: opts.dbSchema } : {}),
      })
    : undefined;
  const bus = redis
    ? new InvalidationBus(redis, subscriber, keys.k('invalidate'), logger)
    : undefined;

  const services: Partial<GatewayServices> = {};
  let budgets: RedisBudgetGuard | undefined;

  if (database) {
    services.keys = new PlatformKeyStore({
      database,
      redis,
      keys,
      bus,
      config: cfg,
      logger: logger.child({ component: 'keys' }),
      ...(metrics ? { metrics } : {}),
    });
  }
  if (redis) {
    services.rateLimiter = new RedisRateLimiter({
      redis,
      keys,
      config: cfg,
      logger: logger.child({ component: 'ratelimit' }),
      ...(metrics ? { metrics } : {}),
      failOpen,
    });
    services.cache = new RedisCacheStore({ redis, keys, logger, ...(metrics ? { metrics } : {}) });
    services.semantic = new RedisVectorIndex(redis, keys, logger);
    services.breakers = new RedisBreakerStore({
      redis,
      keys,
      logger,
      ...(metrics ? { metrics } : {}),
      knownTargets: () => Object.keys(cfg().models),
    });
    if (role === 'gateway') {
      services.usage = new RedisStreamUsageSink({
        redis,
        stream: raw.usage?.stream ?? 'sy:usage',
        maxLen: raw.usage?.stream_maxlen ?? 1_000_000,
        bufferMax: raw.usage?.buffer_max ?? 10_000,
        batchSize: raw.usage?.batch_size ?? 500,
        logger: logger.child({ component: 'usage' }),
        ...(metrics ? { metrics } : {}),
      });
    }
    if (database) {
      budgets = new RedisBudgetGuard({
        redis,
        keys,
        source: new DbBudgetSource(
          database,
          () => cfg().raw.budgets?.definitions_ttl_ms ?? 30_000,
          bus,
        ),
        config: cfg,
        logger: logger.child({ component: 'budgets' }),
        ...(metrics ? { metrics } : {}),
        failOpen,
        ...(opts.onBudgetAlert ? { onAlert: opts.onBudgetAlert } : {}),
      });
      services.budgets = budgets;
    }
  }

  const admin = database
    ? new AdminService({
        database,
        redis,
        keys,
        bus,
        budgets,
        config: cfg,
        logger: logger.child({ component: 'admin' }),
      })
    : undefined;

  let workerClient: Redis | undefined;
  let worker: UsageWorker | undefined;
  if (role === 'gateway' && raw.usage?.in_process_writer && redisUrl && database) {
    workerClient = createRedisClient(redisUrl, { name: 'worker', connectTimeoutMs, logger });
    worker = new UsageWorker({
      redis: workerClient,
      database,
      stream: raw.usage.stream,
      group: raw.usage.consumer_group,
      batchSize: raw.usage.batch_size,
      blockMs: raw.usage.flush_interval_ms,
      claimIdleMs: raw.usage.claim_idle_ms,
      retentionDays: raw.usage.retention_days,
      partitionsAhead: raw.usage.partitions_ahead,
      logger: logger.child({ component: 'worker' }),
      ...(budgets
        ? { budgets, reconcileIntervalMs: (raw.budgets?.reconcile_interval_s ?? 300) * 1000 }
        : {}),
    });
  }

  if (metrics && redis) {
    const stream = raw.usage?.stream ?? 'sy:usage';
    const group = raw.usage?.consumer_group ?? 'writers';
    metrics.setSources({ streamLag: () => streamLag(redis, stream, group) });
  }

  return {
    services,
    metrics,
    admin,
    redis,
    database,
    keys,
    budgets,
    worker,
    setConfig(next) {
      current = next;
    },
    async start() {
      if (bus)
        await bus
          .start()
          .catch((err: unknown) =>
            logger.warn({ err: (err as Error).message }, 'invalidation subscribe failed'),
          );
      if (worker) {
        await worker
          .start()
          .catch((err: unknown) =>
            logger.error(
              { err: (err as Error).message },
              'in-process usage writer failed to start',
            ),
          );
      }
    },
    async readiness() {
      const checks: Record<string, ReadinessCheck> = {};
      const [r, d] = await Promise.all([
        redis ? pingRedis(redis, 1000) : Promise.resolve(undefined),
        database ? database.ping(2000) : Promise.resolve(undefined),
      ]);
      if (r !== undefined) checks.redis = r ? { ok: true } : { ok: false, detail: 'ping failed' };
      if (d !== undefined)
        checks.postgres = d ? { ok: true } : { ok: false, detail: 'query failed' };
      return checks;
    },
    async close() {
      await worker?.stop();
      await services.usage?.close?.();
      await services.keys?.close?.();
      await Promise.all(
        [redis, subscriber, workerClient].filter((c): c is Redis => !!c).map(quitQuietly),
      );
      await database?.close();
    },
  };
}
