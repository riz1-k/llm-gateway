import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveMetrics } from '../../src/server.js';
import { readSSE } from '../helpers.js';
import { chatBody, harness, type PlatformHarness } from './helpers.js';

/** Every metric name SPEC §13 requires (prefix `sy_`). */
const SPEC_METRICS = [
  'sy_requests_total',
  'sy_request_duration_seconds',
  'sy_upstream_duration_seconds',
  'sy_ttft_seconds',
  'sy_tokens_total',
  'sy_cost_usd_total',
  'sy_cache_saved_usd_total',
  'sy_cache_requests_total',
  'sy_ratelimit_rejections_total',
  'sy_budget_rejections_total',
  'sy_budget_utilization_ratio',
  'sy_fallbacks_total',
  'sy_retries_total',
  'sy_circuit_state',
  'sy_inflight_requests',
  'sy_provider_queue_wait_seconds',
  'sy_usage_stream_lag',
] as const;

let h: PlatformHarness;
beforeAll(async () => {
  h = await harness('metrics');
});
afterAll(async () => h?.close());

const scrape = async (): Promise<string> => {
  const r = await h.gateway.fetch(new Request('http://gateway.test/metrics'));
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toContain('text/plain');
  return r.text();
};

/** True when at least one sample line (not HELP/TYPE) of `name` matches every label fragment. */
const sample = (text: string, name: string, ...fragments: string[]): boolean =>
  text
    .split('\n')
    .some(
      (l) =>
        (l.startsWith(`${name}{`) || l.startsWith(`${name} `)) &&
        fragments.every((f) => l.includes(f)),
    );

describe('Prometheus /metrics', () => {
  it('exposes every SPEC §13 metric with samples after representative traffic', async () => {
    const admin = h.platform.admin!;
    // Plain request, then a cache hit (saved USD), a stream (TTFT), an embedding.
    expect((await h.request('/v1/chat/completions', chatBody('metrics one'))).status).toBe(200);
    expect(
      (await h.request('/v1/chat/completions', chatBody('metrics one'))).headers.get('x-sy-cache'),
    ).toBe('hit');
    await readSSE(
      await h.request('/v1/chat/completions', chatBody('metrics stream', { stream: true })),
    );
    expect((await h.request('/v1/embeddings', { model: 'embed', input: ['a', 'b'] })).status).toBe(
      200,
    );
    // Semantic route: one miss then a semantic lookup.
    await h.request('/v1/chat/completions', {
      ...chatBody('what is the capital of france'),
      model: 'sem',
    });
    // Retry + fallback: the first target fails with 503, the second answers.
    const fb = await h.request(
      '/v1/chat/completions',
      { ...chatBody('fallback please'), model: 'fb' },
      {
        'x-mock-status': '503',
        'x-mock-fault-target': 'mock-echo',
      },
    );
    expect(fb.status).toBe(200);
    // Rate-limit rejection (team rpm 1) and budget rejection (tiny budget).
    await admin.createTeam('test', { slug: 'rl', rpm_limit: 1 });
    const rlKey = (await admin.createKey('test', 'rl', { name: 'k' })).key;
    await h.request(
      '/v1/chat/completions',
      { ...chatBody('x'), model: 'free' },
      { authorization: `Bearer ${rlKey}` },
    );
    const limited = await h.request(
      '/v1/chat/completions',
      { ...chatBody('x'), model: 'free' },
      { authorization: `Bearer ${rlKey}` },
    );
    expect(limited.status).toBe(429);
    await admin.createTeam('test', {
      slug: 'poor',
      budgets: { daily: { limit_usd: 0.000001, soft_threshold: 0.8, action: 'block' } },
    });
    const poorKey = (await admin.createKey('test', 'poor', { name: 'k' })).key;
    const auth = { authorization: `Bearer ${poorKey}`, 'x-sy-cache': 'bypass' };
    let status = 200;
    for (let i = 0; i < 5 && status === 200; i++)
      status = (await h.request('/v1/chat/completions', chatBody(`spend ${i}`), auth)).status;
    expect(status).toBe(402);

    const text = await scrape();
    for (const name of SPEC_METRICS) expect(text, name).toContain(`# TYPE ${name} `);
    expect(
      sample(
        text,
        'sy_requests_total',
        'route="echo"',
        'provider="mock"',
        'status="200"',
        'cache="hit"',
      ),
    ).toBe(true);
    expect(sample(text, 'sy_request_duration_seconds_bucket', 'route="echo"')).toBe(true);
    expect(
      sample(text, 'sy_upstream_duration_seconds_count', 'provider="mock"', 'model="mock-echo"'),
    ).toBe(true);
    expect(sample(text, 'sy_ttft_seconds_count', 'route="echo"')).toBe(true);
    expect(sample(text, 'sy_tokens_total', 'team="test"', 'type="prompt"')).toBe(true);
    expect(sample(text, 'sy_tokens_total', 'type="completion"')).toBe(true);
    expect(
      sample(text, 'sy_cost_usd_total', 'team="test"', 'route="echo"', 'provider="mock"'),
    ).toBe(true);
    expect(sample(text, 'sy_cache_saved_usd_total', 'team="test"', 'route="echo"')).toBe(true);
    expect(sample(text, 'sy_cache_requests_total', 'kind="exact"', 'result="hit"')).toBe(true);
    expect(sample(text, 'sy_cache_requests_total', 'kind="semantic"')).toBe(true);
    // Each rejection is counted exactly once (one 429, one 402 above).
    expect(text).toContain('sy_ratelimit_rejections_total{scope="team",limit="rpm"} 1\n');
    expect(text).toContain('sy_budget_rejections_total{team="poor"} 1\n');
    // Routes without a cache never report cache lookups.
    expect(sample(text, 'sy_cache_requests_total', 'route="free"')).toBe(false);
    expect(sample(text, 'sy_budget_utilization_ratio', 'team="poor"', 'period="daily"')).toBe(true);
    expect(
      sample(text, 'sy_fallbacks_total', 'route="fb"', 'from="mock-echo"', 'to="mock-fixed"'),
    ).toBe(true);
    expect(sample(text, 'sy_retries_total', 'target="mock-echo"')).toBe(true);
    expect(sample(text, 'sy_circuit_state', 'target="mock-echo"')).toBe(true);
    expect(sample(text, 'sy_inflight_requests', 'provider="mock"')).toBe(true);
    expect(sample(text, 'sy_provider_queue_wait_seconds_count', 'provider="mock"')).toBe(true);
    expect(sample(text, 'sy_usage_stream_lag')).toBe(true);
  });

  it('serves metrics on a dedicated port when metrics.port is set', async () => {
    const server = await serveMetrics(h.metrics, 0, '127.0.0.1', '/metrics');
    try {
      const { port } = server.address() as AddressInfo;
      const r = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('# TYPE sy_requests_total counter');
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
