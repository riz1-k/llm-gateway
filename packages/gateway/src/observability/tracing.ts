import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type TextMapGetter,
} from '@opentelemetry/api';
import type { ResolvedConfig } from '../config/resolve.js';
import type { Logger } from './logger.js';
import type * as OtelSdkModule from './otel-sdk.js';

type OtelSdk = typeof OtelSdkModule;

/**
 * OpenTelemetry tracing for the request path (docs/OBSERVABILITY.md § Tracing).
 *
 * The core depends only on `@opentelemetry/api`. Spans go to whatever global TracerProvider is
 * registered: Switchyard's own SDK (`startTracing`, loaded lazily from `otel-sdk.ts` when
 * `observability.otel.enabled`) or one the embedding application registered. With neither, every
 * call below hits the API's no-op implementation and attribute work is skipped (`isRecording()`).
 *
 * Content is never recorded: no prompts, completions, embeddings inputs or tool arguments.
 */

/** Instrumentation scope name of every Switchyard span. */
export const TRACER_NAME = 'switchyard-gateway';

/** Response header carrying the trace id of a recorded request. */
export const TRACE_ID_HEADER = 'x-sy-trace-id';

const headerGetter: TextMapGetter<Headers> = {
  keys: (h) => [...h.keys()],
  get: (h, key) => h.get(key) ?? undefined,
};

const NOOP_SPAN = trace.wrapSpanContext({ traceId: '', spanId: '', traceFlags: 0 });

export const tracer = () => trace.getTracer(TRACER_NAME);

/** Writes the active context (traceparent, tracestate, baggage) into outbound request headers. */
export function injectTraceHeaders(headers: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}

/** Error-message cap for span events: upstream messages are operator data, kept short. */
const MAX_ERROR_MESSAGE = 500;

/** Marks a span failed: status ERROR, `error.type`, and an exception event (name + clipped message). */
export function recordFailure(span: Span, errorType: string, err?: unknown): void {
  if (!span.isRecording()) return;
  span.setAttribute('error.type', errorType);
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
  if (err !== undefined) {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'error');
    span.recordException({
      name: e.name,
      message:
        e.message.length > MAX_ERROR_MESSAGE
          ? `${e.message.slice(0, MAX_ERROR_MESSAGE)}…`
          : e.message,
    });
  }
}

/**
 * Runs `fn` inside a child span of `parent` — only when the parent is recording, so unsampled and
 * untraced requests pay nothing. `fn` receives the span (or a non-recording stand-in).
 */
export async function inChildSpan<T>(
  parent: Context | undefined,
  name: string,
  fn: (span: Span, ctx: Context | undefined) => Promise<T>,
): Promise<T> {
  const parentSpan = parent && trace.getSpan(parent);
  if (!parent || !parentSpan?.isRecording()) return fn(NOOP_SPAN, parent);
  const span = tracer().startSpan(name, { kind: SpanKind.INTERNAL }, parent);
  const ctx = trace.setSpan(parent, span);
  try {
    return await context.with(ctx, () => fn(span, ctx));
  } catch (err) {
    recordFailure(span, errorTypeOf(err), err);
    throw err;
  } finally {
    span.end();
  }
}

/** Low-cardinality error type: the gateway/provider error code, else the exception class. */
export function errorTypeOf(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string')
    return err.code;
  return err instanceof Error ? err.name : 'error';
}

/** Adds an event to the span stored in `ctx`, if it is recording. */
export function addEvent(ctx: Context | undefined, name: string, attributes: Attributes): void {
  const span = ctx && trace.getSpan(ctx);
  if (span?.isRecording()) span.addEvent(name, attributes);
}

// ---------------------------------------------------------------------------------------------
// Server span (one per /v1 request)
// ---------------------------------------------------------------------------------------------

/**
 * The SERVER span of one `/v1/*` request. It ends when the response is complete: for streams, when
 * the body finishes or the client aborts, and never before the pipeline has recorded usage and
 * cost (`hold()`).
 */
export class RequestSpan {
  private holds = 0;
  private endRequested = false;
  private ended = false;

  constructor(
    readonly span: Span,
    /** Context carrying this span (parent of every gateway span of the request). */
    readonly context: Context,
  ) {}

  get recording(): boolean {
    return this.span.isRecording();
  }

  /** Trace/span ids for logs and the response header (recorded requests only). */
  get ids(): { trace_id: string; span_id: string } | undefined {
    if (!this.recording) return undefined;
    const sc = this.span.spanContext();
    return { trace_id: sc.traceId, span_id: sc.spanId };
  }

  setAttributes(attributes: Attributes): void {
    if (this.recording) this.span.setAttributes(attributes);
  }

  /** Delays `end()` until the returned release function runs (idempotent). */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.maybeEnd();
    };
  }

  end(): void {
    this.endRequested = true;
    this.maybeEnd();
  }

  private maybeEnd(): void {
    if (this.ended || !this.endRequested || this.holds > 0) return;
    this.ended = true;
    this.span.end();
  }
}

/**
 * Starts the SERVER span of a request, continuing the caller's trace (W3C `traceparent`,
 * `tracestate` and baggage, through the global propagator). The parent's sampling decision is
 * honoured by the sampler. When the gateway is mounted in an app whose own HTTP instrumentation
 * already started a span (and extracted the headers), that active span is the parent instead.
 */
export function startRequestSpan(req: Request, path: string): RequestSpan {
  const active = context.active();
  const parent = trace.getSpanContext(active)
    ? active
    : propagation.extract(ROOT_CONTEXT, req.headers, headerGetter);
  const span = tracer().startSpan(req.method, { kind: SpanKind.SERVER }, parent);
  if (span.isRecording()) {
    const url = new URL(req.url);
    const attrs: Attributes = {
      'http.request.method': req.method,
      'url.path': path,
      'url.scheme': url.protocol.replace(/:$/, ''),
      'server.address': url.hostname,
    };
    if (url.port) attrs['server.port'] = Number(url.port);
    const ua = req.headers.get('user-agent');
    if (ua) attrs['user_agent.original'] = ua;
    span.setAttributes(attrs);
  }
  return new RequestSpan(span, trace.setSpan(parent, span));
}

/** Routes of the `/v1` API, for the low-cardinality `http.route` attribute and span name. */
export function v1Route(path: string): string | undefined {
  switch (path) {
    case '/v1/chat/completions':
    case '/v1/embeddings':
    case '/v1/rerank':
    case '/v1/models':
      return path;
    default:
      return path.startsWith('/v1/models/') ? '/v1/models/:id' : undefined;
  }
}

/**
 * Records the HTTP response on the server span (HTTP semconv: 5xx is an error, 4xx is not) plus
 * the gateway error code, if any.
 */
export function recordResponse(
  rs: RequestSpan,
  method: string,
  path: string,
  status: number,
  error?: { code: string; err: unknown },
): void {
  if (!rs.recording) return;
  const route = v1Route(path);
  rs.span.updateName(route ? `${method} ${route}` : method);
  if (route) rs.span.setAttribute('http.route', route);
  rs.span.setAttribute('http.response.status_code', status);
  if (error) rs.span.setAttribute('sy.error.code', error.code);
  if (status >= 500) recordFailure(rs.span, String(status), error?.err);
}

// ---------------------------------------------------------------------------------------------
// Upstream attempt spans (one CLIENT span per attempt)
// ---------------------------------------------------------------------------------------------

/** `gen_ai.operation.name` per gateway operation (`rerank` is not a well-known value). */
export const GEN_AI_OPERATION = {
  chat: 'chat',
  embedding: 'embeddings',
  rerank: 'rerank',
} as const;

/**
 * `gen_ai.provider.name`: the well-known value where the provider type identifies the API vendor
 * (`openai`, `anthropic`), otherwise the Switchyard provider type (`openai_compatible`, `opencode`,
 * `mock`, `custom`) — the gateway cannot know what an OpenAI-compatible URL really serves.
 */
export function genAiProviderName(type: string): string {
  return type.replace(/-/g, '_');
}

const endpointCache = new Map<string, { address: string; port: number } | null>();

/** `server.address` / `server.port` of a provider base URL (cached; null when unparseable). */
export function serverEndpoint(
  baseUrl: string | undefined,
): { address: string; port: number } | null {
  if (!baseUrl) return null;
  let hit = endpointCache.get(baseUrl);
  if (hit === undefined) {
    try {
      const u = new URL(baseUrl);
      hit = {
        address: u.hostname,
        port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
      };
    } catch {
      hit = null;
    }
    if (endpointCache.size > 256) endpointCache.clear();
    endpointCache.set(baseUrl, hit);
  }
  return hit;
}

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

/** GenAI usage attributes from an OpenAI-shaped usage object. */
export function usageAttributes(usage: UsageLike | null | undefined): Attributes {
  if (!usage) return {};
  const out: Attributes = {};
  const input = usage.prompt_tokens ?? usage.total_tokens;
  if (typeof input === 'number') out['gen_ai.usage.input_tokens'] = input;
  if (typeof usage.completion_tokens === 'number')
    out['gen_ai.usage.output_tokens'] = usage.completion_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached) out['gen_ai.usage.cache_read.input_tokens'] = cached;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning) out['gen_ai.usage.reasoning.output_tokens'] = reasoning;
  return out;
}

/**
 * Response attributes of a non-streamed upstream result (chat, embedding or rerank body):
 * response id and model, finish reasons, usage, embedding dimensions. Never content.
 */
export function responseAttributes(value: unknown): Attributes {
  if (!value || typeof value !== 'object') return {};
  const v = value as {
    id?: unknown;
    model?: unknown;
    usage?: UsageLike;
    choices?: { finish_reason?: string | null }[];
    data?: { embedding?: unknown }[];
  };
  const out: Attributes = usageAttributes(v.usage);
  if (typeof v.id === 'string' && v.id) out['gen_ai.response.id'] = v.id;
  if (typeof v.model === 'string' && v.model) out['gen_ai.response.model'] = v.model;
  if (Array.isArray(v.choices)) {
    const reasons = v.choices.map((c) => c.finish_reason).filter((r): r is string => !!r);
    if (reasons.length > 0) out['gen_ai.response.finish_reasons'] = reasons;
  }
  const emb = Array.isArray(v.data) ? v.data[0]?.embedding : undefined;
  if (Array.isArray(emb)) out['gen_ai.embeddings.dimension.count'] = emb.length;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Settings: config file + standard OTEL_* environment variables
// ---------------------------------------------------------------------------------------------

/** Effective tracing settings (config first, then `OTEL_*` variables, then defaults). */
export interface TracingSettings {
  enabled: boolean;
  /** Why tracing is off (when `enabled` is false). */
  reason?: string;
  serviceName: string;
  /** Root-span sampling ratio; the parent's decision always wins. */
  sampleRatio: number;
  /** Full OTLP/HTTP traces URL; undefined → the exporter reads `OTEL_EXPORTER_OTLP_*`. */
  url?: string;
  headers: Record<string, string>;
  resourceAttributes: Record<string, string>;
  propagators: ('tracecontext' | 'baggage')[];
}

type Env = Record<string, string | undefined>;

const ratioFromEnv = (env: Env): number | undefined => {
  const sampler = env.OTEL_TRACES_SAMPLER?.trim().toLowerCase();
  if (!sampler) return undefined;
  if (sampler === 'always_on' || sampler === 'parentbased_always_on') return 1;
  if (sampler === 'always_off' || sampler === 'parentbased_always_off') return 0;
  if (sampler === 'traceidratio' || sampler === 'parentbased_traceidratio') {
    const arg = Number(env.OTEL_TRACES_SAMPLER_ARG ?? '1');
    return Number.isFinite(arg) ? Math.min(1, Math.max(0, arg)) : 1;
  }
  return undefined;
};

/** Parses `OTEL_RESOURCE_ATTRIBUTES` (`k=v,k2=v2`, values percent-encoded). */
export function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    let value = pair.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value
    }
    if (key) out[key] = value;
  }
  return out;
}

/** OTLP/HTTP traces URL from a configured endpoint (`/v1/traces` appended unless present). */
export function tracesUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

/**
 * Resolves the effective settings. Precedence: values in the config file win; standard `OTEL_*`
 * variables fill in what the file leaves unset; then defaults. `OTEL_SDK_DISABLED=true` turns
 * tracing off whatever the file says.
 */
export function resolveTracingSettings(
  config: ResolvedConfig,
  env: Env = process.env,
): TracingSettings {
  const otel = config.raw.observability.otel;
  const propagators = (env.OTEL_PROPAGATORS ?? 'tracecontext,baggage')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is 'tracecontext' | 'baggage' => p === 'tracecontext' || p === 'baggage');
  const base = {
    serviceName: otel.service_name ?? env.OTEL_SERVICE_NAME?.trim() ?? 'switchyard',
    sampleRatio: otel.sample_ratio ?? ratioFromEnv(env) ?? 1,
    headers: otel.headers ?? {},
    resourceAttributes: {
      ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
      ...otel.resource_attributes,
    },
    propagators,
    ...(otel.endpoint ? { url: tracesUrl(otel.endpoint) } : {}),
  };
  if (!base.serviceName) base.serviceName = 'switchyard';
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true')
    return { ...base, enabled: false, reason: 'OTEL_SDK_DISABLED=true' };
  if (!otel.enabled)
    return { ...base, enabled: false, reason: 'observability.otel.enabled is false' };
  return { ...base, enabled: true };
}

// ---------------------------------------------------------------------------------------------
// SDK lifecycle
// ---------------------------------------------------------------------------------------------

/** Handle of the tracing SDK started by `startTracing`. */
export interface TracingHandle {
  /** True when Switchyard registered its own TracerProvider. */
  readonly active: boolean;
  /** Exports buffered spans now. */
  forceFlush(): Promise<void>;
  /** Flushes and stops the SDK (call once, at shutdown). */
  shutdown(): Promise<void>;
}

const inactive: TracingHandle = {
  active: false,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

/** Options for `startTracing`. */
export interface StartTracingOptions {
  logger: Logger;
  /** Environment used for `OTEL_*` variables (default `process.env`). */
  env?: Record<string, string | undefined>;
}

/**
 * Starts OpenTelemetry tracing from `observability.otel` and the standard `OTEL_*` variables:
 * registers a global TracerProvider (parent-based ratio sampler, batched OTLP/HTTP export), the
 * W3C propagators and an AsyncLocalStorage context manager. `startServer` (`switchyard serve`)
 * calls it; embedders call it themselves if they want Switchyard's SDK.
 *
 * Does nothing — and loads no SDK code — when tracing is disabled. When another TracerProvider is
 * already registered (an embedding application's), that one is kept and Switchyard's spans go to
 * it. If the optional `@opentelemetry/*` SDK packages are not installed, logs an error and
 * continues without tracing.
 *
 * @returns a handle whose `shutdown()` flushes pending spans; call it on exit.
 */
export async function startTracing(
  config: ResolvedConfig,
  opts: StartTracingOptions,
): Promise<TracingHandle> {
  const settings = resolveTracingSettings(config, opts.env ?? process.env);
  const log = opts.logger.child({ component: 'tracing' });
  if (!settings.enabled) {
    log.debug({ reason: settings.reason }, 'tracing disabled');
    return inactive;
  }
  let sdk: OtelSdk;
  try {
    sdk = await import('./otel-sdk.js');
  } catch (err) {
    log.error(
      {
        err: (err as Error).message,
        hint: 'install the optional dependencies @opentelemetry/sdk-trace, @opentelemetry/resources, @opentelemetry/core, @opentelemetry/context-async-hooks and @opentelemetry/exporter-trace-otlp-http (Node >= 22.15)',
      },
      'tracing enabled but the OpenTelemetry SDK could not be loaded; continuing without tracing',
    );
    return inactive;
  }
  return sdk.registerTracing(settings, log);
}
