import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { platformAdminRoutes } from './admin/routes.js';
import { extractBearer, secretsEqual, StaticKeyStore } from './auth/keys.js';
import { NoopCacheStore } from './cache/store.js';
import { parseCacheMode } from './cache/keys.js';
import type { ResolvedConfig } from './config/resolve.js';
import { GatewayError } from './core/errors.js';
import { resolveRequestId, nowSeconds } from './core/ids.js';
import { Pipeline, type PipelineResult, type RequestContext } from './core/pipeline.js';
import { Router } from './core/router.js';
import type { ApiKeyRecord, GatewayServices } from './core/services.js';
import { StrategyRegistry } from './core/strategies.js';
import { parseChatRequest, parseEmbeddingRequest, parseRerankRequest } from './http/validation.js';
import { initTokenizer } from './limits/estimate.js';
import { NoopBudgetGuard } from './limits/budgets.js';
import { NoopRateLimiter } from './limits/ratelimit.js';
import { createLogger, type Logger } from './observability/logger.js';
import { noopMetrics, PromMetrics, type GatewayMetrics } from './observability/metrics.js';
import type { Platform } from './platform/index.js';
import type { FetchLike } from './providers/http.js';
import { ProviderRegistry, type AdapterFactory } from './providers/registry.js';
import { MemoryBreakerStore } from './resilience/circuit-breaker.js';
import { ConcurrencyManager } from './resilience/concurrency.js';
import type { Random } from './resilience/retry.js';
import { LogUsageSink } from './usage/sinks.js';

export interface CreateGatewayOptions {
  config: ResolvedConfig;
  /** Override any subsystem (wave H plugs Redis/Postgres implementations in here). */
  services?: Partial<GatewayServices>;
  logger?: Logger;
  /** fetch used by provider adapters (tests). */
  fetch?: FetchLike;
  adapterFactories?: Partial<Record<string, AdapterFactory>>;
  /** Re-reads the config source for `POST /admin/config/reload` and SIGHUP. */
  reloadSource?: () => ResolvedConfig | Promise<ResolvedConfig>;
  random?: Random;
  clock?: () => number;
  /**
   * Redis/Postgres platform layer (`createPlatform(config)`): supplies services, metrics, the admin
   * data API and readiness checks. Explicit `services` still take precedence.
   */
  platform?: Platform;
  /** Instrumentation hooks (default: the platform's Prometheus registry, else no-op). */
  metrics?: GatewayMetrics;
}

type Env = {
  Variables: {
    requestId: string;
    startedAt: number;
    logger: Logger;
    key: ApiKeyRecord;
  };
};

/** Everything derived from one config version. Swapped atomically on reload. */
interface Snapshot {
  config: ResolvedConfig;
  registry: ProviderRegistry;
  router: Router;
  pipeline: Pipeline;
  refs: number;
  retired: boolean;
}

export interface Gateway {
  readonly app: Hono<Env>;
  /** Fetch handler (usable with any Fetch-API server or `app.request`). */
  fetch(request: Request): Promise<Response>;
  readonly config: ResolvedConfig;
  readonly services: GatewayServices;
  readonly logger: Logger;
  readonly metrics: GatewayMetrics;
  /** Number of requests (including open streams) currently being served. */
  readonly inflight: number;
  /** Atomically swap to a new config; in-flight requests finish on the old snapshot. */
  reload(config?: ResolvedConfig): Promise<ResolvedConfig>;
  /** Readiness → 503; used during graceful shutdown. */
  setDraining(draining: boolean): void;
  close(): Promise<void>;
}

/** Wraps a body stream so `onDone` runs exactly once when it completes, errors or is cancelled. */
function withFinally(
  stream: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    onDone();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await reader.read();
        if (r.done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(r.value);
        }
      } catch (err) {
        controller.error(err);
        finish();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      finish();
    },
  });
}

function errorResponse(c: Context<Env>, err: GatewayError): Response {
  for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
  return c.json(err.toJSON(), err.status as ContentfulStatusCode);
}

/**
 * Creates the gateway: a Hono app plus runtime state (providers, breakers, semaphores, strategy
 * state). Breakers, semaphores and strategy state survive config reloads.
 */
export function createGateway(opts: CreateGatewayOptions): Gateway {
  const logger = opts.logger ?? createLogger({ level: opts.config.raw.observability.log_level });
  void initTokenizer().catch((err: unknown) =>
    logger.warn({ err }, 'tokenizer unavailable; using heuristic estimates'),
  );

  const platform = opts.platform;
  const provided: Partial<GatewayServices> = { ...platform?.services, ...opts.services };
  const services: GatewayServices = {
    keys: provided.keys ?? new StaticKeyStore(opts.config.raw.auth.static_keys),
    rateLimiter: provided.rateLimiter ?? new NoopRateLimiter(),
    budgets: provided.budgets ?? new NoopBudgetGuard(),
    cache: provided.cache ?? new NoopCacheStore(),
    usage: provided.usage ?? new LogUsageSink(logger.child({ component: 'usage' })),
    breakers: provided.breakers ?? new MemoryBreakerStore(opts.clock),
    semantic: provided.semantic,
  };
  const keysFromConfig = !provided.keys;
  const metrics: GatewayMetrics = opts.metrics ?? platform?.metrics ?? noopMetrics;
  const prom = metrics instanceof PromMetrics ? metrics : undefined;
  const concurrency = new ConcurrencyManager();
  const strategies = new StrategyRegistry(opts.random);
  const startedAt = nowSeconds();
  let draining = false;
  let inflight = 0;
  prom?.setSources({
    circuitStates: async () =>
      (await services.breakers.snapshot(current.config.breaker)).map((b) => ({
        target: b.target,
        state: b.state === 'closed' ? 0 : b.state === 'half_open' ? 1 : 2,
      })),
    inflight: () =>
      Object.fromEntries(Object.entries(concurrency.stats()).map(([p, st]) => [p, st.inflight])),
  });

  const build = (config: ResolvedConfig): Snapshot => {
    const registry = new ProviderRegistry(
      config,
      { logger, ...(opts.fetch ? { fetch: opts.fetch } : {}) },
      opts.adapterFactories,
    );
    const router = new Router(config, registry, {
      breakers: services.breakers,
      concurrency,
      strategies,
      metrics,
      ...(opts.random ? { random: opts.random } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    const pipeline = new Pipeline({
      config,
      router,
      services,
      metrics,
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    for (const w of config.warnings) logger.warn(w);
    return { config, registry, router, pipeline, refs: 0, retired: false };
  };

  let current = build(opts.config);

  const release = (snap: Snapshot): void => {
    snap.refs--;
    if (snap.retired && snap.refs === 0) void snap.registry.close();
  };

  const app = new Hono<Env>();

  // --- request context: id, logger, timing, in-flight tracking --------------------------------
  app.use('*', async (c, next) => {
    const requestId = resolveRequestId(c.req.header('x-request-id'));
    c.set('requestId', requestId);
    c.set('startedAt', opts.clock?.() ?? Date.now());
    c.set('logger', logger.child({ requestId }));
    inflight++;
    let streaming = false;
    try {
      await next();
      c.res.headers.set('x-request-id', requestId);
      streaming = c.res.headers.get('content-type')?.startsWith('text/event-stream') ?? false;
      if (streaming && c.res.body) {
        const res = c.res;
        c.res = new Response(
          withFinally(res.body!, () => inflight--),
          { status: res.status, headers: res.headers },
        );
      }
    } finally {
      if (!streaming) inflight--;
    }
  });

  app.onError((err, c) => {
    if (err instanceof GatewayError) return errorResponse(c, err);
    if (err instanceof HTTPException) {
      const status = err.status;
      const code =
        status === 413 ? 'invalid_request' : status >= 500 ? 'internal_error' : 'invalid_request';
      return errorResponse(
        c,
        new GatewayError(status, code, status === 413 ? 'Request body too large' : err.message),
      );
    }
    (c.get('logger') ?? logger).error({ err }, 'unhandled error');
    return errorResponse(
      c,
      new GatewayError(500, 'internal_error', 'Internal server error', { type: 'api_error' }),
    );
  });

  app.notFound((c) =>
    errorResponse(
      c,
      new GatewayError(404, 'not_found', `Unknown endpoint ${c.req.method} ${c.req.path}`),
    ),
  );

  // --- health ---------------------------------------------------------------------------------
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    if (draining) return c.json({ status: 'draining' }, 503);
    const body: Record<string, unknown> = {
      status: 'ready',
      routes: Object.keys(current.config.routes).length,
    };
    if (platform) {
      const checks = await platform.readiness();
      body.checks = checks;
      if (Object.values(checks).some((ch) => !ch.ok)) {
        body.status = 'unavailable';
        return c.json(body, 503);
      }
    }
    if (c.req.query('probe') === '1') {
      const checks = await Promise.all(
        current.registry
          .entries()
          .map(
            async ([name, a]) =>
              [
                name,
                a.health
                  ? await a.health(AbortSignal.timeout(3000))
                  : { ok: true, detail: 'no health check' },
              ] as const,
          ),
      );
      body.providers = Object.fromEntries(checks);
    }
    return c.json(body);
  });

  // --- admin (minimal in core; wave H adds the full admin API) -------------------------------
  const admin = new Hono<Env>();
  admin.use('*', async (c, next) => {
    const token = extractBearer(c.req.raw.headers);
    const expected = current.config.raw.auth.admin_token;
    if (!expected || !token || !secretsEqual(token, expected)) {
      throw new GatewayError(401, 'invalid_api_key', 'Invalid admin token');
    }
    await next();
  });
  admin.post('/config/reload', async (c) => {
    const cfg = await gateway.reload();
    return c.json({ status: 'reloaded', routes: Object.keys(cfg.routes), warnings: cfg.warnings });
  });
  admin.get('/providers/health', async (c) => {
    const breakers = await services.breakers.snapshot(current.config.breaker);
    const latency = Object.fromEntries(
      Object.keys(current.config.models).map((m) => [
        m,
        strategies.leastLatency.latency(m) ?? null,
      ]),
    );
    return c.json({ breakers, concurrency: concurrency.stats(), ewma_latency_ms: latency });
  });
  admin.route(
    '/',
    platformAdminRoutes({ getService: () => platform?.admin, config: () => current.config }),
  );
  app.route('/admin', admin);

  // --- Prometheus ------------------------------------------------------------------------------
  const metricsCfg = opts.config.raw.metrics;
  if (prom && metricsCfg.port === undefined) {
    app.get(metricsCfg.path, async (c) => {
      const { contentType, body } = await prom.expose();
      return c.body(body, 200, { 'content-type': contentType });
    });
  }

  // --- OpenAI-compatible API ------------------------------------------------------------------
  const v1 = new Hono<Env>();
  v1.use('*', async (c, next) => {
    const token = extractBearer(c.req.raw.headers);
    if (!token)
      throw new GatewayError(
        401,
        'invalid_api_key',
        'Missing API key. Send `Authorization: Bearer <key>`.',
      );
    const key = await services.keys.verify(token);
    if (!key) throw new GatewayError(401, 'invalid_api_key', 'Incorrect API key provided.');
    c.set('key', key);
    await next();
  });
  const limitBody: MiddlewareHandler<Env> = async (c, next) => {
    const max = current.config.raw.server.body_limit_mb * 1024 * 1024;
    const limiter = bodyLimit({
      maxSize: max,
      onError: () => {
        throw new GatewayError(
          413,
          'invalid_request',
          `Request body exceeds ${current.config.raw.server.body_limit_mb} MB`,
        );
      },
    }) as MiddlewareHandler<Env>;
    return limiter(c, next);
  };
  v1.use('*', limitBody);

  const readJson = async (c: Context<Env>): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      throw GatewayError.invalidRequest('Request body must be valid JSON');
    }
  };

  const requestContext = (c: Context<Env>): RequestContext => {
    const tags = (c.req.header('x-sy-tags') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 32);
    return {
      requestId: c.get('requestId'),
      startedAt: c.get('startedAt'),
      logger: c.get('logger'),
      headers: c.req.raw.headers,
      signal: c.req.raw.signal,
      key: c.get('key'),
      endUser: c.req.header('x-sy-user') ?? undefined,
      tags,
      cacheMode: parseCacheMode(c.req.header('x-sy-cache')),
    };
  };

  /** Runs a pipeline call on the current snapshot, keeping it alive until the response ends. */
  const run = async (
    c: Context<Env>,
    call: (p: Pipeline, rctx: RequestContext) => Promise<PipelineResult>,
  ): Promise<Response> => {
    const snap = current;
    snap.refs++;
    let handedOff = false;
    try {
      const rctx = requestContext(c);
      const result = await call(snap.pipeline, rctx);
      for (const [k, v] of Object.entries(result.headers)) c.header(k, v);
      if (result.kind === 'stream') {
        handedOff = true;
        return c.body(
          withFinally(result.stream, () => release(snap)),
          result.status as ContentfulStatusCode,
        );
      }
      return c.json(result.body, result.status as ContentfulStatusCode);
    } finally {
      if (!handedOff) release(snap);
    }
  };

  v1.post('/chat/completions', async (c) => {
    const req = parseChatRequest(await readJson(c));
    return run(c, (p, rctx) => p.chat({ ...rctx, endUser: rctx.endUser ?? req.user }, req));
  });
  v1.post('/embeddings', async (c) => {
    const req = parseEmbeddingRequest(await readJson(c));
    return run(c, (p, rctx) => p.embeddings({ ...rctx, endUser: rctx.endUser ?? req.user }, req));
  });
  v1.post('/rerank', async (c) => {
    const req = parseRerankRequest(await readJson(c));
    return run(c, (p, rctx) => p.rerank(rctx, req));
  });
  v1.get('/models', (c) =>
    c.json({ object: 'list', data: current.pipeline.listModels(c.get('key'), startedAt) }),
  );
  v1.get('/models/:id', (c) => {
    const card = current.pipeline
      .listModels(c.get('key'), startedAt)
      .find((m) => m.id === c.req.param('id'));
    if (!card)
      throw new GatewayError(
        404,
        'model_not_found',
        `The model \`${c.req.param('id')}\` does not exist or you do not have access to it.`,
        { param: 'model' },
      );
    return c.json(card);
  });
  app.route('/v1', v1);

  const gateway: Gateway = {
    app,
    fetch: (request) => Promise.resolve(app.fetch(request)),
    get config() {
      return current.config;
    },
    services,
    logger,
    metrics,
    get inflight() {
      return inflight;
    },
    async reload(config?: ResolvedConfig) {
      const next = config ?? (opts.reloadSource ? await opts.reloadSource() : undefined);
      if (!next)
        throw new GatewayError(400, 'invalid_request', 'No config source available for reload');
      const old = current;
      current = build(next);
      platform?.setConfig(next);
      if (keysFromConfig) services.keys = new StaticKeyStore(next.raw.auth.static_keys);
      old.retired = true;
      if (old.refs === 0) await old.registry.close();
      logger.info(
        { routes: Object.keys(next.routes).length, source: next.sourcePath },
        'config reloaded',
      );
      return next;
    },
    setDraining(d: boolean) {
      draining = d;
    },
    async close() {
      draining = true;
      await current.registry.close();
      await services.usage.flush?.();
      await services.usage.close?.();
      await services.keys.close?.();
      await platform?.close();
    },
  };
  return gateway;
}
