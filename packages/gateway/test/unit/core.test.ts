import { describe, expect, it } from 'vitest';
import {
  canonicalJSON,
  chatCacheKey,
  isChatCacheable,
  parseCacheMode,
} from '../../src/cache/keys.js';
import {
  ChunkAccumulator,
  isMeaningfulChunk,
  responseToChunks,
  splitText,
} from '../../src/core/chunks.js';
import {
  GatewayError,
  parseRetryAfter,
  ProviderError,
  providerErrorFromStatus,
  toGatewayError,
} from '../../src/core/errors.js';
import { resolveRequestId } from '../../src/core/ids.js';
import { LeastLatencyStrategy, WeightedStrategy } from '../../src/core/strategies.js';
import { applyInputTemplates } from '../../src/core/templates.js';
import type { ChatResponse } from '../../src/core/types.js';
import { computeCost, estimateCost, formatUsd } from '../../src/usage/pricing.js';
import { parseSSE } from '../../src/util/sse.js';
import { testConfig, testRoute } from '../helpers.js';

describe('computeCost', () => {
  const pricing = { input: 2, output: 10, cached_input: 0.1, cache_write: 2.5 };

  it('prices uncached, cached and cache-write input separately', () => {
    const cost = computeCost(
      {
        prompt_tokens: 1_000_000,
        completion_tokens: 100_000,
        total_tokens: 1_100_000,
        prompt_tokens_details: { cached_tokens: 400_000, cache_write_tokens: 100_000 },
        completion_tokens_details: { reasoning_tokens: 50_000 },
      },
      pricing,
    );
    // 500k uncached × $2 + 400k cached × $0.1 + 100k write × $2.5 + 100k out × $10
    expect(cost.inputUsd).toBeCloseTo(1.0);
    expect(cost.cachedInputUsd).toBeCloseTo(0.04);
    expect(cost.cacheWriteUsd).toBeCloseTo(0.25);
    expect(cost.outputUsd).toBeCloseTo(1.0);
    expect(cost.costUsd).toBeCloseTo(2.29);
  });

  it('defaults cached pricing to the input price and handles missing pricing', () => {
    expect(
      computeCost(
        {
          prompt_tokens: 1000,
          completion_tokens: 0,
          total_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
        { input: 1, output: 1 },
      ).costUsd,
    ).toBeCloseTo(0.001);
    expect(
      computeCost({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, undefined),
    ).toMatchObject({ costUsd: 0, priced: false });
  });

  it('adds a per-request fee', () => {
    expect(
      computeCost(
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        { input: 0, output: 0, per_request: 0.002 },
      ).costUsd,
    ).toBe(0.002);
  });

  it('estimates an upper bound and formats for headers', () => {
    expect(estimateCost(1000, 500, { input: 2, output: 10 })).toBeCloseTo(0.007);
    expect(formatUsd(0)).toBe('0');
    expect(formatUsd(0.000425)).toBe('0.000425');
    expect(formatUsd(1.5)).toBe('1.5');
  });
});

describe('errors', () => {
  it('classifies upstream statuses', () => {
    expect(providerErrorFromStatus('p', 429, 'x', 1000)).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      fallback: true,
      retryAfterMs: 1000,
    });
    expect(providerErrorFromStatus('p', 503, 'x')).toMatchObject({
      code: 'upstream_unavailable',
      retryable: true,
    });
    expect(providerErrorFromStatus('p', 401, 'x')).toMatchObject({
      code: 'upstream_auth',
      retryable: false,
      fallback: true,
    });
    expect(providerErrorFromStatus('p', 400, 'x')).toMatchObject({
      code: 'invalid_request',
      retryable: false,
      fallback: false,
    });
  });

  it('maps final provider errors to the client contract', () => {
    const map = (code: ProviderError['code'], status = 500) =>
      toGatewayError(new ProviderError({ status, code, message: 'm', provider: 'p' }));
    expect(map('upstream_timeout')).toMatchObject({ status: 504, code: 'upstream_timeout' });
    expect(map('rate_limited')).toMatchObject({ status: 503, code: 'upstream_unavailable' });
    expect(map('invalid_request', 400)).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(map('upstream_auth')).toMatchObject({ status: 502, code: 'upstream_error' });
    expect(map('upstream_invalid_output')).toMatchObject({
      status: 502,
      code: 'upstream_invalid_output',
    });
    expect(new GatewayError(404, 'model_not_found', 'nope').toJSON()).toEqual({
      error: {
        message: 'nope',
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: null,
      },
    });
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });
});

describe('request ids', () => {
  it('honors safe client ids and replaces unsafe ones', () => {
    expect(resolveRequestId('trace-123.abc:9')).toBe('trace-123.abc:9');
    expect(resolveRequestId('bad id\n')).toMatch(/^req_/);
    expect(resolveRequestId(undefined)).toMatch(/^req_[A-Za-z0-9]{24}$/);
  });
});

describe('cache keys', () => {
  const route = testRoute({ cache: { exact: { ttl_s: 60, enabled: true }, shared: false } });
  const req = { model: 'r', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('canonical JSON ignores key order and undefined', () => {
    expect(canonicalJSON({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('keys are stable and namespaced per team', () => {
    expect(chatCacheKey(route, 'a', req)).toBe(
      chatCacheKey(route, 'a', { ...req, stream: true, user: 'x' }),
    );
    expect(chatCacheKey(route, 'a', req)).not.toBe(chatCacheKey(route, 'b', req));
    expect(chatCacheKey(route, 'a', req)).not.toBe(
      chatCacheKey(route, 'a', { ...req, reasoning_effort: 'high' }),
    );
  });

  it('cacheability rules', () => {
    expect(isChatCacheable(route, req, 'default')).toBe(true);
    expect(isChatCacheable(route, req, 'bypass')).toBe(false);
    expect(isChatCacheable(route, { ...req, temperature: 0.7 }, 'default')).toBe(false);
    expect(isChatCacheable(route, { ...req, n: 2 }, 'default')).toBe(false);
    expect(isChatCacheable(testRoute(), req, 'default')).toBe(false);
    expect(parseCacheMode('REFRESH')).toBe('refresh');
    expect(parseCacheMode('weird')).toBe('default');
  });
});

describe('chunks', () => {
  const response: ChatResponse = {
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Let me look that up for you right away, one moment please.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_order', arguments: '{"order_id":"ORD-1"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  };

  it('responseToChunks round-trips through ChunkAccumulator', () => {
    const acc = new ChunkAccumulator();
    const chunks = [...responseToChunks(response, { chunkSize: 10 })];
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks[0]!.choices[0]!.delta.role).toBe('assistant');
    chunks.forEach((c) => acc.push(c));
    const back = acc.toResponse();
    expect(back.choices[0]!.message).toEqual(response.choices[0]!.message);
    expect(back.choices[0]!.finish_reason).toBe('tool_calls');
    expect(back.usage).toEqual(response.usage);
  });

  it('role-only chunks are not meaningful', () => {
    const [first] = responseToChunks({
      ...response,
      choices: [{ ...response.choices[0]!, message: { role: 'assistant', content: '' } }],
    });
    expect(first!.choices[0]!.delta).toEqual({ role: 'assistant', content: '' });
    expect(isMeaningfulChunk(first!)).toBe(false);
  });

  it('splitText prefers word boundaries and preserves content', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const parts = splitText(text, 12);
    expect(parts.join('')).toBe(text);
    expect(parts.every((p) => p.length <= 12)).toBe(true);
  });
});

describe('parseSSE', () => {
  const stream = (...parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });

  it('handles events split across chunks, CRLF, comments and multi-line data', async () => {
    const events = [];
    for await (const e of parseSSE(
      stream(
        ': hi\r\n',
        'event: a\r\nda',
        'ta: one\r\ndata: two\r',
        '\n\r\ndata: {"x":1}\n\n',
        'data: tail',
      ),
    ))
      events.push(e);
    expect(events).toEqual([
      { event: 'a', data: 'one\ntwo', id: undefined },
      { event: undefined, data: '{"x":1}', id: undefined },
      { event: undefined, data: 'tail', id: undefined },
    ]);
  });
});

describe('strategies', () => {
  const route = testRoute({
    strategy: 'weighted',
    targets: [
      { model: 'a', weight: 3, timeoutMs: undefined },
      { model: 'b', weight: 1, timeoutMs: undefined },
    ],
  });

  it('smooth weighted round-robin distributes picks by weight and keeps fallbacks', () => {
    const s = new WeightedStrategy();
    const firsts = Array.from({ length: 8 }, () => s.order(route));
    expect(firsts.map((o) => o[0]!.model).join('')).toBe('aabaaaba');
    expect(firsts.every((o) => o.length === 2)).toBe(true);
  });

  it('least-latency prefers unexplored then fastest targets', () => {
    const s = new LeastLatencyStrategy(0, 0.5, () => 0.99);
    expect(s.order(route).map((t) => t.model)).toEqual(['a', 'b']);
    s.observe(route, 'a', 500, true);
    expect(s.order(route).map((t) => t.model)).toEqual(['b', 'a']);
    s.observe(route, 'b', 900, true);
    s.observe(route, 'a', 100, true);
    expect(s.latency('a')).toBe(300);
    expect(s.order(route).map((t) => t.model)).toEqual(['a', 'b']);
  });
});

describe('embedding input templates', () => {
  const cfg = testConfig({
    providers: { mock: { type: 'mock' } },
    models: {
      emb: {
        provider: 'mock',
        model: 'mock-embed',
        kind: 'embedding',
        input_templates: {
          query: 'task: search result | query: {text}',
          document: 'title: {title} | text: {text}',
        },
      },
    },
    routes: { e: { targets: ['emb'] } },
  });
  const model = cfg.models.emb!;

  it('applies query templates and strips extension fields', () => {
    expect(applyInputTemplates({ model: 'e', input: 'hello', input_type: 'query' }, model)).toEqual(
      { model: 'e', input: 'task: search result | query: hello' },
    );
  });

  it('fills {title} from input_titles with a "none" default', () => {
    expect(
      applyInputTemplates(
        { model: 'e', input: ['a', 'b'], input_type: 'document', input_titles: ['Intro', null] },
        model,
      ).input,
    ).toEqual(['title: Intro | text: a', 'title: none | text: b']);
  });

  it('passes input through without input_type or for token arrays', () => {
    expect(applyInputTemplates({ model: 'e', input: 'x' }, model).input).toBe('x');
    expect(
      applyInputTemplates({ model: 'e', input: [1, 2], input_type: 'query' }, model).input,
    ).toEqual([1, 2]);
  });

  it('does not interpret $ patterns in user text', () => {
    expect(
      applyInputTemplates({ model: 'e', input: "cost $& and $'", input_type: 'query' }, model)
        .input,
    ).toBe("task: search result | query: cost $& and $'");
  });
});
