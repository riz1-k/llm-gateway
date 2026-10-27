import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { UsageEvent } from '../core/services.js';

/**
 * Prometheus metrics (SPEC §13). Every metric is documented in docs/METRICS.md — keep both in
 * sync; Grafana dashboards are built from these names.
 *
 * Cardinality: label values come only from config (route, provider, model, target), DB teams
 * (team slug), HTTP status codes and fixed enums (cache result, token type, error codes). Never
 * label with keys, users, request ids or free text.
 */

export type CacheLayer = 'exact' | 'semantic';
export type CacheResult = 'hit' | 'miss' | 'bypass';
export type CircuitStateValue = 0 | 1 | 2;

/** Instrumentation hooks used by the pipeline, router and platform services. */
export interface GatewayMetrics {
  /** Called once per routed request (from the usage event). */
  request(event: UsageEvent): void;
  cacheLookup(route: string, layer: CacheLayer, result: CacheResult): void;
  rateLimited(scope: string, limit: string): void;
  budgetRejected(team: string): void;
  budgetUtilization(team: string, period: string, ratio: number): void;
  budgetAlert(team: string, period: string, level: 'soft' | 'exceeded'): void;
  upstreamAttempt(provider: string, model: string, seconds: number, ok: boolean): void;
  queueWait(provider: string, seconds: number): void;
  fallback(route: string, from: string, to: string, reason: string): void;
  retry(target: string, reason: string): void;
  usageDropped(count: number): void;
  usageBuffered(count: number): void;
  platformError(component: string): void;
}

export const noopMetrics: GatewayMetrics = {
  request: () => undefined,
  cacheLookup: () => undefined,
  rateLimited: () => undefined,
  budgetRejected: () => undefined,
  budgetUtilization: () => undefined,
  budgetAlert: () => undefined,
  upstreamAttempt: () => undefined,
  queueWait: () => undefined,
  fallback: () => undefined,
  retry: () => undefined,
  usageDropped: () => undefined,
  usageBuffered: () => undefined,
  platformError: () => undefined,
};

/** Values read at scrape time (breakers, semaphores, stream lag). */
export interface ScrapeSources {
  circuitStates?: () => Promise<{ target: string; state: CircuitStateValue }[]>;
  inflight?: () => Record<string, number>;
  streamLag?: () => Promise<{ lag: number; pending: number } | null>;
}

const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300,
];
const TTFT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 20, 30];
const QUEUE_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export interface PromMetricsOptions {
  defaultMetrics?: boolean;
  prefix?: string;
}

export class PromMetrics implements GatewayMetrics {
  readonly registry = new Registry();
  private sources: ScrapeSources = {};

  readonly requests: Counter<'route' | 'provider' | 'model' | 'status' | 'cache'>;
  readonly requestDuration: Histogram<'route' | 'status'>;
  readonly upstreamDuration: Histogram<'provider' | 'model' | 'outcome'>;
  readonly ttft: Histogram<'route'>;
  readonly tokens: Counter<'team' | 'route' | 'model' | 'type'>;
  readonly cost: Counter<'team' | 'route' | 'provider' | 'model'>;
  readonly cacheSaved: Counter<'team' | 'route'>;
  readonly cacheRequests: Counter<'route' | 'kind' | 'result'>;
  readonly rateLimitRejections: Counter<'scope' | 'limit'>;
  readonly budgetRejections: Counter<'team'>;
  readonly budgetUtilizationGauge: Gauge<'team' | 'period'>;
  readonly budgetAlerts: Counter<'team' | 'period' | 'level'>;
  readonly fallbacks: Counter<'route' | 'from' | 'to' | 'reason'>;
  readonly retries: Counter<'target' | 'reason'>;
  readonly circuitState: Gauge<'target'>;
  readonly inflightRequests: Gauge<'provider'>;
  readonly queueWaitHist: Histogram<'provider'>;
  readonly usageStreamLag: Gauge;
  readonly usageStreamPending: Gauge;
  readonly usageDroppedCounter: Counter;
  readonly usageBufferedGauge: Gauge;
  readonly platformErrors: Counter<'component'>;

  constructor(opts: PromMetricsOptions = {}) {
    const p = opts.prefix ?? 'sy_';
    const r = [this.registry];
    if (opts.defaultMetrics !== false) collectDefaultMetrics({ register: this.registry });
    // Scrape-time callbacks run with `this` bound to the metric, so capture via arrows.
    const sources = (): ScrapeSources => this.sources;
    const setPending = (n: number): void => this.usageStreamPending.set(n);

    this.requests = new Counter({
      name: `${p}requests_total`,
      help: 'Routed API requests by route, serving provider/model, HTTP status and cache result.',
      labelNames: ['route', 'provider', 'model', 'status', 'cache'],
      registers: r,
    });
    this.requestDuration = new Histogram({
      name: `${p}request_duration_seconds`,
      help: 'End-to-end request latency as seen by the gateway (for streams: until the last chunk).',
      labelNames: ['route', 'status'],
      buckets: DURATION_BUCKETS,
      registers: r,
    });
    this.upstreamDuration = new Histogram({
      name: `${p}upstream_duration_seconds`,
      help: 'Latency of individual upstream attempts (time to response, or to first chunk for streams).',
      labelNames: ['provider', 'model', 'outcome'],
      buckets: DURATION_BUCKETS,
      registers: r,
    });
    this.ttft = new Histogram({
      name: `${p}ttft_seconds`,
      help: 'Time to first meaningful token of streaming chat responses.',
      labelNames: ['route'],
      buckets: TTFT_BUCKETS,
      registers: r,
    });
    this.tokens = new Counter({
      name: `${p}tokens_total`,
      help: 'Upstream tokens consumed (type: prompt|completion|cached|reasoning). Cache hits consume none.',
      labelNames: ['team', 'route', 'model', 'type'],
      registers: r,
    });
    this.cost = new Counter({
      name: `${p}cost_usd_total`,
      help: 'Cost in USD from the pricing table (shadow price for subscription providers).',
      labelNames: ['team', 'route', 'provider', 'model'],
      registers: r,
    });
    this.cacheSaved = new Counter({
      name: `${p}cache_saved_usd_total`,
      help: 'USD saved by cache hits (original cost of the cached response).',
      labelNames: ['team', 'route'],
      registers: r,
    });
    this.cacheRequests = new Counter({
      name: `${p}cache_requests_total`,
      help: 'Cache lookups by layer (kind: exact|semantic) and result (hit|miss|bypass).',
      labelNames: ['route', 'kind', 'result'],
      registers: r,
    });
    this.rateLimitRejections = new Counter({
      name: `${p}ratelimit_rejections_total`,
      help: 'Requests rejected with 429 by the gateway rate limiter (scope: key|team, limit: rpm|tpm).',
      labelNames: ['scope', 'limit'],
      registers: r,
    });
    this.budgetRejections = new Counter({
      name: `${p}budget_rejections_total`,
      help: 'Requests rejected with 402 budget_exceeded.',
      labelNames: ['team'],
      registers: r,
    });
    this.budgetUtilizationGauge = new Gauge({
      name: `${p}budget_utilization_ratio`,
      help: 'Spend / limit for the current budget period (UTC day or month), updated on each request.',
      labelNames: ['team', 'period'],
      registers: r,
    });
    this.budgetAlerts = new Counter({
      name: `${p}budget_alerts_total`,
      help: 'Budget alerts fired (once per team/period; level: soft|exceeded).',
      labelNames: ['team', 'period', 'level'],
      registers: r,
    });
    this.fallbacks = new Counter({
      name: `${p}fallbacks_total`,
      help: 'Fallbacks from one target to the next within a request, with the error code that caused it.',
      labelNames: ['route', 'from', 'to', 'reason'],
      registers: r,
    });
    this.retries = new Counter({
      name: `${p}retries_total`,
      help: 'Retries of the same target, with the error code of the failed attempt.',
      labelNames: ['target', 'reason'],
      registers: r,
    });
    this.circuitState = new Gauge({
      name: `${p}circuit_state`,
      help: 'Circuit breaker state per target: 0 closed, 1 half-open, 2 open.',
      labelNames: ['target'],
      registers: r,
      async collect() {
        const states = await sources()
          .circuitStates?.()
          .catch(() => undefined);
        if (!states) return;
        this.reset();
        for (const s of states) this.set({ target: s.target }, s.state);
      },
    });
    this.inflightRequests = new Gauge({
      name: `${p}inflight_requests`,
      help: 'Upstream requests currently holding a provider concurrency slot.',
      labelNames: ['provider'],
      registers: r,
      collect() {
        const map = sources().inflight?.();
        if (!map) return;
        this.reset();
        for (const [provider, n] of Object.entries(map)) this.set({ provider }, n);
      },
    });
    this.queueWaitHist = new Histogram({
      name: `${p}provider_queue_wait_seconds`,
      help: 'Time spent waiting for a provider concurrency slot (max_concurrency).',
      labelNames: ['provider'],
      buckets: QUEUE_BUCKETS,
      registers: r,
    });
    this.usageStreamLag = new Gauge({
      name: `${p}usage_stream_lag`,
      help: 'Usage events in the Redis stream not yet delivered to the writer consumer group.',
      registers: r,
      async collect() {
        const lag = await sources()
          .streamLag?.()
          .catch(() => null);
        if (lag) {
          this.set(lag.lag);
          setPending(lag.pending);
        }
      },
    });
    this.usageStreamPending = new Gauge({
      name: `${p}usage_stream_pending`,
      help: 'Usage events delivered to a writer but not yet acknowledged (in-flight or from crashed consumers).',
      registers: r,
    });
    this.usageDroppedCounter = new Counter({
      name: `${p}usage_events_dropped_total`,
      help: 'Usage events dropped because Redis was unavailable and the in-memory buffer was full.',
      registers: r,
    });
    this.usageBufferedGauge = new Gauge({
      name: `${p}usage_events_buffered`,
      help: 'Usage events held in memory waiting for Redis.',
      registers: r,
    });
    this.platformErrors = new Counter({
      name: `${p}platform_errors_total`,
      help: 'Errors in platform components handled fail-open (component: ratelimit|budget|cache|keys|usage|breaker).',
      labelNames: ['component'],
      registers: r,
    });
  }

  setSources(sources: ScrapeSources): void {
    this.sources = { ...this.sources, ...sources };
  }

  request(e: UsageEvent): void {
    const provider = e.provider ?? 'none';
    const model = e.model ?? 'none';
    const status = String(e.status);
    this.requests.inc({ route: e.route, provider, model, status, cache: e.cache });
    this.requestDuration.observe({ route: e.route, status }, e.latency_ms / 1000);
    if (e.stream && e.ttft_ms !== null && e.status < 400)
      this.ttft.observe({ route: e.route }, e.ttft_ms / 1000);
    const t = { team: e.team, route: e.route, model };
    if (e.prompt_tokens) this.tokens.inc({ ...t, type: 'prompt' }, e.prompt_tokens);
    if (e.completion_tokens) this.tokens.inc({ ...t, type: 'completion' }, e.completion_tokens);
    if (e.cached_tokens) this.tokens.inc({ ...t, type: 'cached' }, e.cached_tokens);
    if (e.reasoning_tokens) this.tokens.inc({ ...t, type: 'reasoning' }, e.reasoning_tokens);
    if (e.cost_usd > 0)
      this.cost.inc({ team: e.team, route: e.route, provider, model }, e.cost_usd);
    if (e.saved_usd > 0) this.cacheSaved.inc({ team: e.team, route: e.route }, e.saved_usd);
  }

  cacheLookup(route: string, layer: CacheLayer, result: CacheResult): void {
    this.cacheRequests.inc({ route, kind: layer, result });
  }
  rateLimited(scope: string, limit: string): void {
    this.rateLimitRejections.inc({ scope, limit });
  }
  budgetRejected(team: string): void {
    this.budgetRejections.inc({ team });
  }
  budgetUtilization(team: string, period: string, ratio: number): void {
    this.budgetUtilizationGauge.set({ team, period }, Number.isFinite(ratio) ? ratio : 0);
  }
  budgetAlert(team: string, period: string, level: 'soft' | 'exceeded'): void {
    this.budgetAlerts.inc({ team, period, level });
  }
  upstreamAttempt(provider: string, model: string, seconds: number, ok: boolean): void {
    this.upstreamDuration.observe({ provider, model, outcome: ok ? 'ok' : 'error' }, seconds);
  }
  queueWait(provider: string, seconds: number): void {
    this.queueWaitHist.observe({ provider }, seconds);
  }
  fallback(route: string, from: string, to: string, reason: string): void {
    this.fallbacks.inc({ route, from, to, reason });
  }
  retry(target: string, reason: string): void {
    this.retries.inc({ target, reason });
  }
  usageDropped(count: number): void {
    this.usageDroppedCounter.inc(count);
  }
  usageBuffered(count: number): void {
    this.usageBufferedGauge.set(count);
  }
  platformError(component: string): void {
    this.platformErrors.inc({ component });
  }

  async expose(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
