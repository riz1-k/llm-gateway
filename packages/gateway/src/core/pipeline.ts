import type { ResolvedConfig, ResolvedModel, ResolvedRoute } from '../config/resolve.js';
import { directRoute } from '../config/resolve.js';
import type { Logger } from '../observability/logger.js';
import type { CacheMode } from '../cache/keys.js';
import {
  cacheScope,
  chatCacheKey,
  embeddingCacheKey,
  embeddingItemCacheKey,
  isChatCacheable,
  isRouteCacheable,
  rerankCacheKey,
} from '../cache/keys.js';
import { semanticQuery } from '../cache/semantic.js';
import {
  countTokens,
  estimatePromptTokens,
  estimateTextTokens,
  newTokenBudget,
} from '../limits/estimate.js';
import type { Attributes, Context } from '@opentelemetry/api';
import { NoopBudgetGuard } from '../limits/budgets.js';
import { NoopRateLimiter } from '../limits/ratelimit.js';
import { noopMetrics, type GatewayMetrics } from '../observability/metrics.js';
import {
  addEvent,
  inChildSpan,
  recordFailure,
  type RequestSpan,
} from '../observability/tracing.js';
import { computeCost, estimateCost, formatUsd } from '../usage/pricing.js';
import { encodeSSE, SSE_DONE } from '../util/sse.js';
import { ChunkAccumulator, isMeaningfulChunk, responseToChunks } from './chunks.js';
import { GatewayError, toGatewayError } from './errors.js';
import { newRerankId } from './ids.js';
import { countFallbacks, type AttemptRecord, type DispatchContext, type Router } from './router.js';
import type {
  ApiKeyRecord,
  CachedPayload,
  CacheEntry,
  GatewayServices,
  RateLimitDecision,
  UsageEvent,
} from './services.js';
import { applyInputTemplates, embeddingInputs } from './templates.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  EmbeddingData,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelCard,
  OperationKind,
  RerankRequest,
  RerankResponse,
  Usage,
} from './types.js';

/**
 * The request pipeline (SPEC §5). Each step is a small method; the order is fixed here so the
 * wave-H subsystems (rate limits, budgets, caches, usage pipeline) only plug implementations into
 * `GatewayServices`:
 *
 *   resolve route → defaults → estimate → rate limit → budget → cache lookup → dispatch
 *   → account (cost, reconcile, budget record, cache write, usage event) → headers
 *
 * Authentication and body validation happen in the HTTP layer before the pipeline runs.
 */

export interface RequestContext {
  requestId: string;
  /** Unique id of the usage event (defaults to `requestId`; differs when the client chose it). */
  usageId?: string;
  startedAt: number;
  logger: Logger;
  headers: Headers;
  /** Aborts when the client disconnects. */
  signal: AbortSignal;
  key: ApiKeyRecord;
  endUser: string | undefined;
  tags: string[];
  cacheMode: CacheMode;
  /** Server span of the request (tracing); stage and attempt spans become its children. */
  trace?: RequestSpan | undefined;
}

export type PipelineResult =
  | { kind: 'json'; status: number; headers: Record<string, string>; body: unknown }
  | {
      kind: 'stream';
      status: number;
      headers: Record<string, string>;
      stream: ReadableStream<Uint8Array>;
    };

export interface PipelineDeps {
  config: ResolvedConfig;
  router: Router;
  services: GatewayServices;
  metrics?: GatewayMetrics;
  clock?: () => number;
}

interface Admission {
  route: ResolvedRoute;
  rate: RateLimitDecision;
  estimatedPromptTokens: number;
}

interface Outcome {
  status: number;
  errorCode: string | null;
  model: ResolvedModel | undefined;
  usage: Usage | undefined;
  costUsd: number;
  savedUsd: number;
  cache: UsageEvent['cache'];
  stream: boolean;
  ttftMs: number | null;
  attempts: AttemptRecord[];
  /** Provider/model that produced a cached response (cache hits). */
  cachedFrom?: { provider: string; model: string };
  /** Extra response headers (e.g. per-item cache stats). */
  extraHeaders?: Record<string, string>;
}

/** State of a semantic-cache lookup that missed, used to index the response afterwards. */
interface SemanticPending {
  index: string;
  vector: number[];
  ttl: number;
}

const DEFAULT_COMPLETION_ESTIMATE = 1024;

/** `gen_ai.request.*` attributes of a chat request (sampling parameters only, never content). */
function chatRequestAttributes(req: ChatRequest): Attributes {
  const a: Attributes = {};
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  if (maxTokens != null) a['gen_ai.request.max_tokens'] = maxTokens;
  if (req.temperature != null) a['gen_ai.request.temperature'] = req.temperature;
  if (req.top_p != null) a['gen_ai.request.top_p'] = req.top_p;
  if (req.frequency_penalty != null) a['gen_ai.request.frequency_penalty'] = req.frequency_penalty;
  if (req.presence_penalty != null) a['gen_ai.request.presence_penalty'] = req.presence_penalty;
  if (req.seed != null) a['gen_ai.request.seed'] = req.seed;
  if (req.n != null && req.n !== 1) a['gen_ai.request.choice.count'] = req.n;
  if (req.reasoning_effort != null) a['gen_ai.request.reasoning.level'] = req.reasoning_effort;
  if (req.stream === true) a['gen_ai.request.stream'] = true;
  const format = req.response_format?.type;
  if (format) a['gen_ai.output.type'] = format === 'text' ? 'text' : 'json';
  return a;
}

/** Adds the Switchyard cost extension fields to a usage object (never mutates the input). */
function usageWithCost(usage: Usage, costUsd: number, o: Outcome): Usage {
  const out: Usage = { ...usage, cost: costUsd, sy_cache: o.cache };
  if (o.savedUsd > 0) out.sy_saved_cost = o.savedUsd;
  else delete out.sy_saved_cost;
  return out;
}

/** Non-streamed chat bodies carry the same `usage.cost` as the final streamed chunk. */
function withCost(response: ChatResponse, o: Outcome): ChatResponse {
  if (!response.usage) return response;
  const isHit = o.cache === 'hit' || o.cache === 'semantic-hit';
  return { ...response, usage: usageWithCost(response.usage, isHit ? 0 : o.costUsd, o) };
}

async function* toAsync<T>(it: Iterable<T>): AsyncGenerator<T> {
  yield* it;
}

export class Pipeline {
  private readonly clock: () => number;
  private readonly metrics: GatewayMetrics;

  constructor(private readonly deps: PipelineDeps) {
    this.clock = deps.clock ?? Date.now;
    this.metrics = deps.metrics ?? noopMetrics;
  }

  private get config(): ResolvedConfig {
    return this.deps.config;
  }

  private get services(): GatewayServices {
    return this.deps.services;
  }

  // -------------------------------------------------------------------------------------------
  // Shared steps
  // -------------------------------------------------------------------------------------------

  /** Step: resolve the virtual model (route) and enforce key scope + endpoint kind. */
  resolveRoute(name: string, key: ApiKeyRecord, kind: OperationKind): ResolvedRoute {
    let route = this.config.routes[name];
    if (!route && key.allowDirectModels && this.config.models[name]) {
      route = directRoute(this.config.models[name], this.config);
    }
    if (!route) {
      throw new GatewayError(
        404,
        'model_not_found',
        `The model \`${name}\` does not exist or you do not have access to it.`,
        { param: 'model' },
      );
    }
    if (key.allowedRoutes && !key.allowedRoutes.includes(name)) {
      throw new GatewayError(
        403,
        'model_not_allowed',
        `This API key is not allowed to use the model \`${name}\`.`,
        { param: 'model' },
      );
    }
    if (route.kind !== kind) {
      const endpoint =
        route.kind === 'chat'
          ? '/v1/chat/completions'
          : route.kind === 'embedding'
            ? '/v1/embeddings'
            : '/v1/rerank';
      throw new GatewayError(
        400,
        'invalid_request',
        `The model \`${name}\` is a ${route.kind} model; use ${endpoint}.`,
        { param: 'model' },
      );
    }
    return route;
  }

  /** Highest price among a route's enabled targets (pre-flight upper bound). */
  private maxPricing(route: ResolvedRoute) {
    let best: ResolvedModel['pricing'];
    let bestScore = -1;
    for (const t of route.targets) {
      const p = this.config.models[t.model]?.pricing;
      if (!p) continue;
      const score = p.input + p.output;
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
    return best;
  }

  /** Steps: estimate → rate limit → budget. */
  private async admit(
    rctx: RequestContext,
    route: ResolvedRoute,
    promptTokens: number,
    maxCompletion: number,
  ): Promise<Admission> {
    // The budget check only reads, so it runs concurrently with the rate-limit check (one Redis
    // round-trip on the request path instead of two). Its result is used only when the rate
    // limiter admits the request; a rate-limit rejection still wins.
    const { rateLimiter, budgets } = this.services;
    if (rateLimiter instanceof NoopRateLimiter && budgets instanceof NoopBudgetGuard)
      return this.admitInner(rctx, route, promptTokens, maxCompletion);
    return inChildSpan(rctx.trace?.context, 'sy.limits', async (span) => {
      try {
        const admission = await this.admitInner(rctx, route, promptTokens, maxCompletion);
        if (span.isRecording())
          span.setAttributes({ 'sy.ratelimit.result': 'allowed', 'sy.budget.result': 'allowed' });
        return admission;
      } catch (err) {
        if (span.isRecording() && err instanceof GatewayError) {
          span.setAttributes(
            err.status === 429
              ? { 'sy.ratelimit.result': 'rejected' }
              : { 'sy.ratelimit.result': 'allowed', 'sy.budget.result': 'rejected' },
          );
        }
        throw err;
      }
    });
  }

  private async admitInner(
    rctx: RequestContext,
    route: ResolvedRoute,
    promptTokens: number,
    maxCompletion: number,
  ): Promise<Admission> {
    const preflightCostUsd = estimateCost(promptTokens, maxCompletion, this.maxPricing(route));
    const budgetCheck = this.services.budgets.check({
      team: rctx.key.team,
      route: route.name,
      preflightCostUsd,
    });
    budgetCheck.catch(() => undefined); // observed below; never an unhandled rejection
    const rate = await this.services.rateLimiter.check({
      key: rctx.key,
      route: route.name,
      estimatedTokens: promptTokens + maxCompletion,
    });
    if (!rate.allowed) {
      const headers = { ...rate.headers };
      if (rate.retryAfterMs !== undefined) {
        headers['retry-after'] = String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000)));
        headers['retry-after-ms'] = String(Math.max(1, Math.ceil(rate.retryAfterMs)));
      }
      const [scope = 'unknown', limit = 'unknown'] = (rate.rejectedBy ?? '').split(':');
      this.metrics.rateLimited(scope, limit);
      throw new GatewayError(
        429,
        'rate_limit_exceeded',
        `Rate limit exceeded (${rate.rejectedBy ?? 'limit'}).`,
        { headers },
      );
    }
    const budget = await budgetCheck;
    if (!budget.allowed) {
      // Release the TPM reservation: the request never reaches a provider.
      await this.services.rateLimiter.reconcile(rate, 0).catch(() => undefined);
      this.metrics.budgetRejected(rctx.key.team.slug);
      throw new GatewayError(
        402,
        'budget_exceeded',
        `Budget exceeded for team ${rctx.key.team.slug}${budget.period ? ` (${budget.period})` : ''}.`,
        {
          headers: rate.headers,
        },
      );
    }
    return { route, rate, estimatedPromptTokens: promptTokens };
  }

  private dispatchContext(
    rctx: RequestContext,
    route: ResolvedRoute,
    attempts: AttemptRecord[],
    trace?: { context?: Context | undefined; request?: Attributes },
  ): DispatchContext {
    return {
      requestId: rctx.requestId,
      route,
      logger: rctx.logger,
      signal: rctx.signal,
      requestHeaders: rctx.headers,
      deadline: rctx.startedAt + route.timeoutMs,
      attempts,
      traceContext: trace?.context ?? rctx.trace?.context,
      ...(trace?.request ? { genAiRequest: trace.request } : {}),
    };
  }

  private headers(
    route: ResolvedRoute,
    o: Outcome,
    rate: RateLimitDecision | undefined,
    includeCost: boolean,
  ): Record<string, string> {
    const h: Record<string, string> = {
      'x-sy-route': route.name,
      'x-sy-cache': o.cache,
      'x-sy-fallbacks': String(countFallbacks(o.attempts, o.model?.name)),
      'x-sy-latency-ms': String(this.clock() - this.startedAtOf(o)),
      ...(rate?.headers ?? {}),
    };
    if (o.model) {
      h['x-sy-provider'] = o.model.providerName;
      h['x-sy-model'] = o.model.upstreamModel;
    } else if (o.cachedFrom) {
      h['x-sy-provider'] = o.cachedFrom.provider;
      h['x-sy-model'] = o.cachedFrom.model;
    }
    if (includeCost) h['x-sy-cost-usd'] = formatUsd(o.costUsd);
    if (o.savedUsd > 0) h['x-sy-saved-usd'] = formatUsd(o.savedUsd);
    if (o.extraHeaders) Object.assign(h, o.extraHeaders);
    return h;
  }

  private startedAt = new WeakMap<Outcome, number>();
  private startedAtOf(o: Outcome): number {
    return this.startedAt.get(o) ?? this.clock();
  }

  private newOutcome(rctx: RequestContext, stream: boolean, cache: UsageEvent['cache']): Outcome {
    const o: Outcome = {
      status: 200,
      errorCode: null,
      model: undefined,
      usage: undefined,
      costUsd: 0,
      savedUsd: 0,
      cache,
      stream,
      ttftMs: null,
      attempts: [],
    };
    this.startedAt.set(o, rctx.startedAt);
    return o;
  }

  /** Step: account — reconcile limits, record budget, emit the usage event, log. */
  private async account(
    rctx: RequestContext,
    route: ResolvedRoute,
    kind: OperationKind,
    o: Outcome,
    admission: Admission | undefined,
  ): Promise<void> {
    const usage = o.usage;
    const totalTokens = usage ? usage.prompt_tokens + usage.completion_tokens : 0;
    try {
      // Independent writes: TPM reconciliation and budget spend in parallel (one round-trip).
      await Promise.all([
        admission ? this.services.rateLimiter.reconcile(admission.rate, totalTokens) : undefined,
        o.costUsd > 0
          ? this.services.budgets.record({
              team: rctx.key.team,
              route: route.name,
              costUsd: o.costUsd,
            })
          : undefined,
      ]);
    } catch (err) {
      rctx.logger.error({ err }, 'accounting failed');
    }
    const latency = this.clock() - rctx.startedAt;
    const event: UsageEvent = {
      ts: new Date(rctx.startedAt).toISOString(),
      request_id: rctx.usageId ?? rctx.requestId,
      team_id: rctx.key.team.id,
      team: rctx.key.team.slug,
      key_id: rctx.key.id,
      route: route.name,
      kind,
      provider: o.model?.providerName ?? o.cachedFrom?.provider ?? null,
      model: o.model?.upstreamModel ?? o.cachedFrom?.model ?? null,
      status: o.status,
      error_code: o.errorCode,
      cache: o.cache,
      stream: o.stream,
      prompt_tokens: usage?.prompt_tokens ?? 0,
      cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      cost_usd: o.costUsd,
      saved_usd: o.savedUsd,
      latency_ms: latency,
      ttft_ms: o.ttftMs,
      attempts: o.attempts.filter((a) => a.outcome !== 'skipped').length,
      fallbacks: countFallbacks(o.attempts, o.model?.name),
      end_user: rctx.endUser ?? null,
      tags: rctx.tags,
    };
    try {
      this.services.usage.emit(event);
    } catch (err) {
      rctx.logger.error({ err }, 'usage emission failed');
    }
    this.traceOutcome(rctx, event, o);
    try {
      this.metrics.request(event);
      this.observeAttempts(route, o.attempts);
    } catch (err) {
      rctx.logger.warn({ err }, 'metrics update failed');
    }
    rctx.logger.info(
      {
        team: event.team,
        key: rctx.key.prefix,
        route: route.name,
        provider: event.provider,
        model: event.model,
        status: o.status,
        error_code: o.errorCode,
        latency_ms: latency,
        ttft_ms: o.ttftMs,
        cost_usd: o.costUsd,
        cache: o.cache,
        stream: o.stream,
        prompt_tokens: event.prompt_tokens,
        completion_tokens: event.completion_tokens,
        attempts: o.attempts.map(
          (a) => `${a.target}#${a.attempt}:${a.outcome}${a.code ? `(${a.code})` : ''}`,
        ),
      },
      'request completed',
    );
  }

  /** Summary of the request on its server span: route, cache, served target, usage, cost. */
  private traceOutcome(rctx: RequestContext, event: UsageEvent, o: Outcome): void {
    const rs = rctx.trace;
    if (!rs?.recording) return;
    const a: Attributes = {
      'sy.route': event.route,
      'sy.cache': event.cache,
      'sy.stream': event.stream,
      'sy.cost_usd': event.cost_usd,
      'sy.usage.input_tokens': event.prompt_tokens,
      'sy.usage.output_tokens': event.completion_tokens,
      'sy.attempts': event.attempts,
      'sy.fallbacks': event.fallbacks,
    };
    if (event.provider) a['sy.provider'] = event.provider;
    if (event.model) a['sy.model'] = event.model;
    if (o.model) a['sy.target'] = o.model.name;
    if (event.saved_usd > 0) a['sy.saved_usd'] = event.saved_usd;
    if (event.ttft_ms !== null) a['sy.ttft_ms'] = event.ttft_ms;
    if (event.error_code) a['sy.error.code'] = event.error_code;
    rs.setAttributes(a);
    // A stream fails after its 200 went out: the HTTP status cannot say so, the span must.
    if (o.stream && event.status >= 500) recordFailure(rs.span, event.error_code ?? 'error');
  }

  /** Derives retry/fallback counters from the attempt log (bounded labels: targets, codes). */
  private observeAttempts(route: ResolvedRoute, attempts: AttemptRecord[]): void {
    const relevant = attempts.filter((a) => a.outcome !== 'skipped' || a.code === 'circuit_open');
    for (let i = 0; i + 1 < relevant.length; i++) {
      const a = relevant[i]!;
      const b = relevant[i + 1]!;
      const reason = a.code ?? 'error';
      if (a.target === b.target) this.metrics.retry(a.target, reason);
      else this.metrics.fallback(route.name, a.target, b.target, reason);
    }
  }

  /** Converts a failure into a client error carrying the routing headers, after accounting. */
  private async fail(
    rctx: RequestContext,
    route: ResolvedRoute | undefined,
    kind: OperationKind,
    o: Outcome,
    admission: Admission | undefined,
    err: unknown,
  ): Promise<never> {
    const gerr = toGatewayError(err);
    o.status = gerr.status;
    o.errorCode = gerr.code;
    if (gerr.status >= 500 && gerr !== err) {
      // The client-facing message may be generic; keep the original for operators.
      rctx.logger.warn(
        { code: gerr.code, err: err instanceof Error ? err.message : String(err) },
        'request failed',
      );
    }
    if (route) {
      await this.account(rctx, route, kind, o, admission);
      Object.assign(gerr.headers, {
        ...this.headers(route, o, admission?.rate, false),
        ...gerr.headers,
      });
    }
    throw gerr;
  }

  private async cacheGet(
    key: string | undefined,
    rctx: RequestContext,
    route: ResolvedRoute,
  ): Promise<CacheEntry | null> {
    if (!key) {
      // Only routes with an exact cache report lookups; uncached routes stay out of hit ratios.
      if (route.cache?.exact) this.metrics.cacheLookup(route.name, 'exact', 'bypass');
      return null;
    }
    if (rctx.cacheMode === 'refresh') {
      this.metrics.cacheLookup(route.name, 'exact', 'bypass');
      return null;
    }
    try {
      const hit = await inChildSpan(rctx.trace?.context, 'sy.cache.exact', async (span) => {
        const entry = await this.services.cache.get(key);
        if (span.isRecording()) span.setAttribute('sy.cache.result', entry ? 'hit' : 'miss');
        return entry;
      });
      this.metrics.cacheLookup(route.name, 'exact', hit ? 'hit' : 'miss');
      return hit;
    } catch (err) {
      this.metrics.platformError('cache');
      rctx.logger.warn({ err }, 'cache lookup failed');
      this.metrics.cacheLookup(route.name, 'exact', 'miss');
      return null;
    }
  }

  private async cacheGetMany(keys: string[], rctx: RequestContext): Promise<(CacheEntry | null)[]> {
    if (rctx.cacheMode === 'refresh') return keys.map(() => null);
    const cache = this.services.cache;
    try {
      return cache.getMany
        ? await cache.getMany(keys)
        : await Promise.all(keys.map((k) => cache.get(k)));
    } catch (err) {
      this.metrics.platformError('cache');
      rctx.logger.warn({ err }, 'cache lookup failed');
      return keys.map(() => null);
    }
  }

  /** TTL for chat responses: exact TTL, else the semantic TTL, else 1 h. */
  private chatTtl(route: ResolvedRoute): number {
    return route.cache?.exact?.ttl_s ?? route.cache?.semantic?.ttl_s ?? 3600;
  }

  // -------------------------------------------------------------------------------------------
  // Semantic cache
  // -------------------------------------------------------------------------------------------

  /** Whether the route's semantic cache applies to this request. */
  private semanticEligible(route: ResolvedRoute, req: ChatRequest, rctx: RequestContext): boolean {
    const sem = route.cache?.semantic;
    if (!sem?.enabled || !sem.embed_route || !this.services.semantic) return false;
    if (rctx.cacheMode === 'bypass') return false;
    if ((req.n ?? 1) > 1) return false;
    if (req.temperature != null && req.temperature !== 0) return false;
    return !req.tools?.length;
  }

  /** Embeds the last user message with the route's `semantic.embed_route` (no limits/usage). */
  private async embedForSemantic(
    rctx: RequestContext,
    embedRouteName: string,
    text: string,
    traceContext: Context | undefined,
  ): Promise<number[] | null> {
    const embedRoute = this.config.routes[embedRouteName];
    if (!embedRoute || embedRoute.kind !== 'embedding') return null;
    const { value } = await this.deps.router.dispatch(
      this.dispatchContext(rctx, embedRoute, [], { context: traceContext }),
      'embedding',
      (adapter, m, actx) =>
        adapter.embed!(
          applyInputTemplates({ model: m.upstreamModel, input: text, input_type: 'query' }, m),
          m,
          actx,
        ),
    );
    const emb = value.data[0]?.embedding;
    return Array.isArray(emb) && emb.length > 0 ? emb : null;
  }

  /**
   * Semantic lookup: on a hit returns the cached entry; on a miss returns what is needed to index
   * the eventual response. Failures degrade to "no semantic cache" (logged).
   */
  private async semanticLookup(
    rctx: RequestContext,
    route: ResolvedRoute,
    req: ChatRequest,
  ): Promise<{ hit: CacheEntry; similarity: number } | { pending: SemanticPending } | null> {
    const sem = route.cache!.semantic!;
    const q = semanticQuery(req);
    if (!q) return null;
    return inChildSpan(rctx.trace?.context, 'sy.cache.semantic', async (span, ctx) => {
      const r = await this.semanticLookupInner(rctx, route, sem, q, ctx);
      if (span.isRecording())
        span.setAttribute('sy.cache.result', !r ? 'error' : 'hit' in r ? 'hit' : 'miss');
      return r;
    });
  }

  private async semanticLookupInner(
    rctx: RequestContext,
    route: ResolvedRoute,
    sem: NonNullable<NonNullable<ResolvedRoute['cache']>['semantic']>,
    q: NonNullable<ReturnType<typeof semanticQuery>>,
    traceContext: Context | undefined,
  ): Promise<{ hit: CacheEntry; similarity: number } | { pending: SemanticPending } | null> {
    try {
      const vector = await this.embedForSemantic(rctx, sem.embed_route!, q.text, traceContext);
      if (!vector) return null;
      const index = `${route.name}:${cacheScope(route, rctx.key.team.slug)}:${q.scope}`;
      const pending = { index, vector, ttl: this.chatTtl(route) };
      if (rctx.cacheMode === 'refresh') {
        this.metrics.cacheLookup(route.name, 'semantic', 'bypass');
        return { pending };
      }
      const match = await this.services.semantic!.search(index, vector, sem.min_similarity);
      if (match) {
        const entry = await this.services.cache.get(match.element);
        if (entry && entry.payload.kind === 'chat') {
          this.metrics.cacheLookup(route.name, 'semantic', 'hit');
          return { hit: entry, similarity: match.similarity };
        }
        // Response expired from the exact cache: drop the stale vector.
        void this.services.semantic!.remove(index, match.element).catch(() => undefined);
      }
      this.metrics.cacheLookup(route.name, 'semantic', 'miss');
      return { pending };
    } catch (err) {
      this.metrics.platformError('cache');
      rctx.logger.warn({ err: (err as Error).message }, 'semantic cache lookup failed');
      return null;
    }
  }

  private semanticIndex(
    pending: SemanticPending | undefined,
    cacheKey: string | undefined,
    rctx: RequestContext,
  ): void {
    if (!pending || !cacheKey || !this.services.semantic) return;
    this.services.semantic
      .add(pending.index, pending.vector, cacheKey, { k: cacheKey, at: Date.now() }, pending.ttl)
      .catch((err: unknown) =>
        rctx.logger.warn({ err: (err as Error).message }, 'semantic index write failed'),
      );
  }

  private cacheSet(
    key: string | undefined,
    route: ResolvedRoute,
    payload: CachedPayload,
    o: Outcome,
    rctx: RequestContext,
  ): void {
    const ttl = payload.kind === 'chat' ? this.chatTtl(route) : route.cache?.exact?.ttl_s;
    if (!key || !ttl || !o.model) return;
    this.services.cache
      .set(
        key,
        {
          payload,
          provider: o.model.providerName,
          model: o.model.upstreamModel,
          costUsd: o.costUsd,
          createdAt: Date.now(),
        },
        ttl,
      )
      .catch((err: unknown) => rctx.logger.warn({ err }, 'cache write failed'));
  }

  // -------------------------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------------------------

  /** Route defaults fill in fields the client did not set. */
  applyChatDefaults(req: ChatRequest, route: ResolvedRoute): ChatRequest {
    const out: ChatRequest = { ...req };
    const d = route.defaults;
    if (out.reasoning_effort === undefined && d.reasoning_effort != null)
      out.reasoning_effort = d.reasoning_effort;
    if (out.max_tokens == null && out.max_completion_tokens == null && d.max_tokens !== undefined)
      out.max_tokens = d.max_tokens;
    if (out.temperature === undefined && d.temperature !== undefined)
      out.temperature = d.temperature;
    return out;
  }

  async chat(rctx: RequestContext, input: ChatRequest): Promise<PipelineResult> {
    const route = this.resolveRoute(input.model, rctx.key, 'chat');
    const req = this.applyChatDefaults(input, route);
    const stream = req.stream === true;
    const semantic = this.semanticEligible(route, req, rctx);
    const cacheable = isChatCacheable(route, req, rctx.cacheMode) || semantic;
    const o = this.newOutcome(rctx, stream, cacheable ? 'miss' : 'bypass');
    let admission: Admission | undefined;
    try {
      const promptTokens = estimatePromptTokens(req);
      // `n` choices each generate up to the completion limit.
      const maxCompletion =
        (req.max_completion_tokens ?? req.max_tokens ?? DEFAULT_COMPLETION_ESTIMATE) * (req.n ?? 1);
      admission = await this.admit(rctx, route, promptTokens, maxCompletion);

      const cacheKey = cacheable ? chatCacheKey(route, rctx.key.team.slug, req) : undefined;
      let hit = await this.cacheGet(cacheKey, rctx, route);
      let similarity: number | undefined;
      let pending: SemanticPending | undefined;
      if (semantic && !(hit && hit.payload.kind === 'chat')) {
        const r = await this.semanticLookup(rctx, route, req);
        if (r && 'hit' in r) {
          hit = r.hit;
          similarity = r.similarity;
        } else if (r) {
          pending = r.pending;
        }
      }
      if (hit && hit.payload.kind === 'chat') {
        o.cache = similarity === undefined ? 'hit' : 'semantic-hit';
        if (similarity !== undefined)
          o.extraHeaders = { 'x-sy-semantic-similarity': similarity.toFixed(4) };
        o.savedUsd = hit.costUsd;
        o.cachedFrom = { provider: hit.provider, model: hit.model };
        // The body keeps the original usage; accounting records no upstream tokens for a hit.
        const response: ChatResponse = withCost({ ...hit.payload.response, model: route.name }, o);
        if (stream)
          return this.streamResult(
            rctx,
            route,
            o,
            admission,
            req,
            toAsync(responseToChunks(response)),
            undefined,
            undefined,
          );
        await this.account(rctx, route, 'chat', o, admission);
        return {
          kind: 'json',
          status: 200,
          headers: this.headers(route, o, admission.rate, true),
          body: response,
        };
      }

      const dctx = this.dispatchContext(rctx, route, o.attempts, {
        ...(rctx.trace?.recording ? { request: chatRequestAttributes(req) } : {}),
      });
      if (stream) {
        const { model, stream: chunks } = await this.deps.router.dispatchStream(
          dctx,
          (adapter, m, actx) => adapter.chatStream({ ...req, stream: true }, m, actx),
        );
        o.model = model;
        return this.streamResult(rctx, route, o, admission, req, chunks, cacheKey, pending);
      }

      const { value, model } = await this.deps.router.dispatch(dctx, 'chat', (adapter, m, actx) =>
        adapter.chat({ ...req, stream: false }, m, actx),
      );
      o.model = model;
      o.usage = value.usage;
      o.costUsd = computeCost(value.usage, model.pricing).costUsd;
      const response: ChatResponse = withCost({ ...value, model: route.name }, o);
      const finish = response.choices[0]?.finish_reason;
      if (finish === 'stop' || finish === 'tool_calls' || finish === 'length') {
        this.cacheSet(cacheKey, route, { kind: 'chat', response: value }, o, rctx);
        this.semanticIndex(pending, cacheKey, rctx);
      }
      await this.account(rctx, route, 'chat', o, admission);
      return {
        kind: 'json',
        status: 200,
        headers: this.headers(route, o, admission.rate, true),
        body: response,
      };
    } catch (err) {
      return this.fail(rctx, route, 'chat', o, admission, err);
    }
  }

  /**
   * Builds the SSE response. Headers are final at this point (the router already committed to a
   * target), so `x-sy-cost-usd` is omitted for streams (except cache hits, where it is 0); the
   * final usage chunk carries `usage.cost` instead when the client asked for
   * `stream_options.include_usage`. Cost is also logged and emitted as a usage event.
   */
  private streamResult(
    rctx: RequestContext,
    route: ResolvedRoute,
    o: Outcome,
    admission: Admission,
    req: ChatRequest,
    chunks: AsyncIterable<ChatChunk>,
    cacheKey: string | undefined,
    pending: SemanticPending | undefined,
  ): PipelineResult {
    const includeUsage = req.stream_options?.include_usage === true;
    const acc = new ChunkAccumulator();
    const iterator = chunks[Symbol.asyncIterator]();
    let finished = false;
    // The server span stays open until usage and cost are on it.
    const release = rctx.trace?.hold();
    const finalize = async (failure?: unknown): Promise<void> => {
      if (finished) return;
      finished = true;
      try {
        if (failure !== undefined) {
          const g = toGatewayError(failure);
          o.status = g.status;
          o.errorCode = g.code;
        }
        if (o.cache !== 'hit' && o.cache !== 'semantic-hit' && o.model) {
          o.usage = acc.usage;
          o.costUsd = computeCost(acc.usage, o.model.pricing).costUsd;
          const finish = acc.finishReason;
          if (
            failure === undefined &&
            (finish === 'stop' || finish === 'tool_calls' || finish === 'length')
          ) {
            this.cacheSet(cacheKey, route, { kind: 'chat', response: acc.toResponse() }, o, rctx);
            this.semanticIndex(pending, cacheKey, rctx);
          }
        }
        await this.account(rctx, route, 'chat', o, admission);
      } finally {
        release?.();
      }
    };

    const toClient = (chunk: ChatChunk): ChatChunk | undefined => {
      const isUsageOnly = chunk.choices.length === 0;
      if (isUsageOnly && !includeUsage) return undefined;
      const out: ChatChunk = { ...chunk, model: route.name };
      if (!includeUsage) delete out.usage;
      else if (!isUsageOnly) out.usage = null;
      else if (out.usage) {
        // Headers went out before usage was known: the final usage chunk carries the cost
        // (OpenRouter's `usage.cost` convention). `acc` already contains this chunk.
        const isHit = o.cache === 'hit' || o.cache === 'semantic-hit';
        const cost = isHit ? 0 : computeCost(acc.usage, o.model?.pricing).costUsd;
        out.usage = usageWithCost(out.usage, cost, o);
      }
      return out;
    };

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.enqueue(SSE_DONE);
            controller.close();
            await finalize();
            return;
          }
          acc.push(next.value);
          if (o.ttftMs === null && isMeaningfulChunk(next.value)) {
            o.ttftMs = this.clock() - rctx.startedAt;
            addEvent(rctx.trace?.context, 'sy.first_token', { 'sy.ttft_ms': o.ttftMs });
          }
          const out = toClient(next.value);
          if (out) controller.enqueue(encodeSSE(JSON.stringify(out)));
        } catch (err) {
          const g = toGatewayError(err);
          rctx.logger.warn({ code: g.code, err: g.message }, 'stream failed after first byte');
          controller.enqueue(encodeSSE(JSON.stringify(g.toJSON())));
          controller.enqueue(SSE_DONE);
          controller.close();
          await finalize(err);
        }
      },
      cancel: async () => {
        await iterator.return?.().catch(() => undefined);
        o.status = 499;
        o.errorCode = 'request_aborted';
        await finalize();
      },
    });

    return {
      kind: 'stream',
      status: 200,
      headers: {
        ...this.headers(route, o, admission.rate, o.cache === 'hit' || o.cache === 'semantic-hit'),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      stream,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Embeddings
  // -------------------------------------------------------------------------------------------

  async embeddings(rctx: RequestContext, req: EmbeddingRequest): Promise<PipelineResult> {
    const route = this.resolveRoute(req.model, rctx.key, 'embedding');
    const cacheable = isRouteCacheable(route, rctx.cacheMode);
    const o = this.newOutcome(rctx, false, cacheable ? 'miss' : 'bypass');
    let admission: Admission | undefined;
    try {
      const texts = embeddingInputs(req.input);
      admission = await this.admit(
        rctx,
        route,
        texts.length > 0 ? estimateTextTokens(texts) : 0,
        0,
      );
      if (!cacheable && route.cache?.exact) this.metrics.cacheLookup(route.name, 'exact', 'bypass');
      // String inputs are cached per item; token-array inputs as a whole request.
      if (cacheable && texts.length > 0) {
        return await this.embeddingsPerItem(rctx, route, req, texts, o, admission);
      }
      const cacheKey = cacheable ? embeddingCacheKey(route, rctx.key.team.slug, req) : undefined;
      const hit = cacheable ? await this.cacheGet(cacheKey, rctx, route) : null;
      if (hit && hit.payload.kind === 'embedding') {
        o.cache = 'hit';
        o.savedUsd = hit.costUsd;
        o.cachedFrom = { provider: hit.provider, model: hit.model };
        await this.account(rctx, route, 'embedding', o, admission);
        return {
          kind: 'json',
          status: 200,
          headers: this.headers(route, o, admission.rate, true),
          body: { ...hit.payload.response, model: route.name },
        };
      }
      const { value } = await this.dispatchEmbedding(rctx, route, req, o);
      this.cacheSet(cacheKey, route, { kind: 'embedding', response: value }, o, rctx);
      await this.account(rctx, route, 'embedding', o, admission);
      const body: EmbeddingResponse = { ...value, model: route.name };
      return {
        kind: 'json',
        status: 200,
        headers: this.headers(route, o, admission.rate, true),
        body,
      };
    } catch (err) {
      return this.fail(rctx, route, 'embedding', o, admission, err);
    }
  }

  private async dispatchEmbedding(
    rctx: RequestContext,
    route: ResolvedRoute,
    req: EmbeddingRequest,
    o: Outcome,
  ): Promise<{ value: EmbeddingResponse; model: ResolvedModel }> {
    const { value, model } = await this.deps.router.dispatch(
      this.dispatchContext(rctx, route, o.attempts),
      'embedding',
      (adapter, m, actx) =>
        adapter.embed!(applyInputTemplates({ ...req, model: m.upstreamModel }, m), m, actx),
    );
    o.model = model;
    o.usage = {
      prompt_tokens: value.usage.prompt_tokens,
      completion_tokens: 0,
      total_tokens: value.usage.total_tokens,
    };
    o.costUsd = computeCost(o.usage, model.pricing).costUsd;
    return { value, model };
  }

  /**
   * Per-item embedding cache: every input string is its own cache entry. Hits are served from
   * the cache, only the misses go upstream (one request, original order and titles preserved),
   * and the merged response looks exactly like an uncached one. `x-sy-cache` is `hit` only when
   * every item hit; `x-sy-cache-items: <hits>/<total>` reports partial hits.
   */
  private async embeddingsPerItem(
    rctx: RequestContext,
    route: ResolvedRoute,
    req: EmbeddingRequest,
    texts: string[],
    o: Outcome,
    admission: Admission,
  ): Promise<PipelineResult> {
    const rawTitles = Array.isArray(req.input_titles) ? (req.input_titles as unknown[]) : [];
    const titles = texts.map((_, i) => {
      const t = rawTitles[i];
      return typeof t === 'string' && t.trim() ? t.trim() : null;
    });
    const keys = texts.map((t, i) =>
      embeddingItemCacheKey(route, rctx.key.team.slug, req, t, titles[i]!),
    );
    const cached = await this.cacheGetMany(keys, rctx);
    const items: (EmbeddingData['embedding'] | undefined)[] = cached.map((e) =>
      e && e.payload.kind === 'embedding' ? e.payload.response.data[0]?.embedding : undefined,
    );
    const missIdx = items.flatMap((v, i) => (v === undefined ? [i] : []));
    const hits = texts.length - missIdx.length;
    let cachedTokens = 0;
    for (let i = 0; i < texts.length; i++) {
      if (items[i] === undefined) continue;
      const entry = cached[i]!;
      o.savedUsd += entry.costUsd;
      if (entry.payload.kind === 'embedding')
        cachedTokens += entry.payload.response.usage.prompt_tokens;
      o.cachedFrom ??= { provider: entry.provider, model: entry.model };
    }
    o.savedUsd = Math.round(o.savedUsd * 1e10) / 1e10;
    this.metrics.cacheLookup(route.name, 'exact', missIdx.length === 0 ? 'hit' : 'miss');
    o.extraHeaders = { 'x-sy-cache-items': `${hits}/${texts.length}` };

    let upstreamTokens = 0;
    if (missIdx.length > 0) {
      const sub: EmbeddingRequest = {
        ...req,
        input: missIdx.map((i) => texts[i]!),
        ...(rawTitles.length > 0 ? { input_titles: missIdx.map((i) => titles[i]) } : {}),
      };
      const { value } = await this.dispatchEmbedding(rctx, route, sub, o);
      upstreamTokens = value.usage.prompt_tokens;
      const ordered = [...value.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== missIdx.length) {
        throw new GatewayError(
          502,
          'upstream_error',
          'Embedding upstream returned a different number of vectors',
        );
      }
      // Split the upstream cost/tokens over items proportionally to their estimated size.
      const budget = newTokenBudget();
      const est = missIdx.map((i) => Math.max(1, countTokens(texts[i]!, budget)));
      const estSum = est.reduce((a, b) => a + b, 0);
      const ttl = route.cache?.exact?.ttl_s ?? 0;
      const writes: { key: string; entry: CacheEntry; ttlSeconds: number }[] = [];
      missIdx.forEach((idx, j) => {
        const embedding = ordered[j]!.embedding;
        items[idx] = embedding;
        const share = est[j]! / estSum;
        const tokens = Math.round(upstreamTokens * share);
        writes.push({
          key: keys[idx]!,
          ttlSeconds: ttl,
          entry: {
            payload: {
              kind: 'embedding',
              response: {
                object: 'list',
                data: [{ object: 'embedding', index: 0, embedding }],
                model: value.model,
                usage: { prompt_tokens: tokens, total_tokens: tokens },
              },
            },
            provider: o.model!.providerName,
            model: o.model!.upstreamModel,
            costUsd: Math.round(o.costUsd * share * 1e10) / 1e10,
            createdAt: Date.now(),
          },
        });
      });
      if (ttl > 0) {
        const cache = this.services.cache;
        const write = cache.setMany
          ? cache.setMany(writes)
          : Promise.all(writes.map((w) => cache.set(w.key, w.entry, w.ttlSeconds))).then(
              () => undefined,
            );
        write.catch((err: unknown) => rctx.logger.warn({ err }, 'cache write failed'));
      }
    } else {
      o.cache = 'hit';
    }
    await this.account(rctx, route, 'embedding', o, admission);
    const promptTokens = upstreamTokens + cachedTokens;
    const body: EmbeddingResponse = {
      object: 'list',
      data: items.map((embedding, index) => ({
        object: 'embedding',
        index,
        embedding: embedding!,
      })),
      model: route.name,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    };
    return {
      kind: 'json',
      status: 200,
      headers: this.headers(route, o, admission.rate, true),
      body,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Rerank
  // -------------------------------------------------------------------------------------------

  async rerank(rctx: RequestContext, req: RerankRequest): Promise<PipelineResult> {
    const route = this.resolveRoute(req.model, rctx.key, 'rerank');
    const cacheable = isRouteCacheable(route, rctx.cacheMode);
    const o = this.newOutcome(rctx, false, cacheable ? 'miss' : 'bypass');
    let admission: Admission | undefined;
    try {
      admission = await this.admit(
        rctx,
        route,
        estimateTextTokens([req.query, ...req.documents]),
        0,
      );
      const cacheKey = cacheable ? rerankCacheKey(route, rctx.key.team.slug, req) : undefined;
      const hit = await this.cacheGet(cacheKey, rctx, route);
      if (hit && hit.payload.kind === 'rerank') {
        o.cache = 'hit';
        o.savedUsd = hit.costUsd;
        o.cachedFrom = { provider: hit.provider, model: hit.model };
        await this.account(rctx, route, 'rerank', o, admission);
        return {
          kind: 'json',
          status: 200,
          headers: this.headers(route, o, admission.rate, true),
          body: this.shapeRerank(hit.payload.response, req, route),
        };
      }
      const { value, model } = await this.deps.router.dispatch(
        this.dispatchContext(rctx, route, o.attempts),
        'rerank',
        (adapter, m, actx) => adapter.rerank!({ ...req, model: m.upstreamModel }, m, actx),
      );
      o.model = model;
      o.usage = {
        prompt_tokens: value.usage.total_tokens,
        completion_tokens: 0,
        total_tokens: value.usage.total_tokens,
      };
      o.costUsd = computeCost(o.usage, model.pricing).costUsd;
      this.cacheSet(cacheKey, route, { kind: 'rerank', response: value }, o, rctx);
      await this.account(rctx, route, 'rerank', o, admission);
      return {
        kind: 'json',
        status: 200,
        headers: this.headers(route, o, admission.rate, true),
        body: this.shapeRerank(value, req, route),
      };
    } catch (err) {
      return this.fail(rctx, route, 'rerank', o, admission, err);
    }
  }

  /** Normalizes ordering, top_n and documents regardless of what the upstream returned. */
  private shapeRerank(
    res: RerankResponse,
    req: RerankRequest,
    route: ResolvedRoute,
  ): RerankResponse {
    const results = [...res.results]
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, req.top_n ?? res.results.length)
      .map((r) => ({
        index: r.index,
        relevance_score: r.relevance_score,
        ...(req.return_documents ? { document: { text: req.documents[r.index] ?? '' } } : {}),
      }));
    return { id: res.id || newRerankId(), model: route.name, results, usage: res.usage };
  }

  // -------------------------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------------------------

  listModels(key: ApiKeyRecord, created: number): ModelCard[] {
    const cards: ModelCard[] = [];
    for (const route of Object.values(this.config.routes)) {
      if (route.hidden) continue;
      if (key.allowedRoutes && !key.allowedRoutes.includes(route.name)) continue;
      cards.push({
        id: route.name,
        object: 'model',
        created,
        owned_by: 'switchyard',
        kind: route.kind,
        ...(route.description ? { description: route.description } : {}),
      });
    }
    if (key.allowDirectModels) {
      for (const m of Object.values(this.config.models)) {
        if (this.config.routes[m.name] || !m.enabled) continue;
        if (key.allowedRoutes && !key.allowedRoutes.includes(m.name)) continue;
        cards.push({
          id: m.name,
          object: 'model',
          created,
          owned_by: m.providerName,
          kind: m.kind,
        });
      }
    }
    return cards.sort((a, b) => a.id.localeCompare(b.id));
  }
}
