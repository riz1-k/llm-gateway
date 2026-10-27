import type { CacheEntry, CacheStore } from '../core/services.js';

/** Default cache: never hits. Wave H adds the Redis exact + semantic caches. */
export class NoopCacheStore implements CacheStore {
  async get(_key: string): Promise<CacheEntry | null> {
    return null;
  }
  async set(_key: string, _entry: CacheEntry, _ttlSeconds: number): Promise<void> {}
}

/**
 * Bounded in-memory LRU cache with TTL. Useful for single-process dev setups and tests of the
 * pipeline's cache wiring; not shared across replicas.
 */
export class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, { entry: CacheEntry; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 1000,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(key: string): Promise<CacheEntry | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.clock()) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, hit); // refresh LRU position
    return hit.entry;
  }

  async set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    this.map.delete(key);
    this.map.set(key, { entry, expiresAt: this.clock() + ttlSeconds * 1000 });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  async purge(prefix?: string): Promise<number> {
    let n = 0;
    for (const k of [...this.map.keys()]) {
      if (!prefix || k.startsWith(prefix)) {
        this.map.delete(k);
        n++;
      }
    }
    return n;
  }
}
