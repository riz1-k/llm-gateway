import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { createGateway, type Gateway } from '../../src/app.js';
import type { ResolvedConfig } from '../../src/config/resolve.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { silentLogger } from '../../src/observability/logger.js';
import { PromMetrics } from '../../src/observability/metrics.js';
import { createPlatform, type Platform, type PlatformOptions } from '../../src/platform/index.js';
import { deleteByPattern } from '../../src/platform/redis.js';
import { ADMIN, KEY, testConfig } from '../helpers.js';

/**
 * Platform test infrastructure.
 *
 * - Redis: db 1 ONLY (db 0 belongs to the running dev gateway). Never FLUSHDB: every test file
 *   uses its own key prefix and stream name, removed afterwards with SCAN + UNLINK.
 * - Postgres: database `llmgateway_test`, one schema per test file (migrations applied into it),
 *   dropped afterwards.
 */
export const REDIS_URL = process.env.SWITCHYARD_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1';
export const PG_URL =
  process.env.SWITCHYARD_TEST_DATABASE_URL ?? 'postgres://dev:dev@127.0.0.1:5432/llmgateway_test';

if (/\/0$/.test(REDIS_URL) || !/\/\d+$/.test(REDIS_URL)) {
  throw new Error(`refusing to run platform tests against Redis db 0 (${REDIS_URL})`);
}

export const rand = (n = 4): string => randomBytes(n).toString('hex');

export function newRedis(): Redis {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });
}

/** Unique namespace for one test file / scenario. */
export interface Namespace {
  prefix: string;
  stream: string;
  schema: string;
}

export function namespace(label: string): Namespace {
  const id = `${label}_${rand()}`;
  return { prefix: `sy:t:${id}:`, stream: `sy:t:${id}:usage`, schema: `t_${id}`.toLowerCase() };
}

export async function cleanupRedis(redis: Redis, ns: Namespace): Promise<void> {
  await deleteByPattern(redis, `${ns.prefix}*`);
}

export async function migratedDatabase(schema: string): Promise<Database> {
  const db = createDatabase(PG_URL, { schema, max: 4 });
  await runMigrations(db);
  return db;
}

export async function dropSchema(db: Database): Promise<void> {
  await db.sql`drop schema if exists ${db.sql(db.schemaName)} cascade`;
}

/** Routes/models used across platform tests (mock provider, priced so costs are non-zero). */
export const PRICED = { input: 1000, output: 2000 }; // USD per 1M tokens → $0.001 / $0.002 per token

export function platformConfig(ns: Namespace, extra: Record<string, unknown> = {}): ResolvedConfig {
  return testConfig({
    redis: { url: REDIS_URL, key_prefix: ns.prefix },
    database: { url: PG_URL },
    providers: { mock: { type: 'mock', allow_header_faults: true, embedding_dim: 64 } },
    models: {
      'mock-echo': { provider: 'mock', model: 'mock-echo', pricing: PRICED },
      'mock-fixed': { provider: 'mock', model: 'mock-fixed', pricing: PRICED },
      'mock-free': { provider: 'mock', model: 'mock-echo' },
      'mock-embedder': {
        provider: 'mock',
        model: 'mock-embed',
        kind: 'embedding',
        pricing: { input: 100 },
      },
      'mock-reranker': { provider: 'mock', model: 'mock-rerank', kind: 'rerank' },
    },
    routes: {
      echo: { targets: ['mock-echo'], cache: { exact: { ttl_s: 600 } } },
      'echo-nocache': { targets: ['mock-echo'] },
      'echo-shared': { targets: ['mock-echo'], cache: { exact: { ttl_s: 600 }, shared: true } },
      free: { targets: ['mock-free'] },
      fb: { targets: ['mock-echo', 'mock-fixed'], retry: { attempts: 2, backoff_ms: 0 } },
      embed: { targets: ['mock-embedder'], cache: { exact: { ttl_s: 600 } } },
      rerank: { targets: ['mock-reranker'], cache: { exact: { ttl_s: 600 } } },
      sem: {
        targets: ['mock-fixed'],
        cache: {
          semantic: { enabled: true, embed_route: 'embed', min_similarity: 0.9, ttl_s: 600 },
        },
      },
    },
    usage: { stream: ns.stream, batch_size: 100, flush_interval_ms: 50, claim_idle_ms: 200 },
    ...extra,
  });
}

export interface PlatformHarness {
  ns: Namespace;
  config: ResolvedConfig;
  platform: Platform;
  gateway: Gateway;
  metrics: PromMetrics;
  database: Database;
  redis: Redis;
  /** POST/GET with the static test key (or another bearer). */
  request(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    method?: string,
  ): Promise<Response>;
  admin(method: string, path: string, body?: unknown, token?: string): Promise<Response>;
  close(): Promise<void>;
}

export async function harness(
  label: string,
  opts: {
    extra?: Record<string, unknown>;
    platform?: Partial<PlatformOptions>;
    /** Reuse an existing namespace/schema (second "replica"). */
    shareWith?: PlatformHarness;
  } = {},
): Promise<PlatformHarness> {
  const ns = opts.shareWith?.ns ?? namespace(label);
  const database = opts.shareWith?.database ?? (await migratedDatabase(ns.schema));
  const config = opts.shareWith?.config ?? platformConfig(ns, opts.extra);
  const metrics = new PromMetrics({ defaultMetrics: false });
  const platform = createPlatform(config, {
    logger: silentLogger(),
    metrics,
    dbSchema: ns.schema,
    ...opts.platform,
  });
  await platform.start();
  const gateway = createGateway({ config, logger: silentLogger(), platform });
  const redis = newRedis();
  const request = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    method?: string,
  ) =>
    gateway.fetch(
      new Request(`http://gateway.test${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );
  const admin = (method: string, path: string, body?: unknown, token = ADMIN) =>
    gateway.fetch(
      new Request(`http://gateway.test/admin${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );
  return {
    ns,
    config,
    platform,
    gateway,
    metrics,
    database,
    redis,
    request,
    admin,
    async close() {
      await gateway.close();
      if (!opts.shareWith) {
        await cleanupRedis(redis, ns);
        await dropSchema(database);
        await database.close();
      }
      redis.disconnect();
    },
  };
}

export const chatBody = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'echo',
  messages: [{ role: 'user', content }],
  ...extra,
});

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  stepMs = 20,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export { ADMIN, KEY };
