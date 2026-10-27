import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * A Lua script executed with EVALSHA (falls back to EVAL once on NOSCRIPT, which also loads it).
 * Scripts declare every key they touch in KEYS.
 */
export class LuaScript {
  readonly sha: string;
  constructor(
    readonly name: string,
    readonly source: string,
  ) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  async run(redis: Redis, keys: string[], args: (string | number)[]): Promise<unknown> {
    try {
      return await redis.evalsha(this.sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (err instanceof Error && err.message.includes('NOSCRIPT')) {
        return redis.eval(this.source, keys.length, ...keys, ...args);
      }
      throw err;
    }
  }
}
