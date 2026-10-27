import { serve, type ServerType } from '@hono/node-server';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGateway, type CreateGatewayOptions, type Gateway } from './app.js';
import { loadConfig } from './config/load.js';
import { createLogger, type Logger } from './observability/logger.js';
import { PromMetrics } from './observability/metrics.js';
import { createPlatform, type Platform } from './platform/index.js';

/**
 * Options for `startServer`: a config file path plus any `createGateway` option except `config`.
 */
export interface StartServerOptions extends Partial<
  Omit<CreateGatewayOptions, 'config' | 'platform'>
> {
  configPath: string;
  port?: number;
  host?: string;
  /** Install SIGHUP (reload) and SIGTERM/SIGINT (graceful shutdown) handlers. */
  handleSignals?: boolean;
  logger?: Logger;
  /**
   * Build the Redis/Postgres platform from `redis.url` / `database.url` (default true). Pass a
   * Platform to use your own, or false for a purely in-memory gateway.
   */
  platform?: Platform | boolean;
}

/** Strips credentials from a connection URL before it is logged. */
export function redactUrl(url: string | undefined): string {
  if (!url) return '(unset)';
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable url)';
  }
}

/**
 * Checks Redis/Postgres once with actionable hints, then starts the platform without letting an
 * unreachable Redis block the listener (the subscription completes once Redis is back).
 */
async function startPlatform(
  platform: Platform,
  config: ReturnType<typeof loadConfig>,
  logger: Logger,
): Promise<void> {
  const raw = config.raw;
  const checks = await platform.readiness();
  if (checks.redis && !checks.redis.ok) {
    logger.warn(
      {
        redis: redactUrl(raw.redis?.url),
        hint:
          'Start Redis 8+, fix redis.url, or remove redis.url to run in-memory. Until then ' +
          (raw.redis?.fail_open === false
            ? 'rate-limited and budgeted requests get 503 (redis.fail_open: false).'
            : 'rate limits, budgets and the shared cache are skipped (redis.fail_open: true).'),
      },
      'Redis is unreachable',
    );
  }
  if (checks.postgres && !checks.postgres.ok) {
    logger.warn(
      {
        postgres: redactUrl(raw.database?.url),
        hint:
          'Start Postgres or fix database.url, then run `switchyard migrate`. Until then ' +
          'database keys and the admin data API answer 503; static keys keep working.',
      },
      'Postgres is unreachable',
    );
  }
  const timeoutMs = raw.redis?.connect_timeout_ms ?? 5_000;
  let timer: NodeJS.Timeout | undefined;
  const started = await Promise.race([
    platform.start().then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  if (!started)
    logger.warn(
      { timeout_ms: timeoutMs },
      'platform still connecting; serving now (key invalidation and the in-process usage writer start once Redis is reachable)',
    );
}

/** Handle returned by `startServer`. */
export interface RunningServer {
  gateway: Gateway;
  url: string;
  port: number;
  /** Separate metrics listener (`metrics.port`), if configured. */
  metricsUrl?: string;
  /** Graceful shutdown: stop accepting, drain in-flight requests (bounded), close providers. */
  shutdown(reason?: string): Promise<void>;
}

const waitFor = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
};

/**
 * Loads the config, creates the platform layer (when Redis/Postgres are configured) and the
 * gateway, and serves it over HTTP with graceful shutdown. This is what `switchyard serve` runs.
 */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const config = loadConfig(opts.configPath);
  const logger = opts.logger ?? createLogger({ level: config.raw.observability.log_level });
  const wantsPlatform = Boolean(config.raw.redis?.url || config.raw.database?.url);
  const platform: Platform | undefined =
    typeof opts.platform === 'object'
      ? opts.platform
      : opts.platform !== false && wantsPlatform
        ? createPlatform(config, { logger })
        : undefined;
  if (platform) await startPlatform(platform, config, logger);
  const { platform: _ignored, ...rest } = opts;
  void _ignored;
  const gateway = createGateway({
    ...rest,
    config,
    logger,
    ...(platform ? { platform } : {}),
    reloadSource: opts.reloadSource ?? (() => loadConfig(opts.configPath)),
  });
  const port = opts.port ?? config.raw.server.port;
  const hostname = opts.host ?? config.raw.server.host;

  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: gateway.app.fetch, port, hostname }, () => resolve(s));
  });
  // Long generations: never let Node cut requests that the route deadline allows.
  if ('requestTimeout' in server) {
    (server as unknown as { requestTimeout: number }).requestTimeout = 0;
    (server as unknown as { headersTimeout: number }).headersTimeout = 60_000;
  }
  const addr = server.address() as AddressInfo;
  const url = `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${addr.port}`;
  let metricsServer: Server | undefined;
  let metricsUrl: string | undefined;
  const prom = gateway.metrics instanceof PromMetrics ? gateway.metrics : undefined;
  if (prom && config.raw.metrics.port !== undefined) {
    metricsServer = await serveMetrics(
      prom,
      config.raw.metrics.port,
      hostname,
      config.raw.metrics.path,
    );
    const maddr = metricsServer.address() as AddressInfo;
    metricsUrl = `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${maddr.port}${config.raw.metrics.path}`;
  }
  logger.info(
    {
      url,
      routes: Object.keys(config.routes),
      config: config.sourcePath,
      platform: platform
        ? {
            redis: Boolean(platform.redis),
            postgres: Boolean(platform.database),
            in_process_writer: Boolean(platform.worker),
          }
        : false,
      ...(metricsUrl ? { metrics: metricsUrl } : {}),
    },
    'switchyard listening',
  );

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (reason = 'shutdown'): Promise<void> => {
    shuttingDown ??= (async () => {
      logger.info({ reason, inflight: gateway.inflight }, 'graceful shutdown started');
      gateway.setDraining(true);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      const drained = await waitFor(
        () => gateway.inflight === 0,
        config.raw.server.shutdown_grace_ms,
      );
      if (!drained)
        logger.warn(
          { inflight: gateway.inflight },
          'grace period elapsed; closing remaining connections',
        );
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await closed;
      if (metricsServer) await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
      await gateway.close();
      logger.info('shutdown complete');
    })();
    return shuttingDown;
  };

  if (opts.handleSignals) {
    process.on('SIGHUP', () => {
      gateway
        .reload()
        .catch((err: unknown) =>
          logger.error(
            { err: (err as Error).message },
            'config reload failed; keeping previous config',
          ),
        );
    });
    const onTerm = (sig: string) => () => {
      void shutdown(sig).then(() => process.exit(0));
    };
    process.once('SIGTERM', onTerm('SIGTERM'));
    process.once('SIGINT', onTerm('SIGINT'));
  }

  return { gateway, url, port: addr.port, ...(metricsUrl ? { metricsUrl } : {}), shutdown };
}

/** Minimal HTTP listener exposing only the Prometheus registry (and /healthz). */
export async function serveMetrics(
  prom: PromMetrics,
  port: number,
  host: string,
  path = '/metrics',
): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url?.split('?')[0];
    if (req.method === 'GET' && url === path) {
      prom
        .expose()
        .then(({ contentType, body }) => {
          res.writeHead(200, { 'content-type': contentType });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
      return;
    }
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
}
