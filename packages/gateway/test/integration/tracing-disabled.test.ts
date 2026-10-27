import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { startMockServer } from '@switchyard/mock-provider';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';
import { startServer } from '../../src/server.js';
import { KEY } from '../helpers.js';

/**
 * Tracing off (the default): the SDK is never imported, responses carry no trace id, logs carry no
 * trace fields, and nothing is propagated upstream.
 */
const loaded = vi.hoisted(() => ({ sdk: false, sdkTrace: false }));
vi.mock('../../src/observability/otel-sdk.js', async (importOriginal) => {
  loaded.sdk = true;
  return importOriginal();
});
vi.mock('@opentelemetry/sdk-trace', async (importOriginal) => {
  loaded.sdkTrace = true;
  return importOriginal();
});

describe('tracing disabled', () => {
  for (const [label, otel, env] of [
    ['by default', {}, {}],
    ['by OTEL_SDK_DISABLED', { enabled: true }, { OTEL_SDK_DISABLED: 'true' }],
  ] as const) {
    it(`loads no SDK and creates no trace data (${label})`, async () => {
      const mock = await startMockServer({ port: 0, host: '127.0.0.1' });
      const dir = mkdtempSync(join(tmpdir(), 'sy-otel-off-'));
      const configPath = join(dir, 'gateway.yaml');
      writeFileSync(
        configPath,
        JSON.stringify({
          server: { port: 0, host: '127.0.0.1' },
          auth: { static_keys: [{ key: KEY, team: 'test', name: 'test' }] },
          observability: { log_level: 'info', otel },
          metrics: { enabled: false },
          providers: { http: { type: 'openai-compatible', base_url: `${mock.url}/v1` } },
          models: { echo: { provider: 'http', model: 'mock-echo' } },
          routes: { plain: { targets: ['echo'] } },
        }),
      );
      const lines: string[] = [];
      const logger = createLogger({
        level: 'info',
        destination: new Writable({
          write(chunk: Buffer, _enc, cb) {
            lines.push(chunk.toString());
            cb();
          },
        }),
      });
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const server = await startServer({ configPath, logger, platform: false });
      try {
        const res = await fetch(`${server.url}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${KEY}`,
            'content-type': 'application/json',
            traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
          },
          body: JSON.stringify({ model: 'plain', messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-sy-trace-id')).toBeNull();
        await res.json();
      } finally {
        await server.shutdown('test');
        vi.unstubAllEnvs();
        await mock.close();
        rmSync(dir, { recursive: true, force: true });
      }
      expect(loaded.sdk).toBe(false);
      expect(loaded.sdkTrace).toBe(false);
      const completed = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.msg === 'request completed');
      expect(completed).toBeDefined();
      expect(completed).not.toHaveProperty('trace_id');
      // Without a propagator the incoming traceparent is not forwarded either.
      const recorded = mock.stats().recent.find((r) => r.path === '/v1/chat/completions');
      expect(recorded?.trace).toBeUndefined();
    });
  }
});
