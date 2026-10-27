import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { ResolvedConfig } from '../config/resolve.js';
import { GatewayError } from '../core/errors.js';
import type { ApiKeyRecord, KeyStore, Team } from '../core/services.js';
import type { Database } from '../db/client.js';
import { apiKeys, teams } from '../db/schema.js';
import type { Logger } from '../observability/logger.js';
import { noopMetrics, type GatewayMetrics } from '../observability/metrics.js';
import type { InvalidationBus } from '../platform/invalidation.js';
import type { RedisKeys } from '../platform/redis.js';
import { hashKey, isGeneratedKeyFormat, StaticKeyStore } from './keys.js';

/** Key record as cached (JSON-serializable). */
interface CachedKey {
  rec: ApiKeyRecord;
  /** Epoch ms, or null. */
  expiresAt: number | null;
}

const NEGATIVE = '-';
const NEGATIVE_TTL_S = 10;

export interface PlatformKeyStoreOptions {
  database: Database;
  redis: Redis | undefined;
  keys: RedisKeys;
  bus: InvalidationBus | undefined;
  config: () => ResolvedConfig;
  logger: Logger;
  metrics?: GatewayMetrics;
  clock?: () => number;
  /** last_used_at flush period (default 30 s). */
  lastUsedFlushMs?: number;
}

/**
 * Virtual keys from Postgres with a two-level cache (SPEC §5 step 2):
 *
 *   per-process map (`auth.local_key_cache_ttl_ms`, default 5 s)
 *     → Redis `sy:key:{sha256}` (`auth.key_cache_ttl_s`, default 60 s; misses cached 10 s)
 *       → Postgres (`api_keys ⋈ teams`, not revoked, not expired, team not deleted)
 *
 * Revocation/rotation deletes the Redis entry and broadcasts on the invalidation bus, so every
 * replica drops its local copy immediately; TTLs bound staleness if a message is lost.
 *
 * Static bootstrap keys (`auth.static_keys`) are checked first. If a DB team with the same slug
 * exists, the static key is attributed to it (team id + team limits), so seeded budgets and
 * reports apply to static keys too.
 *
 * `last_used_at` is updated asynchronously in batches (one UPDATE per flush).
 */
export class PlatformKeyStore implements KeyStore {
  private readonly local = new Map<string, { value: CachedKey | null; at: number }>();
  private readonly teamCache = new Map<string, { team: Team | null; at: number }>();
  private readonly lastUsed = new Map<string, number>();
  private readonly metrics: GatewayMetrics;
  private readonly clock: () => number;
  private staticStore: { cfg: ResolvedConfig; store: StaticKeyStore } | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly opts: PlatformKeyStoreOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
    this.clock = opts.clock ?? Date.now;
    this.unsubscribe = opts.bus?.on((msg) => {
      if (msg.type === 'key') this.local.delete(msg.hash);
      else if (msg.type === 'team') {
        this.teamCache.delete(msg.slug);
        this.local.clear();
      } else if (msg.type === 'all') {
        this.local.clear();
        this.teamCache.clear();
      }
    });
    this.flushTimer = setInterval(() => void this.flushLastUsed(), opts.lastUsedFlushMs ?? 30_000);
    this.flushTimer.unref();
  }

  private get auth() {
    return this.opts.config().raw.auth;
  }

  private statics(): StaticKeyStore {
    const cfg = this.opts.config();
    if (this.staticStore?.cfg !== cfg) {
      this.staticStore = { cfg, store: new StaticKeyStore(cfg.raw.auth.static_keys) };
    }
    return this.staticStore.store;
  }

  private redisKey(hash: string): string {
    return this.opts.keys.k('key', hash);
  }

  async verify(token: string): Promise<ApiKeyRecord | null> {
    const hash = hashKey(token);
    const now = this.clock();
    const ttlLocal = this.auth.local_key_cache_ttl_ms;
    const hit = this.local.get(hash);
    if (hit && now - hit.at < ttlLocal) return this.accept(hit.value, now);

    const fromStatic = await this.statics().verify(token);
    if (fromStatic) {
      const team = await this.teamBySlug(fromStatic.team.slug);
      const rec: ApiKeyRecord = team ? { ...fromStatic, team } : fromStatic;
      const value: CachedKey = { rec, expiresAt: null };
      this.remember(hash, value, now);
      return rec;
    }

    // Database keys are always `sk-sy-` + 40 base62 (generateApiKey). Anything else cannot match,
    // so unauthenticated garbage never costs a Redis round trip, a negative-cache entry or a query.
    if (!isGeneratedKeyFormat(token)) {
      this.remember(hash, null, now);
      return null;
    }

    let value: CachedKey | null | undefined = await this.fromRedis(hash);
    if (value === undefined) {
      value = await this.fromDb(hash);
      void this.toRedis(hash, value);
    }
    this.remember(hash, value, now);
    return this.accept(value, now);
  }

  private remember(hash: string, value: CachedKey | null, now: number): void {
    this.local.set(hash, { value, at: now });
    if (this.local.size > 50_000) {
      // Drop the oldest half; Map iteration order is insertion order.
      let n = 0;
      for (const k of this.local.keys()) {
        if (n++ > 25_000) break;
        this.local.delete(k);
      }
    }
  }

  private accept(value: CachedKey | null, now: number): ApiKeyRecord | null {
    if (!value) return null;
    if (value.expiresAt !== null && value.expiresAt <= now) return null;
    if (value.rec.source === 'db') this.lastUsed.set(value.rec.id, now);
    return value.rec;
  }

  private async fromRedis(hash: string): Promise<CachedKey | null | undefined> {
    if (!this.opts.redis) return undefined;
    try {
      const raw = await this.opts.redis.get(this.redisKey(hash));
      if (raw === null) return undefined;
      if (raw === NEGATIVE) return null;
      return JSON.parse(raw) as CachedKey;
    } catch (err) {
      this.metrics.platformError('keys');
      this.opts.logger.debug({ err: (err as Error).message }, 'key cache read failed');
      return undefined;
    }
  }

  private async toRedis(hash: string, value: CachedKey | null): Promise<void> {
    if (!this.opts.redis) return;
    try {
      if (value) {
        let ttl = this.auth.key_cache_ttl_s;
        if (value.expiresAt !== null)
          ttl = Math.max(1, Math.min(ttl, Math.ceil((value.expiresAt - this.clock()) / 1000)));
        await this.opts.redis.set(this.redisKey(hash), JSON.stringify(value), 'EX', ttl);
      } else {
        await this.opts.redis.set(this.redisKey(hash), NEGATIVE, 'EX', NEGATIVE_TTL_S);
      }
    } catch {
      this.metrics.platformError('keys');
    }
  }

  private async fromDb(hash: string): Promise<CachedKey | null> {
    try {
      const rows = await this.opts.database.db
        .select({ k: apiKeys, t: teams })
        .from(apiKeys)
        .innerJoin(teams, eq(apiKeys.teamId, teams.id))
        .where(
          and(
            eq(apiKeys.keyHash, hash),
            isNull(apiKeys.revokedAt),
            isNull(teams.deletedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`)),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const { k, t } = row;
      return {
        rec: {
          id: k.id,
          name: k.name,
          prefix: k.keyPrefix,
          team: {
            id: t.id,
            slug: t.slug,
            name: t.name,
            rpmLimit: t.rpmLimit ?? undefined,
            tpmLimit: t.tpmLimit ?? undefined,
          },
          allowedRoutes: k.allowedRoutes ?? undefined,
          allowDirectModels: false,
          rpmLimit: k.rpmLimit ?? undefined,
          tpmLimit: k.tpmLimit ?? undefined,
          source: 'db',
        },
        expiresAt: k.expiresAt ? k.expiresAt.getTime() : null,
      };
    } catch (err) {
      this.metrics.platformError('keys');
      this.opts.logger.error({ err: (err as Error).message }, 'key lookup failed');
      // An infrastructure failure must not look like a bad key to clients.
      throw new GatewayError(
        503,
        'service_unavailable',
        'Key verification temporarily unavailable',
        {
          cause: err,
        },
      );
    }
  }

  /** DB team for a slug (cached 60 s), used to attribute static keys. */
  private async teamBySlug(slug: string): Promise<Team | null> {
    const now = this.clock();
    const hit = this.teamCache.get(slug);
    if (hit && now - hit.at < 60_000) return hit.team;
    let team: Team | null = null;
    try {
      const rows = await this.opts.database.db
        .select()
        .from(teams)
        .where(and(eq(teams.slug, slug), isNull(teams.deletedAt)))
        .limit(1);
      const t = rows[0];
      team = t
        ? {
            id: t.id,
            slug: t.slug,
            name: t.name,
            rpmLimit: t.rpmLimit ?? undefined,
            tpmLimit: t.tpmLimit ?? undefined,
          }
        : null;
    } catch (err) {
      // Static keys keep working without the database.
      this.metrics.platformError('keys');
      this.opts.logger.debug({ err: (err as Error).message }, 'team lookup failed');
    }
    this.teamCache.set(slug, { team, at: now });
    return team;
  }

  /** Writes buffered last_used_at timestamps (one statement). */
  async flushLastUsed(): Promise<number> {
    if (this.lastUsed.size === 0) return 0;
    const batch = [...this.lastUsed.entries()];
    this.lastUsed.clear();
    const values = batch.map(([id, ts]) => ({ id, ts: new Date(ts).toISOString() }));
    try {
      await this.opts.database.sql`
        update api_keys as k set last_used_at = greatest(k.last_used_at, v.ts::timestamptz)
        from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as v(id uuid, ts text)
        where k.id = v.id`;
      return batch.length;
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error).message }, 'last_used_at flush failed');
      return 0;
    }
  }

  async close(): Promise<void> {
    clearInterval(this.flushTimer);
    this.unsubscribe?.();
    await this.flushLastUsed();
  }
}
