import { describe, expect, it } from 'vitest';
import { redactConfig } from '../../src/admin/routes.js';
import {
  API_KEY_PREFIX,
  generateApiKey,
  hashKey,
  isGeneratedKeyFormat,
  keyPrefix,
} from '../../src/auth/keys.js';
import { decodeEntry, encodeEntry } from '../../src/cache/redis-cache.js';
import { semanticQuery } from '../../src/cache/semantic.js';
import type { CacheEntry } from '../../src/core/services.js';
import { elapsedFraction, periodWindow, projectSpend, utcDay } from '../../src/limits/periods.js';
import {
  formatDuration,
  rateLimitHeaders,
  type LimitState,
} from '../../src/limits/redis-ratelimit.js';
import { parseEntry } from '../../src/usage/worker.js';
import { monthsOf } from '../../src/usage/writer.js';
import { table } from '../../src/cli/commands.js';

describe('API key generation', () => {
  it('produces sk-sy- + 40 base62 chars', () => {
    const k = generateApiKey();
    expect(k).toMatch(/^sk-sy-[0-9A-Za-z]{40}$/);
    expect(k.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(isGeneratedKeyFormat(k)).toBe(true);
    expect(keyPrefix(k)).toHaveLength(12);
    expect(hashKey(k)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is unique and roughly uniform over the alphabet (no modulo bias)', () => {
    const counts = new Map<string, number>();
    const keys = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const k = generateApiKey();
      keys.add(k);
      for (const ch of k.slice(6)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(keys.size).toBe(2000);
    expect(counts.size).toBe(62);
    const expected = (2000 * 40) / 62; // ≈ 1290
    for (const n of counts.values()) expect(Math.abs(n - expected) / expected).toBeLessThan(0.2);
  });
});

describe('rate limit headers', () => {
  const st = (
    scope: 'key' | 'team',
    kind: 'rpm' | 'tpm',
    limit: number,
    remaining: number,
  ): LimitState => ({
    scope,
    kind,
    limit,
    remaining,
    resetMs: 30_000,
    retryAfterMs: 0,
  });

  it('reports the tightest scope per kind', () => {
    const h = rateLimitHeaders([
      st('key', 'rpm', 10, 7),
      st('team', 'rpm', 100, 3),
      st('key', 'tpm', 1000, 900),
    ]);
    expect(h['x-ratelimit-limit-requests']).toBe('100');
    expect(h['x-ratelimit-remaining-requests']).toBe('3');
    expect(h['x-ratelimit-limit-tokens']).toBe('1000');
    expect(h['x-ratelimit-remaining-tokens']).toBe('900');
    expect(h['x-ratelimit-reset-requests']).toBe('30s');
  });

  it('formats durations like OpenAI', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(1500)).toBe('2s');
    expect(formatDuration(90_000)).toBe('1m30s');
  });
});

describe('budget periods (UTC)', () => {
  const at = new Date('2026-10-27T18:00:00Z');
  it('computes daily and monthly windows', () => {
    const d = periodWindow('daily', at);
    expect(d.key).toBe('20261027');
    expect(d.start.toISOString()).toBe('2026-10-27T00:00:00.000Z');
    expect(d.end.toISOString()).toBe('2026-10-28T00:00:00.000Z');
    const m = periodWindow('monthly', at);
    expect(m.key).toBe('202610');
    expect(m.end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(periodWindow('monthly', new Date('2026-12-31T23:59:59Z')).end.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(utcDay(at)).toBe('2026-10-27');
  });

  it('projects spend linearly', () => {
    const d = periodWindow('daily', at);
    expect(elapsedFraction(d, at)).toBeCloseTo(0.75, 6);
    expect(projectSpend(3, d, at)).toBeCloseTo(4, 6);
  });
});

describe('cache entry encoding', () => {
  const entry = (text: string): CacheEntry => ({
    payload: {
      kind: 'chat',
      response: {
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
      },
    },
    provider: 'p',
    model: 'm',
    costUsd: 0.0012,
    createdAt: 1,
  });

  it('stores small values as JSON and large ones gzip-compressed', () => {
    const small = encodeEntry(entry('hi'));
    expect(small[0]).toBe('{'.charCodeAt(0));
    const big = encodeEntry(entry('lorem ipsum '.repeat(500)));
    expect([big[0], big[1]]).toEqual([0x1f, 0x8b]);
    expect(big.length).toBeLessThan(1000);
    expect(decodeEntry(big)).toEqual(entry('lorem ipsum '.repeat(500)));
    expect(decodeEntry(small)).toEqual(entry('hi'));
  });
});

describe('semantic query scoping', () => {
  it('embeds the last user message and scopes by everything else', () => {
    const a = semanticQuery({
      model: 'r',
      messages: [
        { role: 'system', content: 'S1' },
        { role: 'user', content: 'Q?' },
      ],
    });
    const b = semanticQuery({
      model: 'r',
      messages: [
        { role: 'system', content: 'S2' },
        { role: 'user', content: 'Q?' },
      ],
    });
    const c = semanticQuery({
      model: 'r',
      messages: [
        { role: 'system', content: 'S1' },
        { role: 'user', content: 'Other' },
      ],
    });
    expect(a?.text).toBe('Q?');
    expect(a?.scope).not.toBe(b?.scope);
    expect(a?.scope).toBe(c?.scope);
  });

  it('rejects tool requests and non-user tails', () => {
    expect(
      semanticQuery({
        model: 'r',
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      }),
    ).toBeNull();
    expect(
      semanticQuery({ model: 'r', messages: [{ role: 'assistant', content: 'x' }] }),
    ).toBeNull();
  });
});

describe('admin config redaction', () => {
  it('removes secrets and URL passwords', () => {
    const r = redactConfig({
      database: { url: 'postgres://dev:secret@localhost:5432/db' },
      auth: {
        admin_token: 'sk-sy-admin',
        static_keys: [{ key: 'sk-sy-dev-docsqa-123', team: 'docsqa' }],
      },
      providers: {
        openai: { api_key: 'sk-live', base_url: 'https://api.openai.com/v1' },
        oc: { password: 'pw' },
      },
    }) as Record<string, Record<string, unknown>>;
    const json = JSON.stringify(r);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('sk-live');
    expect(json).not.toContain('"pw"');
    expect(json).not.toContain('sk-sy-admin');
    expect(json).toContain('sk-sy-dev-do…');
    expect(json).toContain('https://api.openai.com/v1');
  });
});

describe('usage stream parsing', () => {
  it('accepts valid events and rejects malformed ones', () => {
    const ok = parseEntry([
      'e',
      JSON.stringify({
        ts: '2026-10-27T00:00:00.000Z',
        request_id: 'r1',
        team: 't',
        route: 'x',
        cost_usd: 1,
      }),
    ]);
    expect(ok?.request_id).toBe('r1');
    expect(ok?.cost_usd).toBe(1);
    expect(ok?.tags).toEqual([]);
    expect(parseEntry(['e', '{not json'])).toBeNull();
    expect(
      parseEntry(['e', JSON.stringify({ ts: 'nope', request_id: 'r', team: 't', route: 'x' })]),
    ).toBeNull();
    expect(parseEntry(['other', '{}'])).toBeNull();
  });

  it('derives the UTC months of a batch', () => {
    const ev = (ts: string) => ({ ts }) as never;
    expect(
      monthsOf([
        ev('2026-10-31T23:59:59.000Z'),
        ev('2026-11-01T00:00:00.000Z'),
        ev('2026-10-02T00:00:00.000Z'),
      ]).sort(),
    ).toEqual(['2026-10-01', '2026-11-01']);
  });
});

describe('cli table', () => {
  it('aligns columns and renders nulls/arrays', () => {
    const t = table([
      { a: 'x', b: null, c: ['r1', 'r2'] },
      { a: 'longer', b: 2, c: [] },
    ]);
    expect(t.split('\n')).toEqual([
      'a       b  c',
      '------  -  -----',
      'x       -  r1,r2',
      'longer  2  -',
    ]);
  });
});
