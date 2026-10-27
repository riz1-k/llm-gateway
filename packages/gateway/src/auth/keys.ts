import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyRecord, KeyStore } from '../core/services.js';
import type { GatewayConfig } from '../config/schema.js';

/** SHA-256 hex digest of an API key (only hashes are stored). */
export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export const keyPrefix = (key: string): string => key.slice(0, 12);

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const API_KEY_PREFIX = 'sk-sy-';
export const API_KEY_RANDOM_CHARS = 40;

/**
 * New virtual key: `sk-sy-` + 40 base62 chars (≈ 238 bits) from the CSPRNG, using rejection
 * sampling so every character is uniformly distributed (no modulo bias).
 */
export function generateApiKey(): string {
  let out = API_KEY_PREFIX;
  while (out.length < API_KEY_PREFIX.length + API_KEY_RANDOM_CHARS) {
    for (const byte of randomBytes(64)) {
      if (byte >= 248) continue; // 248 = 4 × 62
      out += BASE62[byte % 62];
      if (out.length === API_KEY_PREFIX.length + API_KEY_RANDOM_CHARS) break;
    }
  }
  return out;
}

const GENERATED_KEY = new RegExp(`^${API_KEY_PREFIX}[0-9A-Za-z]{${API_KEY_RANDOM_CHARS}}$`);
export const isGeneratedKeyFormat = (key: string): boolean => GENERATED_KEY.test(key);

/** Extracts the presented credential from `Authorization: Bearer …` or `x-api-key`. */
export function extractBearer(headers: Headers): string | undefined {
  const auth = headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  const apiKey = headers.get('x-api-key');
  return apiKey ? apiKey.trim() : undefined;
}

/** Constant-time comparison of two secrets (via their hashes, so lengths need not match). */
export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hashKey(a), 'hex'), Buffer.from(hashKey(b), 'hex'));
}

/**
 * Key store backed by `auth.static_keys` in the config. Only key hashes are held in memory.
 * Wave H adds a Postgres/Redis-backed store and can chain this one for bootstrap keys.
 */
export class StaticKeyStore implements KeyStore {
  private readonly byHash = new Map<string, ApiKeyRecord>();

  constructor(keys: GatewayConfig['auth']['static_keys']) {
    keys.forEach((k, i) => {
      if (!k.key) return;
      const hash = hashKey(k.key);
      this.byHash.set(hash, {
        id: `static:${hash.slice(0, 16)}`,
        name: k.name || `static-${i}`,
        prefix: keyPrefix(k.key),
        team: { id: `team:${k.team}`, slug: k.team, name: k.team },
        allowedRoutes: k.allowed_routes,
        allowDirectModels: k.allow_direct_models,
        rpmLimit: k.rpm,
        tpmLimit: k.tpm,
        source: 'static',
      });
    });
  }

  get size(): number {
    return this.byHash.size;
  }

  async verify(token: string): Promise<ApiKeyRecord | null> {
    return this.byHash.get(hashKey(token)) ?? null;
  }
}

/** Tries several stores in order (e.g. DB keys, then static bootstrap keys). */
export class ChainedKeyStore implements KeyStore {
  constructor(private readonly stores: KeyStore[]) {}
  async verify(token: string): Promise<ApiKeyRecord | null> {
    for (const s of this.stores) {
      const rec = await s.verify(token);
      if (rec) return rec;
    }
    return null;
  }
  async close(): Promise<void> {
    await Promise.all(this.stores.map(async (s) => s.close?.()));
  }
}
