import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { silentLogger } from '../../src/observability/logger.js';
import { resolveTracingSettings, startTracing } from '../../src/observability/tracing.js';
import { startServer } from '../../src/server.js';
import { KEY } from '../helpers.js';

/**
 * Switchyard's own SDK (`startServer` → `startTracing`): lazy loading, OTLP/HTTP export to a fake
 * collector, flush on shutdown, and the settings precedence (config file > OTEL_* > defaults).
 */
const loaded = vi.hoisted(() => ({ sdk: false }));
vi.mock('../../src/observability/otel-sdk.js', async (importOriginal) => {
  loaded.sdk = true;
  return importOriginal();
});

interface OtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: number;
  attributes: { key: string; value: Record<string, unknown> }[];
}
interface OtlpBody {
  resourceSpans: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] };
    scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
  }[];
}

let collector: Server;
let collectorUrl: string;
const received: OtlpBody[] = [];
let dir: string;

const minimalConfig = (otel: Record<string, unknown>) => ({
  server: { port: 0, host: '127.0.0.1' },
  auth: { static_keys: [{ key: KEY, team: 'test', name: 'test' }] },
  observability: { log_level: 'silent', otel },
  metrics: { enabled: false },
  providers: { mock: { type: 'mock' } },
  models: { echo: { provider: 'mock', model: 'mock-echo' } },
  routes: { plain: { targets: ['echo'] } },
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sy-otel-'));
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/traces') received.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  collectorUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => collector.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('startServer with observability.otel.enabled', () => {
  it('exports the request trace over OTLP/HTTP and flushes it on shutdown', async () => {
    const configPath = join(dir, 'gateway.yaml');
    writeFileSync(
      configPath,
      JSON.stringify(
        minimalConfig({
          enabled: true,
          endpoint: collectorUrl,
          service_name: 'sy-test',
          sample_ratio: 1,
          resource_attributes: { 'deployment.environment.name': 'test' },
        }),
      ),
    );
    const server = await startServer({ configPath, logger: silentLogger(), platform: false });
    expect(loaded.sdk).toBe(true);
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'plain', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const traceId = res.headers.get('x-sy-trace-id');
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    await res.json();
    await server.shutdown('test');

    const spans = received.flatMap((b) =>
      b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)),
    );
    const mine = spans.filter((s) => s.traceId === traceId);
    expect(mine.map((s) => s.name).sort()).toEqual(['POST /v1/chat/completions', 'chat mock-echo']);
    const resource = Object.fromEntries(
      received[0]!.resourceSpans[0]!.resource.attributes.map((a) => [a.key, a.value.stringValue]),
    );
    expect(resource).toMatchObject({
      'service.name': 'sy-test',
      'service.version': expect.any(String),
      'deployment.environment.name': 'test',
    });
    expect(received[0]!.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe('switchyard-gateway');
    // Shutdown unregistered the provider: the API is back to no-op.
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});

describe('settings precedence', () => {
  const cfg = (otel: Record<string, unknown>) =>
    parseConfig(minimalConfig(otel), { env: {}, pricing: {} });

  it('config values win over OTEL_* variables, which fill in the gaps', () => {
    const env = {
      OTEL_SERVICE_NAME: 'from-env',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env:4318',
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.25',
      OTEL_RESOURCE_ATTRIBUTES: 'team.name=core,deployment.environment.name=prod%20eu',
    };
    const fromEnv = resolveTracingSettings(cfg({ enabled: true }), env);
    expect(fromEnv).toMatchObject({
      enabled: true,
      serviceName: 'from-env',
      sampleRatio: 0.25,
      resourceAttributes: { 'team.name': 'core', 'deployment.environment.name': 'prod eu' },
      propagators: ['tracecontext', 'baggage'],
    });
    // Endpoint left to the exporter, which reads OTEL_EXPORTER_OTLP_* itself.
    expect(fromEnv.url).toBeUndefined();

    const fromFile = resolveTracingSettings(
      cfg({
        enabled: 'true',
        endpoint: 'http://tempo:4318/',
        service_name: 'gw',
        sample_ratio: 0.5,
        resource_attributes: { 'deployment.environment.name': 'staging' },
      }),
      env,
    );
    expect(fromFile).toMatchObject({
      enabled: true,
      url: 'http://tempo:4318/v1/traces',
      serviceName: 'gw',
      sampleRatio: 0.5,
      resourceAttributes: { 'team.name': 'core', 'deployment.environment.name': 'staging' },
    });
  });

  it('defaults, OTEL_SDK_DISABLED and OTEL_PROPAGATORS', () => {
    expect(resolveTracingSettings(cfg({}), {})).toMatchObject({
      enabled: false,
      serviceName: 'switchyard',
      sampleRatio: 1,
    });
    expect(
      resolveTracingSettings(cfg({ enabled: true }), { OTEL_SDK_DISABLED: 'true' }),
    ).toMatchObject({
      enabled: false,
      reason: 'OTEL_SDK_DISABLED=true',
    });
    expect(
      resolveTracingSettings(cfg({ enabled: true }), { OTEL_PROPAGATORS: 'tracecontext' })
        .propagators,
    ).toEqual(['tracecontext']);
    expect(
      resolveTracingSettings(cfg({ enabled: true }), { OTEL_TRACES_SAMPLER: 'always_off' })
        .sampleRatio,
    ).toBe(0);
  });

  it('keeps an already registered TracerProvider (embedder) and reports inactive', async () => {
    const { TracerProvider } = await import('@opentelemetry/sdk-trace');
    const host = new TracerProvider();
    trace.setGlobalTracerProvider(host);
    const handle = await startTracing(cfg({ enabled: true, endpoint: collectorUrl }), {
      logger: silentLogger(),
    });
    expect(handle.active).toBe(false);
    trace.disable();
    await host.shutdown();
  });
});
