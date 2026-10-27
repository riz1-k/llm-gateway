import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createGateway, type CreateGatewayOptions, type Gateway } from './app.js';
import { loadConfig } from './config/load.js';
import { createLogger, type Logger } from './observability/logger.js';

export interface StartServerOptions extends Partial<Omit<CreateGatewayOptions, 'config'>> {
  configPath: string;
  port?: number;
  host?: string;
  /** Install SIGHUP (reload) and SIGTERM/SIGINT (graceful shutdown) handlers. */
  handleSignals?: boolean;
  logger?: Logger;
}

export interface RunningServer {
  gateway: Gateway;
  url: string;
  port: number;
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

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const config = loadConfig(opts.configPath);
  const logger = opts.logger ?? createLogger({ level: config.raw.observability.log_level });
  const gateway = createGateway({
    ...opts,
    config,
    logger,
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
  logger.info(
    { url, routes: Object.keys(config.routes), config: config.sourcePath },
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

  return { gateway, url, port: addr.port, shutdown };
}
