import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from '../observability/logger.js';

export type { Redis } from 'ioredis';

export interface RedisClientOptions {
  /** Connection name (CLIENT SETNAME), helps when debugging with CLIENT LIST. */
  name: string;
  connectTimeoutMs?: number;
  /**
   * Per-command timeout. Request-path clients use a short timeout so a hung Redis degrades into
   * fail-open behavior instead of stalling requests. Blocking clients (XREADGROUP, SUBSCRIBE)
   * must not set it.
   */
  commandTimeoutMs?: number;
  logger?: Logger;
}

/**
 * Creates an ioredis client. Keys are prefixed explicitly by callers (`RedisKeys`) rather than via
 * ioredis `keyPrefix`, because prefixes must also apply inside Lua scripts and SCAN patterns.
 */
export function createRedisClient(url: string, opts: RedisClientOptions): Redis {
  const options: RedisOptions = {
    connectionName: `switchyard:${opts.name}`,
    connectTimeout: opts.connectTimeoutMs ?? 5000,
    maxRetriesPerRequest: opts.commandTimeoutMs ? 1 : null,
    enableAutoPipelining: true,
    ...(opts.commandTimeoutMs ? { commandTimeout: opts.commandTimeoutMs } : {}),
    retryStrategy: (times) => Math.min(100 * 2 ** Math.min(times, 6), 5000),
  };
  const client = new Redis(url, options);
  let lastError = 0;
  client.on('error', (err: Error) => {
    // ioredis emits an error per reconnect attempt; log at most every 10 s.
    const now = Date.now();
    if (now - lastError > 10_000) {
      lastError = now;
      opts.logger?.warn({ err: err.message, client: opts.name }, 'redis connection error');
    }
  });
  return client;
}

/** Namespaced key builder (`sy:` by default). */
export class RedisKeys {
  constructor(readonly prefix: string) {}
  k(...parts: (string | number)[]): string {
    return this.prefix + parts.join(':');
  }
}

export async function pingRedis(client: Redis, timeoutMs = 1000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return res === 'PONG';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Deletes keys matching `pattern` with SCAN + UNLINK (never KEYS / FLUSHDB). */
export async function deleteByPattern(client: Redis, pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await client.unlink(...keys);
  } while (cursor !== '0');
  return deleted;
}

export const quitQuietly = async (client: Redis): Promise<void> => {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
};
