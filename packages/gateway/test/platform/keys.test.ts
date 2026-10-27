import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashKey } from '../../src/auth/keys.js';
import { PlatformKeyStore } from '../../src/auth/db-key-store.js';
import { createDatabase } from '../../src/db/client.js';
import { silentLogger } from '../../src/observability/logger.js';
import { RedisKeys } from '../../src/platform/redis.js';
import { harness, KEY, waitFor, type PlatformHarness } from './helpers.js';

let a: PlatformHarness;
let b: PlatformHarness; // second gateway replica sharing Redis + Postgres

beforeAll(async () => {
  a = await harness('keys', {
    extra: {
      auth: {
        admin_token: 'sk-sy-test-admin-01',
        static_keys: [{ key: KEY, team: 'test', name: 'test' }],
        local_key_cache_ttl_ms: 60_000,
      },
    },
  });
  b = await harness('keys', { shareWith: a });
});
afterAll(async () => {
  await b?.close();
  await a?.close();
});

const chat = (h: PlatformHarness, key: string) =>
  h.request(
    '/v1/chat/completions',
    { model: 'free', messages: [{ role: 'user', content: 'hi' }] },
    { authorization: `Bearer ${key}` },
  );

describe('DB-backed virtual keys', () => {
  it('authenticates a new key, caches it in Redis and attributes usage to the team', async () => {
    await a.platform.admin!.createTeam('test', { slug: 'alpha', rpm_limit: 100 });
    const { key, record } = await a.platform.admin!.createKey('test', 'alpha', {
      name: 'svc',
      allowed_routes: ['free'],
    });
    expect(key).toMatch(/^sk-sy-[0-9A-Za-z]{40}$/);
    expect(record.masked).toBe(`${key.slice(0, 12)}…`);
    const r = await chat(a, key);
    expect(r.status).toBe(200);
    const cached = await a.redis.get(`${a.ns.prefix}key:${hashKey(key)}`);
    expect(JSON.parse(cached!).rec).toMatchObject({
      id: record.id,
      team: { slug: 'alpha', rpmLimit: 100 },
      source: 'db',
    });
    // Scope enforcement from allowed_routes.
    const denied = await a.request(
      '/v1/chat/completions',
      { model: 'echo', messages: [{ role: 'user', content: 'x' }] },
      { authorization: `Bearer ${key}` },
    );
    expect(denied.status).toBe(403);
  });

  it('revocation takes effect immediately on every replica (pub/sub + cache delete)', async () => {
    const { key, record } = await a.platform.admin!.createKey('test', 'alpha', {
      name: 'revoke-me',
    });
    expect((await chat(a, key)).status).toBe(200);
    expect((await chat(b, key)).status).toBe(200); // b now has it in its local cache (TTL 60 s)
    await a.platform.admin!.revokeKey('test', record.id);
    await waitFor(async () => (await chat(b, key)).status === 401, 2000);
    expect((await chat(a, key)).status).toBe(401);
    expect(await a.redis.get(`${a.ns.prefix}key:${hashKey(key)}`)).not.toContain(record.id);
  });

  it('rotation issues a working key and retires the old one (with optional grace)', async () => {
    const { key, record } = await a.platform.admin!.createKey('test', 'alpha', { name: 'rot' });
    expect((await chat(b, key)).status).toBe(200);
    const r = await a.platform.admin!.rotateKey('test', record.id, { grace_s: 0 });
    expect(r.record.rotated_from).toBe(record.id);
    expect(r.previous.status).toBe('revoked');
    await waitFor(async () => (await chat(b, key)).status === 401, 2000);
    expect((await chat(b, r.key)).status).toBe(200);
    const g = await a.platform.admin!.rotateKey('test', r.record.id, { grace_s: 3600 });
    expect(g.previous.status).toBe('active');
    expect((await chat(a, r.key)).status).toBe(200); // still valid during grace
    expect((await chat(a, g.key)).status).toBe(200);
  });

  it('rejects unknown and expired keys (negative cache)', async () => {
    expect((await chat(a, 'sk-sy-doesnotexist0000000000000000000000000000')).status).toBe(401);
    await waitFor(
      async () =>
        (await a.redis.get(
          `${a.ns.prefix}key:${hashKey('sk-sy-doesnotexist0000000000000000000000000000')}`,
        )) === '-',
    );
    const { key } = await a.platform.admin!.createKey('test', 'alpha', {
      name: 'expired',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await chat(a, key)).status).toBe(401);
  });

  it('attributes static keys to the DB team with the same slug', async () => {
    await a.platform.admin!.createTeam('test', { slug: 'test', tpm_limit: 12345 });
    await a.platform.redis!.publish(`${a.ns.prefix}invalidate`, JSON.stringify({ type: 'all' }));
    const store = a.gateway.services.keys;
    await waitFor(async () => (await store.verify(KEY))?.team.tpmLimit === 12345, 2000);
    const rec = await store.verify(KEY);
    expect(rec?.source).toBe('static');
    expect(rec?.team.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('flushes last_used_at in batches', async () => {
    const { key, record } = await a.platform.admin!.createKey('test', 'alpha', { name: 'lu' });
    await chat(a, key);
    await (a.gateway.services.keys as PlatformKeyStore).flushLastUsed();
    const keys = await a.platform.admin!.listKeys('alpha');
    expect(keys.find((k) => k.id === record.id)?.last_used_at).not.toBeNull();
  });

  it('returns 503 (not 401) when the database is unreachable', async () => {
    const broken = createDatabase('postgres://dev:dev@127.0.0.1:1/none', { max: 1 });
    const store = new PlatformKeyStore({
      database: broken,
      redis: undefined,
      keys: new RedisKeys('sy:t:none:'),
      bus: undefined,
      config: () => a.config,
      logger: silentLogger(),
    });
    await expect(
      store.verify('sk-sy-whatever00000000000000000000000000000000'),
    ).rejects.toMatchObject({ status: 503 });
    expect(await store.verify(KEY)).toMatchObject({ source: 'static' }); // static keys still work
    // Malformed credentials can never be DB keys: rejected without touching Postgres (SR-08).
    expect(await store.verify('not-a-key')).toBeNull();
    expect(await store.verify('sk-sy-short')).toBeNull();
    await store.close();
    await broken.close();
  });

  it('does not cache or look up malformed keys (SR-08)', async () => {
    const bogus = `sk-sy-${'x'.repeat(41)}`;
    expect((await chat(a, bogus)).status).toBe(401);
    expect(await a.redis.get(`${a.ns.prefix}key:${hashKey(bogus)}`)).toBeNull();
  });
});
