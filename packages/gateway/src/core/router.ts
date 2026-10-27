import {
  context,
  SpanKind,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import type { BreakerConfig } from '../config/schema.js';
import type { ResolvedConfig, ResolvedModel, ResolvedRoute } from '../config/resolve.js';
import type { Logger } from '../observability/logger.js';
import { noopMetrics, type GatewayMetrics } from '../observability/metrics.js';
import {
  addEvent,
  GEN_AI_OPERATION,
  genAiProviderName,
  recordFailure,
  responseAttributes,
  serverEndpoint,
  tracer,
  usageAttributes,
} from '../observability/tracing.js';
import type { AttemptContext, ProviderAdapter } from '../providers/base.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { BreakerStore, CircuitState, Outcome } from '../resilience/circuit-breaker.js';
import type { ConcurrencyManager } from '../resilience/concurrency.js';
import { computeBackoff, fitsDeadline, type Random } from '../resilience/retry.js';
import { computeCost } from '../usage/pricing.js';
import {
  abortReason,
  ClientAbortError,
  DeadlineExceededError,
  scopedSignal,
  sleep,
} from '../util/abort.js';
import { isMeaningfulChunk } from './chunks.js';
import { ProviderError } from './errors.js';
import type { StrategyRegistry } from './strategies.js';
import type { ChatChunk, OperationKind, Usage } from './types.js';

export interface AttemptRecord {
  target: string;
  provider: string;
  model: string;
  /** 1-based attempt number on this target. */
  attempt: number;
  outcome: 'ok' | 'error' | 'skipped';
  status?: number;
  code?: string;
  message?: string;
  latencyMs: number;
}

export interface DispatchContext {
  requestId: string;
  route: ResolvedRoute;
  logger: Logger;
  /** Client signal (aborts on disconnect). */
  signal: AbortSignal;
  requestHeaders: Headers;
  /** Absolute epoch-ms deadline for the whole request. */
  deadline: number;
  attempts: AttemptRecord[];
  /** Parent of the attempt spans (the request's server span or a stage span). */
  traceContext?: Context | undefined;
  /** `gen_ai.request.*` attributes copied onto every attempt span. */
  genAiRequest?: Attributes;
}

export interface DispatchResult<T> {
  value: T;
  model: ResolvedModel;
}

export interface StreamDispatchResult {
  model: ResolvedModel;
  /** Yields buffered leading chunks, then the rest of the upstream stream. */
  stream: AsyncIterable<ChatChunk>;
}

export interface RouterDeps {
  breakers: BreakerStore;
  concurrency: ConcurrencyManager;
  strategies: StrategyRegistry;
  random?: Random;
  clock?: () => number;
  metrics?: GatewayMetrics;
}

type Capability = OperationKind;

interface Lease<R> {
  value: R;
  model: ResolvedModel;
  /** The attempt's CLIENT span, when the request is traced; ended by `finish`. */
  span: Span | undefined;
  /** Completes the attempt bookkeeping (breaker, semaphore, timers, span). Idempotent. */
  finish(outcome: Outcome, err?: unknown): void;
}

/** What preceded an attempt on this request: the previous target and why it failed or was skipped. */
interface Previous {
  target: string;
  code: string;
}

/** OpenAI-shaped usage from any upstream result (rerank reports only `total_tokens`). */
function normalizedUsage(u: Partial<Usage> | null | undefined): Usage | undefined {
  if (!u) return undefined;
  const prompt = u.prompt_tokens ?? u.total_tokens ?? 0;
  const completion = u.completion_tokens ?? 0;
  return {
    ...u,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

const supports = (adapter: ProviderAdapter, cap: Capability): boolean =>
  cap === 'chat'
    ? true
    : cap === 'embedding'
      ? typeof adapter.embed === 'function'
      : typeof adapter.rerank === 'function';

/**
 * Dispatches a request across a route's targets: strategy order → breaker check → concurrency
 * slot → per-attempt timeout → retry with backoff (same target) → fallback (next target).
 */
export class Router {
  private readonly clock: () => number;
  private readonly random: Random;
  private readonly metrics: GatewayMetrics;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly registry: ProviderRegistry,
    private readonly deps: RouterDeps,
  ) {
    this.clock = deps.clock ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.metrics = deps.metrics ?? noopMetrics;
  }

  private get breakerCfg(): BreakerConfig {
    return this.config.breaker;
  }

  /** Non-streaming dispatch. */
  async dispatch<T>(
    dctx: DispatchContext,
    capability: Capability,
    op: (adapter: ProviderAdapter, model: ResolvedModel, actx: AttemptContext) => Promise<T>,
  ): Promise<DispatchResult<T>> {
    const lease = await this.execute(dctx, capability, async (adapter, model, actx) =>
      op(adapter, model, actx),
    );
    if (lease.span?.isRecording()) {
      const value = lease.value as { usage?: Partial<Usage> } | undefined;
      lease.span.setAttributes(responseAttributes(value));
      lease.span.setAttribute(
        'sy.cost_usd',
        computeCost(normalizedUsage(value?.usage), lease.model.pricing).costUsd,
      );
    }
    lease.finish('success');
    return { value: lease.value, model: lease.model };
  }

  /**
   * Streaming dispatch. An attempt is committed once its first *meaningful* chunk arrives (role-only
   * preambles are buffered), so retries and fallbacks remain possible until a byte would be flushed
   * to the client. Errors after that propagate through the returned stream.
   */
  async dispatchStream(
    dctx: DispatchContext,
    op: (
      adapter: ProviderAdapter,
      model: ResolvedModel,
      actx: AttemptContext,
    ) => AsyncIterable<ChatChunk>,
  ): Promise<StreamDispatchResult> {
    const lease = await this.execute(dctx, 'chat', async (adapter, model, actx, span) => {
      const issued = this.clock();
      const iterator = op(adapter, model, actx)[Symbol.asyncIterator]();
      const buffered: ChatChunk[] = [];
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          buffered.push(next.value);
          if (isMeaningfulChunk(next.value)) {
            span?.setAttribute(
              'gen_ai.response.time_to_first_chunk',
              (this.clock() - issued) / 1000,
            );
            break;
          }
        }
      } catch (err) {
        await iterator.return?.().catch(() => undefined);
        throw err;
      }
      if (buffered.length === 0) {
        throw new ProviderError({
          status: 502,
          code: 'upstream_error',
          message: `${model.providerName}: stream ended without data`,
          provider: model.providerName,
          retryable: true,
        });
      }
      return { iterator, buffered };
    });

    const { iterator, buffered } = lease.value;
    const span = lease.span?.isRecording() ? lease.span : undefined;
    const pricing = lease.model.pricing;
    const stream = async function* (): AsyncGenerator<ChatChunk> {
      let outcome: Outcome = 'success';
      let failure: unknown;
      // Response metadata for the attempt span (traced requests only; never content).
      let usage: Usage | undefined;
      let responseId: string | undefined;
      let responseModel: string | undefined;
      const finishReasons: string[] = [];
      let completed = false;
      const observe = (c: ChatChunk): void => {
        if (c.usage) usage = c.usage;
        if (c.id) responseId ??= c.id;
        if (c.model) responseModel ??= c.model;
        for (const choice of c.choices) {
          if (choice.finish_reason) finishReasons[choice.index] = choice.finish_reason;
        }
      };
      try {
        for (const c of buffered) {
          if (span) observe(c);
          yield c;
        }
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          if (span) observe(next.value);
          yield next.value;
        }
        completed = true;
      } catch (err) {
        failure = err;
        outcome = err instanceof ProviderError && !err.countsAsFailure ? 'neutral' : 'failure';
        throw err;
      } finally {
        await iterator.return?.().catch(() => undefined);
        if (span) {
          span.setAttributes(usageAttributes(usage));
          if (responseId) span.setAttribute('gen_ai.response.id', responseId);
          if (responseModel) span.setAttribute('gen_ai.response.model', responseModel);
          const reasons = finishReasons.filter(Boolean);
          if (reasons.length > 0) span.setAttribute('gen_ai.response.finish_reasons', reasons);
          span.setAttribute('sy.cost_usd', computeCost(usage, pricing).costUsd);
          // The consumer stopped reading (client disconnect): the upstream call was cut short.
          if (!completed && failure === undefined) recordFailure(span, 'aborted');
        }
        lease.finish(outcome, failure);
      }
    };
    return { model: lease.model, stream: stream() };
  }

  private async execute<R>(
    dctx: DispatchContext,
    capability: Capability,
    attemptFn: (
      adapter: ProviderAdapter,
      model: ResolvedModel,
      actx: AttemptContext,
      span: Span | undefined,
    ) => Promise<R>,
  ): Promise<Lease<R>> {
    const { route } = dctx;
    const strategy = this.deps.strategies.get(route.strategy);
    const ordered = strategy.order(route);
    let lastError: ProviderError | undefined;
    const traced = Boolean(dctx.traceContext && trace.getSpan(dctx.traceContext)?.isRecording());
    let targetIndex = -1;
    let previous: Previous | undefined;

    for (const target of ordered) {
      const model = this.config.models[target.model];
      if (!model) continue;
      const adapter = this.registry.get(model.providerName);
      if (!model.enabled || !adapter) {
        this.skip(dctx, model, 'target_disabled', model.disabledReason ?? 'provider not available');
        continue;
      }
      if (!supports(adapter, capability)) {
        this.skip(
          dctx,
          model,
          'unsupported',
          `${model.provider.type} does not support ${capability}`,
        );
        continue;
      }

      targetIndex++;
      for (let attempt = 1; attempt <= route.retry.attempts; attempt++) {
        this.throwIfClientAborted(dctx);
        const now = this.clock();
        if (now >= dctx.deadline) throw this.deadlineError(dctx, lastError);

        const decision = await this.deps.breakers.acquire(model.name, this.breakerCfg);
        if (!decision.allowed) {
          this.skip(dctx, model, 'circuit_open', `circuit ${decision.state} for ${model.name}`);
          previous = { target: model.name, code: 'circuit_open' };
          lastError = new ProviderError({
            status: 503,
            code: 'circuit_open',
            message: `circuit open for ${model.name}`,
            provider: model.providerName,
            retryable: false,
            fallback: true,
            countsAsFailure: false,
            ...(decision.retryAt ? { retryAfterMs: Math.max(0, decision.retryAt - now) } : {}),
          });
          break;
        }

        const started = this.clock();
        const targetTimeoutMs = target.timeoutMs ?? model.timeoutMs;
        const attemptTimeout = Math.min(targetTimeoutMs, dctx.deadline - started);
        // When the route deadline, not the target's own timeout, bounds this attempt, its timer firing means the
        // deadline is spent. Timers can fire a few ms before the clock reaches the deadline, so don't let a clock
        // re-check start a fallback in that sliver.
        const deadlineBound = attemptTimeout < targetTimeoutMs;
        const scope = scopedSignal(dctx.signal, attemptTimeout, `${model.name} attempt`);
        const span = traced
          ? this.startAttemptSpan(
              dctx,
              model,
              capability,
              attempt,
              targetIndex,
              previous,
              decision.state,
            )
          : undefined;
        let release: (() => void) | undefined;
        let finished = false;
        const finish = (outcome: Outcome, err?: unknown): void => {
          if (finished) return;
          finished = true;
          scope.dispose();
          release?.();
          if (span) {
            if (err !== undefined && outcome !== 'success') {
              const code = err instanceof ProviderError ? err.code : 'stream_error';
              recordFailure(span, code, err);
            }
            span.end();
          }
          const latency = this.clock() - started;
          void this.deps.breakers
            .record(model.name, outcome, this.breakerCfg, decision.probe)
            .then((state) => {
              if (state === 'open' && outcome === 'failure') {
                dctx.logger.warn({ target: model.name }, 'circuit opened');
              }
            });
          if (outcome !== 'neutral')
            this.deps.strategies.observe(route, model.name, latency, outcome === 'success');
          if (err !== undefined && outcome !== 'success') {
            dctx.logger.warn(
              { target: model.name, err: describe(err) },
              'stream failed after commit',
            );
          }
        };

        let upstreamStarted: number | undefined;
        try {
          const sem = this.deps.concurrency.get(model.providerName, model.provider.max_concurrency);
          release = await sem.acquire(
            Math.min(model.provider.queue_timeout_ms, Math.max(1, dctx.deadline - started)),
            scope.signal,
          );
          upstreamStarted = this.clock();
          this.metrics.queueWait(model.providerName, (upstreamStarted - started) / 1000);
          span?.setAttribute('sy.queue_wait_ms', upstreamStarted - started);
          const actx: AttemptContext = {
            requestId: dctx.requestId,
            signal: scope.signal,
            logger: dctx.logger,
            requestHeaders: dctx.requestHeaders,
            route,
            attempt,
          };
          // Adapters run inside the attempt span's context, so outbound requests carry its
          // traceparent (an unsampled request still propagates its trace and decision).
          const parent = dctx.traceContext ?? context.active();
          const value = await context.with(span ? trace.setSpan(parent, span) : parent, () =>
            attemptFn(adapter, model, actx, span),
          );
          dctx.attempts.push({
            target: model.name,
            provider: model.providerName,
            model: model.upstreamModel,
            attempt,
            outcome: 'ok',
            latencyMs: this.clock() - started,
          });
          this.metrics.upstreamAttempt(
            model.providerName,
            model.upstreamModel,
            (this.clock() - upstreamStarted) / 1000,
            true,
          );
          return { value, model, span, finish };
        } catch (raw) {
          const err = this.normalize(raw, model, scope.timedOut());
          previous = { target: model.name, code: err.code };
          if (span) {
            span.setAttribute('sy.error.status', err.status);
            recordFailure(span, err.code, err);
          }
          if (upstreamStarted !== undefined && err.code !== 'aborted') {
            this.metrics.upstreamAttempt(
              model.providerName,
              model.upstreamModel,
              (this.clock() - upstreamStarted) / 1000,
              false,
            );
          }
          finish(
            err.countsAsFailure
              ? 'failure'
              : err.code === 'invalid_request'
                ? 'success'
                : 'neutral',
          );
          dctx.attempts.push({
            target: model.name,
            provider: model.providerName,
            model: model.upstreamModel,
            attempt,
            outcome: 'error',
            status: err.status,
            code: err.code,
            message: err.message,
            latencyMs: this.clock() - started,
          });
          dctx.logger.info(
            {
              target: model.name,
              attempt,
              status: err.status,
              code: err.code,
              latency_ms: this.clock() - started,
            },
            'upstream attempt failed',
          );
          if (err.code === 'aborted') throw err;
          if (deadlineBound && scope.timedOut()) throw this.deadlineError(dctx, err);
          if (!err.retryable && !err.fallback) throw err;
          lastError = err;
          if (!err.retryable || attempt >= route.retry.attempts) break;
          const delay = computeBackoff(attempt - 1, route.retry, err.retryAfterMs, this.random);
          if (delay === null || !fitsDeadline(delay, dctx.deadline, this.clock())) break;
          addEvent(dctx.traceContext, 'sy.retry_backoff', {
            'sy.target': model.name,
            'sy.delay_ms': delay,
          });
          try {
            await sleep(delay, dctx.signal);
          } catch {
            throw this.abortedError(dctx, model);
          }
        }
      }
    }

    if (this.clock() >= dctx.deadline) throw this.deadlineError(dctx, lastError);
    throw (
      lastError ??
      new ProviderError({
        status: 503,
        code: 'upstream_unavailable',
        message: `route ${route.name}: no available target`,
        provider: 'router',
        retryable: false,
        fallback: false,
      })
    );
  }

  /** CLIENT span of one upstream attempt (GenAI inference/embeddings semconv + `sy.*`). */
  private startAttemptSpan(
    dctx: DispatchContext,
    model: ResolvedModel,
    capability: Capability,
    attempt: number,
    targetIndex: number,
    previous: Previous | undefined,
    circuit: CircuitState,
  ): Span {
    const operation = GEN_AI_OPERATION[capability];
    const attrs: Attributes = {
      'gen_ai.operation.name': operation,
      'gen_ai.provider.name': genAiProviderName(model.provider.type),
      'gen_ai.request.model': model.upstreamModel,
      ...dctx.genAiRequest,
      'sy.route': dctx.route.name,
      'sy.target': model.name,
      'sy.provider': model.providerName,
      'sy.attempt': attempt,
      'sy.retry': attempt - 1,
      'sy.fallback.index': targetIndex,
      'sy.circuit.state': circuit,
    };
    if (previous) {
      attrs[previous.target === model.name ? 'sy.retry.reason' : 'sy.fallback.reason'] =
        previous.code;
    }
    const endpoint = serverEndpoint(
      model.baseUrl ?? (model.provider as { base_url?: string }).base_url,
    );
    if (endpoint) {
      attrs['server.address'] = endpoint.address;
      attrs['server.port'] = endpoint.port;
    }
    return tracer().startSpan(
      `${operation} ${model.upstreamModel}`,
      { kind: SpanKind.CLIENT, attributes: attrs },
      dctx.traceContext,
    );
  }

  private skip(dctx: DispatchContext, model: ResolvedModel, code: string, message: string): void {
    addEvent(dctx.traceContext, 'sy.target_skipped', {
      'sy.target': model.name,
      'sy.skip.reason': code,
    });
    dctx.attempts.push({
      target: model.name,
      provider: model.providerName,
      model: model.upstreamModel,
      attempt: 0,
      outcome: 'skipped',
      code,
      message,
      latencyMs: 0,
    });
  }

  private throwIfClientAborted(dctx: DispatchContext): void {
    if (dctx.signal.aborted) {
      const reason = abortReason(dctx.signal);
      throw new ProviderError({
        status: 499,
        code: 'aborted',
        message: reason.message,
        provider: 'router',
        countsAsFailure: false,
      });
    }
  }

  private abortedError(dctx: DispatchContext, model: ResolvedModel): ProviderError {
    const reason = dctx.signal.aborted ? abortReason(dctx.signal) : new ClientAbortError();
    return new ProviderError({
      status: 499,
      code: 'aborted',
      message: reason.message,
      provider: model.providerName,
      countsAsFailure: false,
    });
  }

  private deadlineError(dctx: DispatchContext, last: ProviderError | undefined): ProviderError {
    return new ProviderError({
      status: 504,
      code: 'upstream_timeout',
      message: `route ${dctx.route.name}: deadline of ${dctx.route.timeoutMs} ms exceeded${last ? ` (last error: ${last.message})` : ''}`,
      provider: 'router',
      retryable: false,
      fallback: false,
      cause: last,
    });
  }

  /** Classifies anything thrown by an adapter. */
  private normalize(err: unknown, model: ResolvedModel, timedOut: boolean): ProviderError {
    if (err instanceof ProviderError) {
      // An adapter may surface our own timeout as a generic abort.
      if (timedOut && err.code === 'aborted') {
        return new ProviderError({
          status: 504,
          code: 'upstream_timeout',
          message: `${model.name}: attempt timed out`,
          provider: model.providerName,
          retryable: true,
          cause: err,
        });
      }
      return err;
    }
    if (timedOut || err instanceof DeadlineExceededError) {
      return new ProviderError({
        status: 504,
        code: 'upstream_timeout',
        message: `${model.name}: attempt timed out`,
        provider: model.providerName,
        retryable: true,
        cause: err,
      });
    }
    if (err instanceof ClientAbortError || (err instanceof Error && err.name === 'AbortError')) {
      return new ProviderError({
        status: 499,
        code: 'aborted',
        message: err.message,
        provider: model.providerName,
        countsAsFailure: false,
        cause: err,
      });
    }
    return new ProviderError({
      status: 502,
      code: 'upstream_error',
      message: `${model.providerName}: ${err instanceof Error ? err.message : String(err)}`,
      provider: model.providerName,
      retryable: false,
      fallback: true,
      cause: err,
    });
  }
}

const describe = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/** Number of distinct targets attempted before the one that served the request. */
export function countFallbacks(attempts: AttemptRecord[], servedBy: string | undefined): number {
  const tried: string[] = [];
  for (const a of attempts) {
    if (a.code === 'target_disabled' || a.code === 'unsupported') continue;
    if (!tried.includes(a.target)) tried.push(a.target);
  }
  if (servedBy === undefined) return Math.max(0, tried.length - 1);
  const idx = tried.indexOf(servedBy);
  return idx === -1 ? Math.max(0, tried.length - 1) : idx;
}
