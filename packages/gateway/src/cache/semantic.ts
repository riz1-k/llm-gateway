import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ChatRequest } from '../core/types.js';
import { contentToText } from '../limits/estimate.js';
import type { Logger } from '../observability/logger.js';
import { deleteByPattern, type RedisKeys } from '../platform/redis.js';
import { canonicalJSON } from './keys.js';

export interface SemanticMatch {
  /** Element id = exact-cache key of the stored response. */
  element: string;
  /** Cosine similarity in [-1, 1]. */
  similarity: number;
}

/** Vector index used by the semantic cache. */
export interface SemanticIndex {
  search(index: string, vector: number[], minSimilarity: number): Promise<SemanticMatch | null>;
  add(
    index: string,
    vector: number[],
    element: string,
    attrs: Record<string, unknown>,
    ttlSeconds: number,
  ): Promise<void>;
  remove(index: string, element: string): Promise<void>;
  purge?(prefix?: string): Promise<number>;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * What a semantic lookup is about: the embedded text (the last user message) and a scope hash
 * covering everything else that changes the answer — system/developer prompts, earlier turns,
 * response_format and generation settings. Only requests whose scope matches exactly can share a
 * semantically-similar answer. Returns null when the request is not eligible (tools, no user text).
 */
export function semanticQuery(req: ChatRequest): { text: string; scope: string } | null {
  if (req.tools?.length) return null;
  const msgs = req.messages;
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') return null;
  const text = contentToText(last.content ?? null).trim();
  if (!text || (Array.isArray(last.content) && last.content.some((p) => p.type !== 'text')))
    return null;
  const scope = sha256(
    canonicalJSON({
      context: msgs.slice(0, -1),
      response_format: req.response_format,
      max_tokens: req.max_completion_tokens ?? req.max_tokens,
      stop: req.stop,
      reasoning_effort: req.reasoning_effort,
    }),
  ).slice(0, 24);
  return { text, scope };
}

const toFp32 = (v: number[]): Buffer => {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i]!, i * 4);
  return buf;
};

/**
 * Semantic index on Redis 8 vector sets (`VADD … SETATTR`, `VSIM … WITHSCORES`), one set per
 * route × cache scope × context hash: `sy:sem:{route}:{scope}:{hash}`. Vectors are stored
 * unquantized (NOQUANT) so similarity thresholds are exact.
 *
 * Redis reports VSIM scores as (1 + cosine) / 2; this class converts to and from cosine.
 */
export class RedisVectorIndex implements SemanticIndex {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly logger: Logger,
    private readonly maxEntriesPerIndex = 10_000,
  ) {}

  private rk(index: string): string {
    return this.keys.k('sem', index);
  }

  async search(
    index: string,
    vector: number[],
    minSimilarity: number,
  ): Promise<SemanticMatch | null> {
    const reply = (await this.redis
      .call('VSIM', this.rk(index), 'FP32', toFp32(vector), 'WITHSCORES', 'COUNT', '1')
      .catch((err: unknown) => {
        // Missing key → empty array; a dimension mismatch means the embed model changed.
        if (err instanceof Error && /dimension/i.test(err.message)) return [];
        throw err;
      })) as (string | Buffer)[] | null;
    if (!reply || reply.length < 2) return null;
    const element = String(reply[0]);
    const similarity = 2 * Number(reply[1]) - 1;
    return similarity >= minSimilarity ? { element, similarity } : null;
  }

  async add(
    index: string,
    vector: number[],
    element: string,
    attrs: Record<string, unknown>,
    ttlSeconds: number,
  ): Promise<void> {
    const key = this.rk(index);
    const card = Number(await this.redis.call('VCARD', key));
    if (card >= this.maxEntriesPerIndex) {
      const victim = await this.redis.call('VRANDMEMBER', key);
      if (typeof victim === 'string' && victim) await this.redis.call('VREM', key, victim);
    }
    const vadd = () =>
      this.redis.call(
        'VADD',
        key,
        'FP32',
        toFp32(vector),
        element,
        'NOQUANT',
        'SETATTR',
        JSON.stringify(attrs),
      );
    try {
      await vadd();
    } catch (err) {
      if (err instanceof Error && /dimension/i.test(err.message)) {
        this.logger.warn({ index }, 'semantic index dimension changed; recreating');
        await this.redis.unlink(key);
        await vadd();
      } else {
        throw err;
      }
    }
    await this.redis.expire(key, Math.max(1, Math.floor(ttlSeconds)));
  }

  async remove(index: string, element: string): Promise<void> {
    await this.redis.call('VREM', this.rk(index), element);
  }

  async purge(prefix?: string): Promise<number> {
    const safe = (prefix ?? '').replace(/[*?[\]\\]/g, (c) => `\\${c}`);
    return deleteByPattern(this.redis, `${this.rk(safe)}*`);
  }
}
