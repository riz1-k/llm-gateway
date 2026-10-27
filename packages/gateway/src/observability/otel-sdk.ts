import { readFileSync } from 'node:fs';
import {
  context,
  diag,
  DiagLogLevel,
  propagation,
  trace,
  type TextMapPropagator,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  CompositePropagator,
  setGlobalErrorHandler,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import type { Logger } from './logger.js';
import type { TracingHandle, TracingSettings } from './tracing.js';

/**
 * The OpenTelemetry SDK bootstrap. Imported dynamically by `startTracing` only when tracing is
 * enabled, so the SDK packages (optional dependencies) are never loaded otherwise.
 */

/** Package version for `service.version` (dist/ and src/observability/ sit at different depths). */
function packageVersion(): string | undefined {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'switchyard-gateway') return pkg.version;
    } catch {
      // try the next location
    }
  }
  return undefined;
}

/** Logs a message at most once per minute (an unreachable collector fails every batch). */
function throttled(log: Logger): (msg: string) => void {
  const last = new Map<string, number>();
  return (msg) => {
    const now = Date.now();
    if ((last.get(msg) ?? 0) > now - 60_000) return;
    if (last.size > 100) last.clear();
    last.set(msg, now);
    log.warn({ detail: msg }, 'tracing export problem');
  };
}

export function registerTracing(settings: TracingSettings, log: Logger): TracingHandle {
  const version = packageVersion();
  const resource = defaultResource().merge(
    resourceFromAttributes({
      ...settings.resourceAttributes,
      'service.name': settings.serviceName,
      ...(version ? { 'service.version': version } : {}),
    }),
  );
  const exporter = new OTLPTraceExporter({
    ...(settings.url ? { url: settings.url } : {}),
    ...(Object.keys(settings.headers).length > 0 ? { headers: settings.headers } : {}),
  });
  const provider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(settings.sampleRatio) }),
    spanProcessors: [new BatchSpanProcessor({ exporter })],
  });

  if (!trace.setGlobalTracerProvider(provider)) {
    // An embedding application registered its own provider first: keep it.
    void provider.shutdown();
    log.warn(
      'a global TracerProvider is already registered; Switchyard spans go to it and observability.otel export settings are ignored',
    );
    return { active: false, forceFlush: async () => undefined, shutdown: async () => undefined };
  }
  // Only now take over the process-wide diag logger and error handler: an embedder that brought
  // its own provider keeps its own.
  const warn = throttled(log);
  const fmt = (message: string, args: unknown[]): string =>
    [message, ...args.map((a) => (a instanceof Error ? a.message : String(a)))].join(' ');
  diag.setLogger(
    {
      error: (m, ...a) => warn(fmt(m, a)),
      warn: (m, ...a) => warn(fmt(m, a)),
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  );
  setGlobalErrorHandler((err) =>
    warn(err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)),
  );

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const propagators: TextMapPropagator[] = settings.propagators.map((p) =>
    p === 'baggage' ? new W3CBaggagePropagator() : new W3CTraceContextPropagator(),
  );
  if (propagators.length > 0)
    propagation.setGlobalPropagator(new CompositePropagator({ propagators }));

  log.info(
    {
      service_name: settings.serviceName,
      endpoint: settings.url ?? '(OTEL_EXPORTER_OTLP_* / http://localhost:4318/v1/traces)',
      sample_ratio: settings.sampleRatio,
      propagators: settings.propagators,
    },
    'tracing enabled',
  );

  let stopped = false;
  return {
    active: true,
    forceFlush: () => provider.forceFlush(),
    async shutdown() {
      if (stopped) return;
      stopped = true;
      try {
        await provider.shutdown();
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'tracing shutdown failed');
      }
      trace.disable();
      propagation.disable();
      context.disable();
      diag.disable();
    },
  };
}
