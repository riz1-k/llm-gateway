import { createGateway, type CreateGatewayOptions, type Gateway } from '../src/app.js';
import { parseConfig } from '../src/config/load.js';
import type { ResolvedConfig, ResolvedModel, ResolvedRoute } from '../src/config/resolve.js';
import { silentLogger } from '../src/observability/logger.js';
import type { AttemptContext } from '../src/providers/base.js';
import { MemoryUsageSink } from '../src/usage/sinks.js';

export const KEY = 'sk-sy-test-key-0001';
export const ADMIN = 'sk-sy-test-admin-01';

/** Builds a validated config from a partial object with sane test defaults. */
export function testConfig(
  partial: Record<string, unknown>,
  env: Record<string, string> = {},
): ResolvedConfig {
  return parseConfig(
    {
      server: { port: 0, request_timeout_ms: 10_000 },
      auth: { admin_token: ADMIN, static_keys: [{ key: KEY, team: 'test', name: 'test' }] },
      retry: { attempts: 2, backoff_ms: 1, max_backoff_ms: 5 },
      observability: { log_level: 'silent' },
      ...partial,
    },
    { env, pricing: {} },
  );
}

export interface TestGateway {
  gateway: Gateway;
  usage: MemoryUsageSink;
  request(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  chat(body: Record<string, unknown>, headers?: Record<string, string>): Promise<Response>;
}

export function testGateway(
  config: ResolvedConfig,
  opts: Partial<CreateGatewayOptions> = {},
): TestGateway {
  const usage = new MemoryUsageSink();
  const gateway = createGateway({
    config,
    logger: silentLogger(),
    ...opts,
    services: { usage, ...opts.services },
  });
  const request = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    gateway.fetch(
      new Request(`http://gateway.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );
  return {
    gateway,
    usage,
    request,
    chat: (body, headers) => request('/v1/chat/completions', body, headers),
  };
}

/** Parses an SSE response body into JSON payloads (and the literal "[DONE]"). */
export async function readSSE(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) =>
      block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n'),
    )
    .filter(Boolean)
    .map((d) => (d === '[DONE]' ? '[DONE]' : (JSON.parse(d) as unknown)));
}

export function attemptContext(overrides: Partial<AttemptContext> = {}): AttemptContext {
  return {
    requestId: 'req_test',
    signal: new AbortController().signal,
    logger: silentLogger(),
    requestHeaders: new Headers(),
    route: testRoute(),
    attempt: 1,
    ...overrides,
  };
}

export function testRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    name: 'test-route',
    kind: 'chat',
    description: undefined,
    targets: [{ model: 'm', weight: 1, timeoutMs: undefined }],
    strategy: 'fallback',
    retry: { attempts: 1, backoff_ms: 0, max_backoff_ms: 0, max_retry_after_ms: 20_000 },
    timeoutMs: 10_000,
    cache: undefined,
    defaults: {},
    hidden: false,
    direct: false,
    ...overrides,
  };
}

export function modelFrom(config: ResolvedConfig, name: string): ResolvedModel {
  const m = config.models[name];
  if (!m) throw new Error(`no model ${name}`);
  return m;
}
