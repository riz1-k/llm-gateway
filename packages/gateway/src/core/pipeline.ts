import type { ResolvedConfig, ResolvedModel, ResolvedRoute } from '../config/resolve.js';
import { directRoute } from '../config/resolve.js';
import type { Logger } from '../observability/logger.js';
import type { CacheMode } from '../cache/keys.js';
import {
  chatCacheKey,
  embeddingCacheKey,
  isChatCacheable,
  isRouteCacheable,
  rerankCacheKey,
} from '../cache/keys.js';
import { estimatePromptTokens, estimateTextTokens } from '../limits/estimate.js';
import { computeCost, estimateCost, formatUsd } from '../usage/pricing.js';
import { encodeSSE, SSE_DONE } from '../util/sse.js';
import { ChunkAccumulator, isMeaningfulChunk, responseToChunks } from './chunks.js';
import { GatewayError, toGatewayError } from './errors.js';
import { newRerankId } from './ids.js';
import { countFallbacks, type AttemptRecord, type DispatchContext, type Router } from './router.js';
import type {
  ApiKeyRecord,
  CachedPayload,
  GatewayServices,
  RateLimitDecision,
  UsageEvent,
} from './services.js';
import { applyInputTemplates, embeddingInputs } from './templates.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
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
  startedAt: number;
  logger: Logger;
  headers: Headers;
  /** Aborts when the client disconnects. */
  signal: AbortSignal;
  key: ApiKeyRecord;
  endUser: string | undefined;
  tags: string[];
  cacheMode: CacheMode;
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
}

const DEFAULT_COMPLETION_ESTIMATE = 1024;

async function* toAsync<T>(it: Iterable<T>): AsyncGenerator<T> {
  yield* it;
}

export class Pipeline {
  private readonly clock: () => number;

  constructor(private readonly deps: PipelineDeps) {
    this.clock = deps.clock ?? Date.now;
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
    const rate = await this.services.rateLimiter.check({
      key: rctx.key,
      route: route.name,
      estimatedTokens: promptTokens + maxCompletion,
    });
    if (!rate.allowed) {
      const headers = { ...rate.headers };
      if (rate.retryAfterMs !== undefined)
        headers['retry-after'] = String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000)));
      throw new GatewayError(
        429,
        'rate_limit_exceeded',
        `Rate limit exceeded (${rate.rejectedBy ?? 'limit'}).`,
        { headers },
      );
    }
    const preflightCostUsd = estimateCost(promptTokens, maxCompletion, this.maxPricing(route));
    const budget = await this.services.budgets.check({
      team: rctx.key.team,
      route: route.name,
      preflightCostUsd,
    });
    if (!budget.allowed) {
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
  ): DispatchContext {
    return {
      requestId: rctx.requestId,
      route,
      logger: rctx.logger,
      signal: rctx.signal,
      requestHeaders: rctx.headers,
      deadline: rctx.startedAt + route.timeoutMs,
      attempts,
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
      if (admission) await this.services.rateLimiter.reconcile(admission.rate, totalTokens);
      if (o.costUsd > 0)
        await this.services.budgets.record({
          team: rctx.key.team,
          route: route.name,
          costUsd: o.costUsd,
        });
    } catch (err) {
      rctx.logger.error({ err }, 'accounting failed');
    }
    const latency = this.clock() - rctx.startedAt;
    const event: UsageEvent = {
      ts: new Date(rctx.startedAt).toISOString(),
      request_id: rctx.requestId,
      team_id: rctx.key.team.id,
      team: rctx.key.team.slug,
      key_id: rctx.key.id,
      route: route.name,
      kind,
      provider: o.model?.providerName ?? null,
      model: o.model?.upstreamModel ?? null,
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
    if (route) {
      await this.account(rctx, route, kind, o, admission);
      Object.assign(gerr.headers, {
        ...this.headers(route, o, admission?.rate, false),
        ...gerr.headers,
      });
    }
    throw gerr;
  }

  private async cacheGet(key: string | undefined, rctx: RequestContext) {
    if (!key || rctx.cacheMode === 'refresh') return null;
    try {
      return await this.services.cache.get(key);
    } catch (err) {
      rctx.logger.warn({ err }, 'cache lookup failed');
      return null;
    }
  }

  private cacheSet(
    key: string | undefined,
    route: ResolvedRoute,
    payload: CachedPayload,
    o: Outcome,
    rctx: RequestContext,
  ): void {
    const ttl = route.cache?.exact?.ttl_s;
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
    const cacheable = isChatCacheable(route, req, rctx.cacheMode);
    const o = this.newOutcome(rctx, stream, cacheable ? 'miss' : 'bypass');
    let admission: Admission | undefined;
    try {
      const promptTokens = estimatePromptTokens(req);
      const maxCompletion =
        req.max_completion_tokens ?? req.max_tokens ?? DEFAULT_COMPLETION_ESTIMATE;
      admission = await this.admit(rctx, route, promptTokens, maxCompletion);

      const cacheKey = cacheable ? chatCacheKey(route, rctx.key.team.slug, req) : undefined;
      const hit = await this.cacheGet(cacheKey, rctx);
      if (hit && hit.payload.kind === 'chat') {
        o.cache = 'hit';
        o.savedUsd = hit.costUsd;
        o.cachedFrom = { provider: hit.provider, model: hit.model };
        const response: ChatResponse = { ...hit.payload.response, model: route.name };
        o.usage = response.usage;
        if (stream)
          return this.streamResult(
            rctx,
            route,
            o,
            admission,
            req,
            toAsync(responseToChunks(response)),
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

      const dctx = this.dispatchContext(rctx, route, o.attempts);
      if (stream) {
        const { model, stream: chunks } = await this.deps.router.dispatchStream(
          dctx,
          (adapter, m, actx) => adapter.chatStream({ ...req, stream: true }, m, actx),
        );
        o.model = model;
        return this.streamResult(rctx, route, o, admission, req, chunks, cacheKey);
      }

      const { value, model } = await this.deps.router.dispatch(dctx, 'chat', (adapter, m, actx) =>
        adapter.chat({ ...req, stream: false }, m, actx),
      );
      o.model = model;
      o.usage = value.usage;
      o.costUsd = computeCost(value.usage, model.pricing).costUsd;
      const response: ChatResponse = { ...value, model: route.name };
      const finish = response.choices[0]?.finish_reason;
      if (finish === 'stop' || finish === 'tool_calls' || finish === 'length') {
        this.cacheSet(cacheKey, route, { kind: 'chat', response: value }, o, rctx);
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
   * target), so `x-sy-cost-usd` is omitted for streams; cost is logged and emitted as usage.
   */
  private streamResult(
    rctx: RequestContext,
    route: ResolvedRoute,
    o: Outcome,
    admission: Admission,
    req: ChatRequest,
    chunks: AsyncIterable<ChatChunk>,
    cacheKey: string | undefined,
  ): PipelineResult {
    const includeUsage = req.stream_options?.include_usage === true;
    const acc = new ChunkAccumulator();
    const iterator = chunks[Symbol.asyncIterator]();
    let finished = false;
    const finalize = async (failure?: unknown): Promise<void> => {
      if (finished) return;
      finished = true;
      if (failure !== undefined) {
        const g = toGatewayError(failure);
        o.status = g.status;
        o.errorCode = g.code;
      }
      if (o.cache !== 'hit' && o.model) {
        o.usage = acc.usage;
        o.costUsd = computeCost(acc.usage, o.model.pricing).costUsd;
        const finish = acc.finishReason;
        if (
          failure === undefined &&
          (finish === 'stop' || finish === 'tool_calls' || finish === 'length')
        ) {
          this.cacheSet(cacheKey, route, { kind: 'chat', response: acc.toResponse() }, o, rctx);
        }
      }
      await this.account(rctx, route, 'chat', o, admission);
    };

    const toClient = (chunk: ChatChunk): ChatChunk | undefined => {
      const isUsageOnly = chunk.choices.length === 0;
      if (isUsageOnly && !includeUsage) return undefined;
      const out: ChatChunk = { ...chunk, model: route.name };
      if (!includeUsage) delete out.usage;
      else if (!isUsageOnly) out.usage = null;
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
          if (o.ttftMs === null && isMeaningfulChunk(next.value))
            o.ttftMs = this.clock() - rctx.startedAt;
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
        ...this.headers(route, o, admission.rate, false),
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
      const cacheKey = cacheable ? embeddingCacheKey(route, rctx.key.team.slug, req) : undefined;
      const hit = await this.cacheGet(cacheKey, rctx);
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
      const hit = await this.cacheGet(cacheKey, rctx);
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
