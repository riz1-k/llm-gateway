import { gunzipSync, gzipSync } from 'node:zlib';
import type { Redis } from 'ioredis';
import type { CacheEntry, CacheStore } from '../core/services.js';
import type { Logger } from '../observability/logger.js';
import { noopMetrics, type GatewayMetrics } from '../observability/metrics.js';
import { deleteByPattern, type RedisKeys } from '../platform/redis.js';

/** Values ≥ this size are gzip'd; smaller ones are stored as plain JSON (gzip header overhead). */
const GZIP_MIN_BYTES = 512;

export function encodeEntry(entry: CacheEntry): Buffer {
  const json = Buffer.from(JSON.stringify(entry), 'utf8');
  return json.length >= GZIP_MIN_BYTES ? gzipSync(json, { level: 6 }) : json;
}

export function decodeEntry(buf: Buffer): CacheEntry {
  const raw = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  return JSON.parse(raw.toString('utf8')) as CacheEntry;
}

export interface RedisCacheStoreOptions {
  redis: Redis;
  keys: RedisKeys;
  logger: Logger;
  metrics?: GatewayMetrics;
  /** Entries larger than this (encoded) are not cached. */
  maxEntryBytes?: number;
}

/**
 * Exact-match response cache in Redis (SPEC §5). Keys come from `cache/keys.ts` (route + scope +
 * sha256 of the canonical request) and are stored under `sy:cache:`. Values are JSON with the
 * response plus metadata (provider, model, original cost, created_at), gzip'd when large.
 */
export class RedisCacheStore implements CacheStore {
  private readonly metrics: GatewayMetrics;
  constructor(private readonly opts: RedisCacheStoreOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
  }

  private rk(key: string): string {
    return this.opts.keys.k('cache', key);
  }

  async get(key: string): Promise<CacheEntry | null> {
    const buf = await this.opts.redis.getBuffer(this.rk(key));
    return buf ? this.decode(key, buf) : null;
  }

  async getMany(keys: string[]): Promise<(CacheEntry | null)[]> {
    if (keys.length === 0) return [];
    const bufs = await this.opts.redis.mgetBuffer(...keys.map((k) => this.rk(k)));
    return bufs.map((b, i) => (b ? this.decode(keys[i]!, b) : null));
  }

  async set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    const buf = encodeEntry(entry);
    if (buf.length > (this.opts.maxEntryBytes ?? 4 * 1024 * 1024)) return;
    await this.opts.redis.set(this.rk(key), buf, 'EX', Math.max(1, Math.floor(ttlSeconds)));
  }

  async setMany(items: { key: string; entry: CacheEntry; ttlSeconds: number }[]): Promise<void> {
    if (items.length === 0) return;
    const p = this.opts.redis.pipeline();
    for (const it of items) {
      p.set(this.rk(it.key), encodeEntry(it.entry), 'EX', Math.max(1, Math.floor(it.ttlSeconds)));
    }
    await p.exec();
  }

  async exists(key: string): Promise<boolean> {
    return (await this.opts.redis.exists(this.rk(key))) === 1;
  }

  /** Deletes entries whose key starts with `prefix` (all entries when omitted). */
  async purge(prefix?: string): Promise<number> {
    const safe = (prefix ?? '').replace(/[*?[\]\\]/g, (c) => `\\${c}`);
    return deleteByPattern(this.opts.redis, `${this.rk(safe)}*`);
  }

  private decode(key: string, buf: Buffer): CacheEntry | null {
    try {
      return decodeEntry(buf);
    } catch (err) {
      this.metrics.platformError('cache');
      this.opts.logger.warn({ err: (err as Error).message, key }, 'corrupt cache entry dropped');
      void this.opts.redis.unlink(this.rk(key)).catch(() => undefined);
      return null;
    }
  }
}
