import { describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../../src/cache/store.js';
import { ADMIN, readSSE, testConfig, testGateway } from '../helpers.js';

/** Gateway in-process against the in-process mock provider. */
const base = {
  providers: { mock: { type: 'mock', allow_header_faults: true } },
  models: {
    down: { provider: 'mock', model: 'mock-echo', options: { fault: { status: 503 } } },
    limited: {
      provider: 'mock',
      model: 'mock-echo',
      options: { fault: { status: 429, retry_after_s: 0 } },
    },
    slow: {
      provider: 'mock',
      model: 'mock-echo',
      timeout_ms: 100,
      options: { fault: { latency_ms: 2000 } },
    },
    echo: { provider: 'mock', model: 'mock-echo', pricing: { input: 1, output: 2 } },
    echo2: { provider: 'mock', model: 'mock-echo' },
    stream_dies_early: {
      provider: 'mock',
      model: 'mock-echo',
      options: { fault: { stream_fail_after: 0 } },
    },
    stream_dies_late: {
      provider: 'mock',
      model: 'mock-echo',
      options: { fault: { stream_fail_after: 2 } },
    },
    rag: { provider: 'mock', model: 'mock-extractive' },
    tools: { provider: 'mock', model: 'mock-tools' },
  },
  routes: {
    plain: { targets: ['echo'] },
    'fallback-503': { targets: ['down', 'echo'] },
    'fallback-timeout': { targets: ['slow', 'echo'] },
    'fallback-429': {
      targets: ['limited', 'echo'],
      retry: { attempts: 3, backoff_ms: 1, max_backoff_ms: 2 },
    },
    'all-down': { targets: ['down'], retry: { attempts: 3, backoff_ms: 1, max_backoff_ms: 2 } },
    'stream-early': { targets: ['stream_dies_early', 'echo'] },
    'stream-late': { targets: ['stream_dies_late', 'echo'] },
    cached: { targets: ['echo'], cache: { exact: { ttl_s: 60 } } },
    rag: { targets: ['rag'] },
    tools: { targets: ['tools'] },
    deadline: { targets: ['slow', 'echo2'], timeout_ms: 50 },
    defaults: { targets: ['echo'], defaults: { reasoning_effort: 'medium', max_tokens: 77 } },
  },
};

const msg = (content: string) => [{ role: 'user', content }];

describe('fallback & retries', () => {
  it('falls back on 503 and reports routing headers', async () => {
    const { chat, usage } = testGateway(testConfig(base));
    const res = await chat({ model: 'fallback-503', messages: msg('hello') });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sy-route')).toBe('fallback-503');
    expect(res.headers.get('x-sy-provider')).toBe('mock');
    expect(res.headers.get('x-sy-model')).toBe('mock-echo');
    expect(res.headers.get('x-sy-fallbacks')).toBe('1');
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
    expect(Number(res.headers.get('x-sy-latency-ms'))).toBeGreaterThanOrEqual(0);
    const body = (await res.json()) as {
      model: string;
      choices: { message: { content: string } }[];
    };
    expect(body.model).toBe('fallback-503');
    expect(body.choices[0]!.message.content).toBe('hello');
    // 2 attempts on `down` (503 is retryable) + 1 on echo
    expect(usage.events[0]).toMatchObject({
      status: 200,
      attempts: 3,
      fallbacks: 1,
      route: 'fallback-503',
    });
  });

  it('falls back on per-attempt timeout', async () => {
    const { chat } = testGateway(testConfig(base));
    const started = Date.now();
    const res = await chat({ model: 'fallback-timeout', messages: msg('quick') });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sy-fallbacks')).toBe('1');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('retries 429 on the same target before falling back', async () => {
    const { chat, usage } = testGateway(testConfig(base));
    const res = await chat({ model: 'fallback-429', messages: msg('x') });
    expect(res.status).toBe(200);
    expect(usage.events[0]!.attempts).toBe(4);
  });

  it('returns 503 upstream_unavailable when every target fails', async () => {
    const { chat } = testGateway(testConfig(base));
    const res = await chat({ model: 'all-down', messages: msg('x') });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: 'upstream_unavailable', type: 'upstream_error' },
    });
    expect(res.headers.get('x-sy-route')).toBe('all-down');
  });

  it('enforces the total route deadline with 504', async () => {
    const { chat } = testGateway(testConfig(base));
    const res = await chat({ model: 'deadline', messages: msg('x') });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: 'upstream_timeout' } });
  });

  it('header faults can target one model (x-mock-fault-target)', async () => {
    const { chat } = testGateway(
      testConfig({ ...base, routes: { pair: { targets: ['echo', 'echo2'] } } }),
    );
    const res = await chat(
      { model: 'pair', messages: msg('x') },
      { 'x-mock-status': '500', 'x-mock-fault-target': 'echo' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sy-fallbacks')).toBe('1');
  });
});

describe('circuit breaker', () => {
  it('opens after consecutive failures and skips the target', async () => {
    const cfg = testConfig({
      ...base,
      breaker: { consecutive_failures: 3, cooldown_s: 60 },
      retry: { attempts: 1 },
    });
    const { chat, usage, request } = testGateway(cfg);
    for (let i = 0; i < 3; i++)
      expect((await chat({ model: 'fallback-503', messages: msg('x') })).status).toBe(200);
    const res = await chat({ model: 'fallback-503', messages: msg('x') });
    expect(res.status).toBe(200);
    expect(usage.events[3]!.attempts).toBe(1); // `down` skipped: circuit open
    const health = (await (
      await request('/admin/providers/health', undefined, { authorization: `Bearer ${ADMIN}` })
    ).json()) as {
      breakers: { target: string; state: string }[];
    };
    expect(health.breakers.find((b) => b.target === 'down')?.state).toBe('open');
  });

  it('half-open probe closes the breaker after cooldown', async () => {
    let now = 1_000_000;
    const cfg = testConfig({
      ...base,
      breaker: { consecutive_failures: 2, cooldown_s: 10 },
      retry: { attempts: 1 },
    });
    const { chat, gateway } = testGateway(cfg, { clock: () => now });
    for (let i = 0; i < 2; i++)
      await chat(
        { model: 'fallback-503', messages: msg('x') },
        { 'x-mock-status': '503', 'x-mock-fault-target': 'echo2' },
      );
    expect((await gateway.services.breakers.acquire('down', cfg.breaker)).allowed).toBe(false);
    now += 11_000;
    // `down` still fails → probe fails → re-open with doubled cooldown
    await chat({ model: 'fallback-503', messages: msg('x') });
    const snap = await gateway.services.breakers.snapshot(cfg.breaker);
    expect(snap.find((s) => s.target === 'down')).toMatchObject({ state: 'open', trips: 2 });
  });
});

describe('streaming', () => {
  it('streams with usage when include_usage is set and rewrites the model', async () => {
    const { chat, usage } = testGateway(testConfig(base));
    const res = await chat({
      model: 'plain',
      stream: true,
      stream_options: { include_usage: true },
      messages: msg('stream me please'),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-sy-provider')).toBe('mock');
    const events = await readSSE(res);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1) as {
      model: string;
      choices: { delta: { content?: string } }[];
      usage?: unknown;
    }[];
    expect(chunks.every((c) => c.model === 'plain')).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('stream me please');
    expect(chunks.at(-1)!.usage).toMatchObject({ prompt_tokens: expect.any(Number) });
    expect(usage.events[0]).toMatchObject({ stream: true, status: 200 });
    expect(usage.events[0]!.ttft_ms).not.toBeNull();
    expect(usage.events[0]!.cost_usd).toBeGreaterThan(0);
  });

  it('strips usage chunks when the client did not ask for them', async () => {
    const { chat } = testGateway(testConfig(base));
    const events = (
      await readSSE(await chat({ model: 'plain', stream: true, messages: msg('x y') }))
    ).slice(0, -1) as { choices: unknown[]; usage?: unknown }[];
    expect(events.every((e) => e.choices.length > 0 && e.usage === undefined)).toBe(true);
  });

  it('falls back before the first byte is flushed', async () => {
    const { chat } = testGateway(testConfig(base));
    const res = await chat({ model: 'stream-early', stream: true, messages: msg('survive') });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sy-fallbacks')).toBe('1');
    const events = await readSSE(res);
    const text = (events.slice(0, -1) as { choices: { delta: { content?: string } }[] }[])
      .map((c) => c.choices[0]?.delta.content ?? '')
      .join('');
    expect(text).toBe('survive');
  });

  it('after the first byte, failures end the stream with an error event + [DONE]', async () => {
    const { chat, usage } = testGateway(testConfig(base));
    const res = await chat({
      model: 'stream-late',
      stream: true,
      messages: msg('one two three four five six seven eight'),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sy-fallbacks')).toBe('0');
    const events = await readSSE(res);
    expect(events.at(-1)).toBe('[DONE]');
    expect(events.at(-2)).toMatchObject({ error: { code: expect.stringMatching(/upstream/) } });
    expect(usage.events[0]!.status).toBeGreaterThanOrEqual(500);
  });

  it('pre-commit stream failure on all targets yields a JSON error, not a stream', async () => {
    const { chat } = testGateway(testConfig(base));
    const res = await chat({ model: 'all-down', stream: true, messages: msg('x') });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('pipeline behaviors', () => {
  it('returns cost headers computed from usage × pricing', async () => {
    const { chat } = testGateway(testConfig(base));
    const res = await chat({ model: 'plain', messages: msg('price me') });
    const body = (await res.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    const expected = (body.usage.prompt_tokens * 1 + body.usage.completion_tokens * 2) / 1_000_000;
    expect(Number(res.headers.get('x-sy-cost-usd'))).toBeCloseTo(expected, 10);
    expect(res.headers.get('x-sy-cache')).toBe('bypass');
  });

  it('serves exact-cache hits (stream replay too) when a CacheStore is plugged in', async () => {
    const { chat, usage } = testGateway(testConfig(base), {
      services: { cache: new MemoryCacheStore() },
    });
    const first = await chat({ model: 'cached', messages: msg('cache me') });
    expect(first.headers.get('x-sy-cache')).toBe('miss');
    await new Promise((r) => setTimeout(r, 5));
    const second = await chat({ model: 'cached', messages: msg('cache me') });
    expect(second.headers.get('x-sy-cache')).toBe('hit');
    expect(second.headers.get('x-sy-cost-usd')).toBe('0');
    expect(second.headers.get('x-sy-provider')).toBe('mock');
    const replay = await chat({ model: 'cached', stream: true, messages: msg('cache me') });
    expect(replay.headers.get('x-sy-cache')).toBe('hit');
    const text = (
      (await readSSE(replay)).slice(0, -1) as { choices: { delta: { content?: string } }[] }[]
    )
      .map((c) => c.choices[0]?.delta.content ?? '')
      .join('');
    expect(text).toBe('cache me');
    const bypass = await chat(
      { model: 'cached', messages: msg('cache me') },
      { 'x-sy-cache': 'bypass' },
    );
    expect(bypass.headers.get('x-sy-cache')).toBe('bypass');
    expect(usage.events[1]!.saved_usd).toBeGreaterThan(0);
  });

  it('applies route defaults (reasoning_effort, max_tokens) without overriding the client', async () => {
    const seen: unknown[] = [];
    const cfg = testConfig(base);
    const { chat } = testGateway(cfg, {
      adapterFactories: {
        mock: (name) => ({
          type: 'mock',
          name,
          async chat(req) {
            seen.push({ effort: req.reasoning_effort, max: req.max_tokens });
            return {
              id: 'x',
              object: 'chat.completion',
              created: 0,
              model: 'm',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
              ],
            };
          },
          async *chatStream() {},
        }),
      },
    });
    await chat({ model: 'defaults', messages: msg('x') });
    await chat({ model: 'defaults', messages: msg('x'), reasoning_effort: 'high', max_tokens: 5 });
    expect(seen).toEqual([
      { effort: 'medium', max: 77 },
      { effort: 'high', max: 5 },
    ]);
  });

  it('records tags and end-user attribution in usage events', async () => {
    const { chat, usage } = testGateway(testConfig(base));
    await chat(
      { model: 'plain', messages: msg('x'), user: 'u-1' },
      { 'x-sy-tags': 'eval, case:q017', 'x-request-id': 'my-trace-1' },
    );
    expect(usage.events[0]).toMatchObject({
      // client id kept as prefix; server suffix keeps ledger ids unique
      request_id: expect.stringMatching(/^my-trace-1:req_[A-Za-z0-9]{24}$/),
      end_user: 'u-1',
      tags: ['eval', 'case:q017'],
      team: 'test',
    });
  });

  it('mock-extractive answers with citations or NO_ANSWER', async () => {
    const { chat } = testGateway(testConfig(base));
    const ask = async (content: string) =>
      (
        (await (await chat({ model: 'rag', messages: msg(content) })).json()) as {
          choices: { message: { content: string } }[];
        }
      ).choices[0]!.message.content;
    expect(
      await ask(
        '<source id="3" title="t">Middleware is registered with app.use in Hono.</source>\nQuestion: How is middleware registered in Hono?',
      ),
    ).toMatch(/\[3\]/);
    expect(
      await ask(
        '<source id="1">Bananas are yellow.</source>\nQuestion: What is the refund policy for enterprise customers?',
      ),
    ).toBe('NO_ANSWER');
  });

  it('mock-tools follows a script across tool round-trips', async () => {
    const { chat } = testGateway(testConfig(base));
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_order',
          parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
      },
    ];
    const script = [
      { tool_calls: [{ name: 'get_order', arguments: { id: 'ORD-1' } }] },
      { content: 'Order ORD-1 shipped.' },
    ];
    const r1 = (await (
      await chat({
        model: 'tools',
        tools,
        messages: msg('status?'),
        metadata: { mock_script: script },
      })
    ).json()) as {
      choices: {
        finish_reason: string;
        message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
      }[];
    };
    expect(r1.choices[0]!.finish_reason).toBe('tool_calls');
    const call = r1.choices[0]!.message.tool_calls[0]!;
    const r2 = (await (
      await chat({
        model: 'tools',
        tools,
        metadata: { mock_script: script },
        messages: [
          ...msg('status?'),
          { role: 'assistant', content: null, tool_calls: [{ ...call, type: 'function' }] },
          { role: 'tool', tool_call_id: call.id, content: '{"status":"shipped"}' },
        ],
      })
    ).json()) as { choices: { message: { content: string } }[] };
    expect(r2.choices[0]!.message.content).toBe('Order ORD-1 shipped.');
  });
});

describe('HTTP contract', () => {
  it('rejects missing/invalid keys with invalid_api_key', async () => {
    const { request } = testGateway(testConfig(base));
    const res = await request('/v1/models', undefined, { authorization: '' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: 'invalid_api_key', type: 'authentication_error' },
    });
  });

  it('enforces allowed_routes with model_not_allowed and unknown models with model_not_found', async () => {
    const cfg = testConfig({
      ...base,
      auth: { static_keys: [{ key: 'sk-sy-test-key-0001', team: 't', allowed_routes: ['plain'] }] },
    });
    const { chat, request } = testGateway(cfg);
    expect((await chat({ model: 'rag', messages: msg('x') })).status).toBe(403);
    const nf = await chat({ model: 'nope', messages: msg('x') });
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ error: { code: 'model_not_found', param: 'model' } });
    const models = (await (await request('/v1/models')).json()) as { data: { id: string }[] };
    expect(models.data.map((m) => m.id)).toEqual(['plain']);
  });

  it('validates bodies with invalid_request and a param path', async () => {
    const { chat, request } = testGateway(testConfig(base));
    const bad = await chat({ model: 'plain', messages: [] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { code: 'invalid_request', param: 'messages' },
    });
    const notJson = await request('/v1/chat/completions', undefined, {});
    expect(notJson.status).toBe(404); // GET on a POST route
    const res = await testGateway(testConfig(base)).gateway.fetch(
      new Request('http://x/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-sy-test-key-0001' },
        body: '{oops',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects using a chat route on /v1/embeddings', async () => {
    const { request } = testGateway(testConfig(base));
    const res = await request('/v1/embeddings', { model: 'plain', input: 'x' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      '/v1/chat/completions',
    );
  });

  it('health, readiness and draining', async () => {
    const { request, gateway } = testGateway(testConfig(base));
    expect((await request('/healthz')).status).toBe(200);
    // Provider probes fan out upstream and expose error details: admin token required.
    expect((await request('/readyz?probe=1')).status).toBe(401);
    expect(
      await (
        await request('/readyz?probe=1', undefined, { authorization: `Bearer ${ADMIN}` })
      ).json(),
    ).toMatchObject({
      status: 'ready',
      providers: { mock: { ok: true } },
    });
    expect((await request('/readyz')).status).toBe(200);
    gateway.setDraining(true);
    expect((await request('/readyz')).status).toBe(503);
  });

  it('hot reload swaps routes atomically', async () => {
    const { chat, gateway, request } = testGateway(testConfig(base));
    expect((await chat({ model: 'brand-new', messages: msg('x') })).status).toBe(404);
    await gateway.reload(
      testConfig({ ...base, routes: { ...base.routes, 'brand-new': { targets: ['echo'] } } }),
    );
    expect((await chat({ model: 'brand-new', messages: msg('x') })).status).toBe(200);
    const unauthorized = await request(
      '/admin/config/reload',
      {},
      { authorization: 'Bearer wrong-token-xyz' },
    );
    expect(unauthorized.status).toBe(401);
  });

  it('unknown endpoints return the OpenAI error envelope', async () => {
    const { request } = testGateway(testConfig(base));
    const res = await request('/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
