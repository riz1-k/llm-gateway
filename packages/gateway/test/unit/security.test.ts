/**
 * Regression tests for the pre-release security review (docs/SECURITY_REVIEW.md). Each block
 * names the finding it pins down.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { redactConfig } from '../../src/admin/routes.js';
import { chatCacheKey } from '../../src/cache/keys.js';
import { semanticQuery } from '../../src/cache/semantic.js';
import { ProviderError, toGatewayError } from '../../src/core/errors.js';
import type { ChatRequest } from '../../src/core/types.js';
import {
  countTokens,
  estimatePromptTokens,
  estimateTextTokens,
  initTokenizer,
} from '../../src/limits/estimate.js';
import type { RateLimiter } from '../../src/core/services.js';
import { isSafePattern, SchemaValidator } from '../../src/util/json-schema.js';
import { ADMIN, testConfig, testGateway } from '../helpers.js';

const elapsed = (fn: () => unknown): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('SR-01 token estimation is bounded (js-tiktoken quadratic pre-tokens)', () => {
  beforeAll(async () => {
    await initTokenizer();
  });

  it('long single runs are estimated instead of encoded', () => {
    // Before the fix 10 KB of "a" took ~10 s and 50 KB several minutes.
    const ms = elapsed(() => expect(countTokens('a'.repeat(200_000))).toBe(50_000));
    expect(ms).toBeLessThan(500);
  });

  it('adversarial request bodies stay cheap end to end', () => {
    const shapes = [
      `${'a'.repeat(12)}.`,
      `${'漢'.repeat(4)},`,
      `${'😀'.repeat(4)}a`,
      `${'!'.repeat(12)}a`,
      `${' '.repeat(40)}x`,
      'The quick brown fox jumps over the lazy dog. ',
    ];
    for (const unit of shapes) {
      const text = unit.repeat(Math.ceil(1_000_000 / unit.length));
      const ms = elapsed(() => {
        estimatePromptTokens({ messages: [{ role: 'user', content: text }] });
        // many messages each below the per-text limit share one per-request budget
        estimatePromptTokens({
          messages: Array.from({ length: 60 }, () => ({
            role: 'user' as const,
            content: text.slice(0, 16_000),
          })),
        });
        estimateTextTokens(Array.from({ length: 60 }, () => text.slice(0, 16_000)));
      });
      expect(ms, JSON.stringify(unit)).toBeLessThan(1000);
    }
  });

  it('ordinary text is still counted exactly', () => {
    expect(countTokens('hello world')).toBe(2);
    expect(estimateTextTokens(['hello world', 'hello world'])).toBe(4);
  });
});

describe('SR-02 client JSON-Schema patterns cannot ReDoS the event loop', () => {
  it('screens catastrophic patterns and keeps simple ones', () => {
    for (const p of [
      '^ORD-\\d+$',
      '^\\d{4}-\\d{2}-\\d{2}$',
      '^[A-Z]{3}$',
      '^(foo|bar)$',
      '^(?:ab)+$',
    ])
      expect(isSafePattern(p), p).toBe(true);
    for (const p of ['^(a+)+$', '^(a|a)*$', '(a*)*', '^\\d*\\d*$', '(.*a){12}', '(a)\\1', '^(?=a)'])
      expect(isSafePattern(p), p).toBe(false);
  });

  it('an evil pattern against steered model output returns promptly', () => {
    const v = new SchemaValidator();
    const schema = { type: 'object', properties: { q: { type: 'string', pattern: '^(a+)+$' } } };
    // Before the fix: 27 chars took ~6 s, each extra char doubles it.
    const ms = elapsed(() => v.validate(schema, { q: `${'a'.repeat(40)}!` }));
    expect(ms).toBeLessThan(500);
  });

  it('safe patterns are still enforced', () => {
    const v = new SchemaValidator();
    const schema = { type: 'string', pattern: '^ORD-\\d+$' };
    expect(v.validate(schema, 'ORD-1').valid).toBe(true);
    expect(v.validate(schema, 'XYZ').valid).toBe(false);
  });
});

describe('SR-03 schema validator memory is bounded and isolated per schema', () => {
  it('does not retain every compiled client schema', () => {
    const v = new SchemaValidator();
    for (let i = 0; i < 1500; i++)
      v.validate(
        { type: 'object', description: `d${i}`, properties: { a: { type: 'string' } } },
        {},
      );
    const ajvCache = (v as unknown as { lenient: { _cache: Map<unknown, unknown> } }).lenient
      ._cache;
    expect(ajvCache.size).toBeLessThanOrEqual(501);
  });

  it('a schema `$id` from one request does not affect another', () => {
    const v = new SchemaValidator();
    expect(v.validate({ $id: 'shared', type: 'string' }, 'x').valid).toBe(true);
    const r = v.validate({ $id: 'shared', type: 'number' }, 'x');
    expect(r.errors.join(' ')).not.toContain('could not be compiled');
    expect(r.valid).toBe(false);
  });
});

const mockBase = {
  providers: { mock: { type: 'mock' } },
  models: {
    echo: { provider: 'mock', model: 'mock-echo' },
    emb: { provider: 'mock', model: 'mock-embedder', kind: 'embedding' },
  },
  routes: { plain: { targets: ['echo'] }, embed: { targets: ['emb'] } },
};

describe('SR-04 embedding dimensions are bounded', () => {
  it('rejects absurd dimensions and clamps the mock allocation', async () => {
    const { request } = testGateway(testConfig(mockBase));
    const huge = await request('/v1/embeddings', {
      model: 'embed',
      input: 'x',
      dimensions: 2_000_000_000,
    });
    expect(huge.status).toBe(400);
    const res = await request('/v1/embeddings', { model: 'embed', input: 'x', dimensions: 16_000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { embedding: number[] }[] };
    expect(body.data[0]!.embedding.length).toBe(8192);
  });
});

describe('SR-05 usage ledger ids are unique even when clients reuse x-request-id', () => {
  it('concurrent requests with the same id produce distinct usage events', async () => {
    const { chat, usage } = testGateway(testConfig(mockBase));
    const headers = { 'x-request-id': 'dup-1' };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        chat({ model: 'plain', messages: [{ role: 'user', content: 'x' }] }, headers),
      ),
    );
    for (const r of responses) expect(r.headers.get('x-request-id')).toBe('dup-1');
    const ids = usage.events.map((e) => e.request_id);
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) expect(id.startsWith('dup-1:req_')).toBe(true);
  });

  it('server-generated ids are used as-is', async () => {
    const { chat, usage } = testGateway(testConfig(mockBase));
    const res = await chat({ model: 'plain', messages: [{ role: 'user', content: 'x' }] });
    expect(usage.events[0]!.request_id).toBe(res.headers.get('x-request-id'));
  });
});

describe('SR-07 attribution fields are bounded', () => {
  it('clips end user and tags before they reach the usage stream', async () => {
    const { chat, usage } = testGateway(testConfig(mockBase));
    await chat(
      { model: 'plain', messages: [{ role: 'user', content: 'x' }], user: 'u'.repeat(100_000) },
      { 'x-sy-tags': `${'t'.repeat(1000)},ok` },
    );
    expect(usage.events[0]!.end_user).toHaveLength(256);
    expect(usage.events[0]!.tags).toEqual(['t'.repeat(128), 'ok']);
    await chat(
      { model: 'plain', messages: [{ role: 'user', content: 'x' }] },
      {
        'x-sy-user': 'h'.repeat(5000),
      },
    );
    expect(usage.events[1]!.end_user).toHaveLength(256);
  });
});

describe('SR-09 GET /admin/config redacts upstream headers and webhooks', () => {
  it('redacts header values, x-api-key style names and webhook URLs', () => {
    const out = redactConfig({
      providers: {
        p: {
          type: 'openai-compatible',
          headers: { Authorization: 'Bearer sk-live', 'x-trace': 'abc' },
          'x-api-key': 'k',
        },
      },
      budgets: { alert_webhook: 'https://hooks.slack.com/services/T000/B000/SECRET' },
      server: { port: 8787 },
    }) as {
      providers: { p: { headers: Record<string, string>; 'x-api-key': string } };
      budgets: { alert_webhook: string };
      server: { port: number };
    };
    expect(out.providers.p.headers).toEqual({
      Authorization: '[redacted]',
      'x-trace': '[redacted]',
    });
    expect(out.providers.p['x-api-key']).toBe('[redacted]');
    expect(out.budgets.alert_webhook).toBe('[redacted]');
    expect(out.server.port).toBe(8787);
  });
});

describe('SR-10 admin surfaces', () => {
  it('applies the body limit to /admin', async () => {
    const { request } = testGateway(testConfig({ ...mockBase, server: { body_limit_mb: 0.001 } }));
    const res = await request(
      '/admin/teams',
      { slug: 'x', metadata: { blob: 'y'.repeat(5000) } },
      { authorization: `Bearer ${ADMIN}` },
    );
    expect(res.status).toBe(413);
  });
});

describe('SR-11 client-facing errors do not echo upstream credentials or internals', () => {
  it('upstream auth failures get a generic message', () => {
    const err = toGatewayError(
      new ProviderError({
        status: 502,
        code: 'upstream_auth',
        message: 'openai: upstream 401: Incorrect API key provided: sk-proj-****abcd',
        provider: 'openai',
        fallback: true,
      }),
    );
    expect(err.status).toBe(502);
    expect(err.message).not.toContain('sk-proj');
    expect(err.message).toContain('openai');
  });

  it('unexpected errors are not echoed', () => {
    const err = toGatewayError(new Error('connect ECONNREFUSED 10.0.0.5:6379'));
    expect(err.status).toBe(500);
    expect(err.message).toBe('Internal server error');
  });
});

describe('SR-12 cache keys cover every response-affecting field', () => {
  const route = { name: 'r', cache: { exact: { ttl_s: 60 } } } as never;
  const req: ChatRequest = { model: 'r', messages: [{ role: 'user', content: 'hi' }] };

  it('changes with passthrough/generation fields', () => {
    const k = chatCacheKey(route, 't', req);
    for (const extra of [
      { logprobs: true },
      { parallel_tool_calls: false },
      { metadata: { mock_script: 'a' } },
      { presence_penalty: 1 },
      { logit_bias: { '50256': -100 } },
    ])
      expect(chatCacheKey(route, 't', { ...req, ...extra }), JSON.stringify(extra)).not.toBe(k);
  });

  it('ignores transport and attribution fields', () => {
    const k = chatCacheKey(route, 't', req);
    expect(
      chatCacheKey(route, 't', {
        ...req,
        stream: true,
        stream_options: { include_usage: true },
        user: 'u',
        temperature: 0,
      }),
    ).toBe(k);
    expect(chatCacheKey(route, 't', { ...req, max_tokens: 5 })).toBe(
      chatCacheKey(route, 't', { ...req, max_completion_tokens: 5 }),
    );
  });

  it('semantic scope separates requests with different settings', () => {
    const a = semanticQuery(req)!;
    const b = semanticQuery({ ...req, logprobs: true })!;
    expect(a.text).toBe(b.text);
    expect(a.scope).not.toBe(b.scope);
  });
});

describe('SR-13 pre-flight accounts for n choices', () => {
  it('reserves completion tokens for every choice', async () => {
    const seen: number[] = [];
    const limiter: RateLimiter = {
      check: async (input) => {
        seen.push(input.estimatedTokens);
        return { allowed: true, headers: {} };
      },
      reconcile: async () => undefined,
    };
    const { chat } = testGateway(testConfig(mockBase), { services: { rateLimiter: limiter } });
    await chat({ model: 'plain', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    await chat({
      model: 'plain',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 100,
      n: 3,
    });
    expect(seen[1]! - seen[0]!).toBe(200);
  });
});
