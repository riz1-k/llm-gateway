import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import { startMockServer, type RunningMockServer } from '@switchyard/mock-provider';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { BudgetGuard, RateLimiter } from '../../src/core/services.js';
import { createLogger } from '../../src/observability/logger.js';
import { tracer } from '../../src/observability/tracing.js';
import { upstreamJson } from '../../src/providers/http.js';
import { OpencodeClient } from '../../src/providers/opencode/client.js';
import { readSSE, testConfig, testGateway } from '../helpers.js';

/**
 * Tracing with a TracerProvider registered by the host application (the embedder path): the
 * gateway never starts its own SDK here, and its spans land in the host's provider.
 */
const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({
  sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});
let mock: RunningMockServer;

beforeAll(async () => {
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );
  mock = await startMockServer({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await mock.close();
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

beforeEach(() => {
  exporter.reset();
  mock.reset();
});

const base = () => ({
  providers: {
    mock: { type: 'mock', allow_header_faults: true },
    http: { type: 'openai-compatible', base_url: `${mock.url}/v1` },
    http503: {
      type: 'openai-compatible',
      base_url: `${mock.url}/v1`,
      headers: { 'x-mock-status': '503' },
    },
  },
  models: {
    echo: { provider: 'mock', model: 'mock-echo', pricing: { input: 1, output: 2 } },
    down: { provider: 'mock', model: 'mock-echo', options: { fault: { status: 503 } } },
    remote: { provider: 'http', model: 'mock-echo', pricing: { input: 1, output: 2 } },
    remote_down: { provider: 'http503', model: 'mock-echo' },
  },
  routes: {
    plain: { targets: ['echo'] },
    cached: { targets: ['echo'], cache: { exact: { ttl_s: 60 } } },
    'fallback-503': { targets: ['down', 'echo'], retry: { attempts: 1 } },
    remote: { targets: ['remote'] },
    'remote-fallback': { targets: ['remote_down', 'remote'], retry: { attempts: 1 } },
  },
});

const msg = (content: string) => [{ role: 'user', content }];

/** Spans of one trace, with helpers to walk the tree. */
function traceOf(traceId: string) {
  const spans = exporter.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);
  const byName = (name: string) => spans.filter((s) => s.name === name);
  const childrenOf = (parent: ReadableSpan) =>
    spans.filter((s) => s.parentSpanContext?.spanId === parent.spanContext().spanId);
  const server = spans.find((s) => s.kind === SpanKind.SERVER);
  return { spans, byName, childrenOf, server };
}

/** Waits until the server span of `traceId` has ended (streams end after the body). */
async function serverSpan(traceId: string): Promise<ReadableSpan> {
  for (let i = 0; i < 100; i++) {
    const s = traceOf(traceId).server;
    if (s) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no server span for trace ${traceId}`);
}

describe('server span', () => {
  it('traces a non-streamed chat: server span → one attempt span with GenAI attributes', async () => {
    const { chat } = testGateway(testConfig(base()));
    const res = await chat({ model: 'plain', messages: msg('hello world'), max_tokens: 50 });
    expect(res.status).toBe(200);
    const traceId = res.headers.get('x-sy-trace-id');
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    await res.json();

    const t = traceOf(traceId!);
    const server = await serverSpan(traceId!);
    expect(server.name).toBe('POST /v1/chat/completions');
    expect(server.attributes).toMatchObject({
      'http.request.method': 'POST',
      'http.route': '/v1/chat/completions',
      'http.response.status_code': 200,
      'url.path': '/v1/chat/completions',
      'sy.route': 'plain',
      'sy.team': 'test',
      'sy.cache': 'bypass',
      'sy.provider': 'mock',
      'sy.target': 'echo',
      'sy.attempts': 1,
      'sy.fallbacks': 0,
    });
    expect(server.attributes['sy.key_prefix']).toBe('sk-sy-test-k');
    expect(server.attributes['sy.cost_usd']).toBeGreaterThan(0);
    expect(server.status.code).toBe(SpanStatusCode.UNSET);

    const attempts = t.childrenOf(server).filter((s) => s.kind === SpanKind.CLIENT);
    expect(attempts).toHaveLength(1);
    const a = attempts[0]!;
    expect(a.name).toBe('chat mock-echo');
    expect(a.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'mock',
      'gen_ai.request.model': 'mock-echo',
      'gen_ai.request.max_tokens': 50,
      'gen_ai.response.finish_reasons': ['stop'],
      'sy.route': 'plain',
      'sy.target': 'echo',
      'sy.provider': 'mock',
      'sy.attempt': 1,
      'sy.retry': 0,
      'sy.fallback.index': 0,
      'sy.circuit.state': 'closed',
    });
    expect(a.attributes['gen_ai.usage.input_tokens']).toBeGreaterThan(0);
    expect(a.attributes['gen_ai.usage.output_tokens']).toBeGreaterThan(0);
    expect(a.attributes['gen_ai.response.model']).toBe('mock-echo');
    expect(a.attributes['sy.cost_usd']).toBe(server.attributes['sy.cost_usd']);
    // Never content.
    const all = JSON.stringify(t.spans.map((s) => [s.attributes, s.events]));
    expect(all).not.toContain('hello world');
  });

  it('streams: the server span ends with the stream and carries TTFT, usage and cost', async () => {
    const { chat } = testGateway(testConfig(base()));
    const res = await chat({
      model: 'plain',
      messages: msg('one two three four'),
      stream: true,
      stream_options: { include_usage: true },
    });
    const traceId = res.headers.get('x-sy-trace-id')!;
    // Headers are out, the body is not consumed: nothing has ended yet.
    expect(traceOf(traceId).server).toBeUndefined();
    await readSSE(res);
    const server = await serverSpan(traceId);
    expect(server.attributes['sy.stream']).toBe(true);
    expect(server.attributes['sy.ttft_ms']).toBeGreaterThanOrEqual(0);
    expect(server.attributes['sy.usage.output_tokens']).toBeGreaterThan(0);
    expect(server.attributes['sy.cost_usd']).toBeGreaterThan(0);
    expect(server.events.map((e) => e.name)).toContain('sy.first_token');

    const [a] = traceOf(traceId).childrenOf(server);
    expect(a!.attributes['gen_ai.request.stream']).toBe(true);
    expect(a!.attributes['gen_ai.response.time_to_first_chunk']).toBeGreaterThanOrEqual(0);
    expect(a!.attributes['gen_ai.usage.output_tokens']).toBeGreaterThan(0);
    expect(a!.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
    // The attempt span ends before its parent (export order = end order; timestamps are not
    // comparable below 1 ms).
    const order = exporter.getFinishedSpans();
    expect(order.indexOf(a!)).toBeLessThan(order.indexOf(server));
  });

  it('exact cache hit: a cache stage span, no attempt span', async () => {
    const { chat } = testGateway(testConfig(base()));
    await (await chat({ model: 'cached', messages: msg('cache me'), temperature: 0 })).json();
    exporter.reset();
    const res = await chat({ model: 'cached', messages: msg('cache me'), temperature: 0 });
    expect(res.headers.get('x-sy-cache')).toBe('hit');
    const traceId = res.headers.get('x-sy-trace-id')!;
    await res.json();
    const server = await serverSpan(traceId);
    const t = traceOf(traceId);
    expect(server.attributes['sy.cache']).toBe('hit');
    expect(server.attributes['sy.saved_usd']).toBeGreaterThan(0);
    const [lookup] = t.byName('sy.cache.exact');
    expect(lookup!.attributes['sy.cache.result']).toBe('hit');
    expect(lookup!.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(t.spans.filter((s) => s.kind === SpanKind.CLIENT)).toHaveLength(0);
  });

  it('fallback after an upstream 503: two sibling attempt spans', async () => {
    const { chat } = testGateway(testConfig(base()));
    const res = await chat({ model: 'fallback-503', messages: msg('hi') });
    expect(res.status).toBe(200);
    const traceId = res.headers.get('x-sy-trace-id')!;
    await res.json();
    const server = await serverSpan(traceId);
    const attempts = traceOf(traceId)
      .childrenOf(server)
      .filter((s) => s.kind === SpanKind.CLIENT)
      .sort((x, y) => x.startTime[0] - y.startTime[0] || x.startTime[1] - y.startTime[1]);
    expect(attempts.map((s) => s.attributes['sy.target'])).toEqual(['down', 'echo']);
    const [failed, ok] = attempts as [ReadableSpan, ReadableSpan];
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.attributes).toMatchObject({
      'error.type': 'upstream_unavailable',
      'sy.error.status': 503,
      'sy.fallback.index': 0,
    });
    expect(failed.events.map((e) => e.name)).toContain('exception');
    expect(ok.status.code).toBe(SpanStatusCode.UNSET);
    expect(ok.attributes).toMatchObject({
      'sy.fallback.index': 1,
      'sy.fallback.reason': 'upstream_unavailable',
    });
    expect(server.attributes['sy.fallbacks']).toBe(1);
  });
});

describe('rejections', () => {
  it('budget 402: limits span, error code on the server span, status unset (4xx)', async () => {
    const budgets: BudgetGuard = {
      check: async () => ({ allowed: false, period: 'monthly' }),
      record: async () => undefined,
    };
    const { chat } = testGateway(testConfig(base()), { services: { budgets } });
    const res = await chat({ model: 'plain', messages: msg('hi') });
    expect(res.status).toBe(402);
    const traceId = res.headers.get('x-sy-trace-id')!;
    const server = await serverSpan(traceId);
    expect(server.attributes).toMatchObject({
      'http.response.status_code': 402,
      'sy.error.code': 'budget_exceeded',
    });
    expect(server.status.code).toBe(SpanStatusCode.UNSET);
    const [limits] = traceOf(traceId).byName('sy.limits');
    expect(limits!.attributes).toMatchObject({
      'sy.ratelimit.result': 'allowed',
      'sy.budget.result': 'rejected',
    });
    expect(traceOf(traceId).spans.filter((s) => s.kind === SpanKind.CLIENT)).toHaveLength(0);
  });

  it('rate limit 429: limits span marks the rate limiter', async () => {
    const rateLimiter: RateLimiter = {
      check: async () => ({
        allowed: false,
        headers: {},
        rejectedBy: 'key:rpm',
        retryAfterMs: 1000,
      }),
      reconcile: async () => undefined,
    };
    const { chat } = testGateway(testConfig(base()), { services: { rateLimiter } });
    const res = await chat({ model: 'plain', messages: msg('hi') });
    expect(res.status).toBe(429);
    const traceId = res.headers.get('x-sy-trace-id')!;
    const server = await serverSpan(traceId);
    expect(server.attributes['sy.error.code']).toBe('rate_limit_exceeded');
    const [limits] = traceOf(traceId).byName('sy.limits');
    expect(limits!.attributes['sy.ratelimit.result']).toBe('rejected');
  });

  it('5xx: server span status ERROR with error.type = status code', async () => {
    const cfg = base();
    cfg.routes['fallback-503'] = { targets: ['down'], retry: { attempts: 1 } };
    const gw = testGateway(testConfig(cfg));
    const r2 = await gw.chat({ model: 'fallback-503', messages: msg('hi') });
    expect(r2.status).toBe(503);
    const server = await serverSpan(r2.headers.get('x-sy-trace-id')!);
    expect(server.status.code).toBe(SpanStatusCode.ERROR);
    expect(server.attributes).toMatchObject({
      'error.type': '503',
      'sy.error.code': 'upstream_unavailable',
    });
  });
});

describe('client abort', () => {
  it('ends the server span and marks the streaming attempt aborted', async () => {
    const { chat, usage } = testGateway(testConfig(base()));
    const res = await chat({
      model: 'plain',
      messages: msg(Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')),
      stream: true,
    });
    const traceId = res.headers.get('x-sy-trace-id')!;
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    const server = await serverSpan(traceId);
    expect(server.attributes['sy.error.code']).toBe('request_aborted');
    expect(server.attributes['http.response.status_code']).toBe(200);
    const [a] = traceOf(traceId).childrenOf(server);
    expect(a!.attributes['error.type']).toBe('aborted');
    expect(usage.events.at(-1)!.status).toBe(499);
  });
});

describe('propagation', () => {
  const parentTraceId = '0af7651916cd43dd8448eb211c80319c';
  const parentSpanId = 'b7ad6b7169203331';

  it('joins an incoming traceparent and sends the attempt span as traceparent upstream', async () => {
    const { chat } = testGateway(testConfig(base()));
    const res = await chat(
      { model: 'remote', messages: msg('hi') },
      { traceparent: `00-${parentTraceId}-${parentSpanId}-01`, tracestate: 'vendor=x' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sy-trace-id')).toBe(parentTraceId);
    await res.json();
    const server = await serverSpan(parentTraceId);
    expect(server.parentSpanContext?.spanId).toBe(parentSpanId);
    const [attempt] = traceOf(parentTraceId).childrenOf(server);
    expect(attempt!.attributes).toMatchObject({
      'gen_ai.provider.name': 'openai_compatible',
      'server.address': '127.0.0.1',
    });

    const recorded = mock.stats().recent.find((r) => r.path === '/v1/chat/completions');
    expect(recorded?.trace?.traceparent).toBe(
      `00-${parentTraceId}-${attempt!.spanContext().spanId}-01`,
    );
    expect(recorded?.trace?.tracestate).toBe('vendor=x');
  });

  it('sends the attempt span as traceparent on a streamed HTTP upstream call', async () => {
    const { chat } = testGateway(testConfig(base()));
    const res = await chat({ model: 'remote', messages: msg('hi'), stream: true });
    expect(res.status).toBe(200);
    const traceId = res.headers.get('x-sy-trace-id')!;
    await res.text();
    const server = await serverSpan(traceId);
    const [attempt] = traceOf(traceId).childrenOf(server);
    const recorded = mock.stats().recent.find((r) => r.path === '/v1/chat/completions');
    expect(recorded?.trace?.traceparent).toBe(`00-${traceId}-${attempt!.spanContext().spanId}-01`);
  });

  it('nests under the active span of a host app that mounts the gateway', async () => {
    const { chat } = testGateway(testConfig(base()));
    const host = tracer().startSpan('host GET /llm', { kind: SpanKind.SERVER });
    // The host's instrumentation already consumed the caller's headers: the active span wins.
    const res = await context.with(trace.setSpan(context.active(), host), () =>
      chat(
        { model: 'plain', messages: msg('hi') },
        { traceparent: `00-${parentTraceId}-${parentSpanId}-01` },
      ),
    );
    await res.json();
    host.end();
    const traceId = host.spanContext().traceId;
    expect(res.headers.get('x-sy-trace-id')).toBe(traceId);
    const server = await serverSpan(traceId);
    expect(server.parentSpanContext?.spanId).toBe(host.spanContext().spanId);
  });

  it('honours an unsampled parent: no spans recorded, decision still propagated upstream', async () => {
    const { chat } = testGateway(testConfig(base()));
    const res = await chat(
      { model: 'remote', messages: msg('hi') },
      { traceparent: `00-${parentTraceId}-${parentSpanId}-00` },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sy-trace-id')).toBeNull();
    await res.json();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    const recorded = mock.stats().recent.find((r) => r.path === '/v1/chat/completions');
    // The (unrecorded) server span gets its own id; trace id and the "not sampled" flag carry on.
    expect(recorded?.trace?.traceparent).toMatch(
      new RegExp(`^00-${parentTraceId}-[0-9a-f]{16}-00$`),
    );
  });

  it('each HTTP attempt of a fallback carries its own span id', async () => {
    const { chat } = testGateway(testConfig(base()));
    const res = await chat({ model: 'remote-fallback', messages: msg('hi') });
    expect(res.status).toBe(200);
    const traceId = res.headers.get('x-sy-trace-id')!;
    await res.json();
    const server = await serverSpan(traceId);
    const spanIds = traceOf(traceId)
      .childrenOf(server)
      .map((s) => s.spanContext().spanId);
    const sent = mock
      .stats()
      .recent.filter((r) => r.path === '/v1/chat/completions')
      .map((r) => r.trace?.traceparent?.split('-')[2]);
    expect(sent).toHaveLength(2);
    expect(new Set(sent)).toEqual(new Set(spanIds));
  });

  it('adds trace_id and span_id of the server span to request log lines', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: 'info',
      destination: new Writable({
        write(chunk: Buffer, _enc, cb) {
          lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
          cb();
        },
      }),
    });
    const { chat } = testGateway(testConfig(base()), { logger });
    const res = await chat({ model: 'plain', messages: msg('hi') });
    const traceId = res.headers.get('x-sy-trace-id')!;
    await res.json();
    const server = await serverSpan(traceId);
    const completed = lines.find((l) => l.msg === 'request completed');
    expect(completed).toMatchObject({
      trace_id: traceId,
      span_id: server.spanContext().spanId,
    });
  });

  it('injects the active span into opencode bridge calls and every upstreamFetch user', async () => {
    const seen: (string | null)[] = [];
    const fetchSpy = async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('traceparent'));
      return new Response(JSON.stringify({ id: 'ses_1', healthy: true }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const span = tracer().startSpan('attempt');
    const signal = new AbortController().signal;
    await context.with(trace.setSpan(context.active(), span), async () => {
      const client = new OpencodeClient(
        'copilot',
        { base_url: 'http://opencode.test' } as ConstructorParameters<typeof OpencodeClient>[1],
        fetchSpy,
      );
      await client.createSession('t', signal);
      // openai-compatible, openai and anthropic adapters all go through upstreamFetch.
      await upstreamJson({
        provider: 'p',
        url: 'http://upstream.test',
        body: {},
        signal,
        fetch: fetchSpy,
      });
    });
    span.end();
    const expected = `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`;
    expect(seen).toEqual([expected, expected]);
  });

  it('does not trace health, readiness or metrics', async () => {
    const { request } = testGateway(testConfig(base()));
    await request('/healthz');
    await request('/readyz');
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
