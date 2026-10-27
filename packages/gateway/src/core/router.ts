import type { BreakerConfig } from '../config/schema.js';
import type { ResolvedConfig, ResolvedModel, ResolvedRoute } from '../config/resolve.js';
import type { Logger } from '../observability/logger.js';
import type { AttemptContext, ProviderAdapter } from '../providers/base.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { BreakerStore, Outcome } from '../resilience/circuit-breaker.js';
import type { ConcurrencyManager } from '../resilience/concurrency.js';
import { computeBackoff, fitsDeadline, type Random } from '../resilience/retry.js';
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
import type { ChatChunk, OperationKind } from './types.js';

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
}

type Capability = OperationKind;

interface Lease<R> {
  value: R;
  model: ResolvedModel;
  /** Completes the attempt bookkeeping (breaker, semaphore, timers). Idempotent. */
  finish(outcome: Outcome, err?: unknown): void;
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

  constructor(
    private readonly config: ResolvedConfig,
    private readonly registry: ProviderRegistry,
    private readonly deps: RouterDeps,
  ) {
    this.clock = deps.clock ?? Date.now;
    this.random = deps.random ?? Math.random;
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
    const lease = await this.execute(dctx, 'chat', async (adapter, model, actx) => {
      const iterator = op(adapter, model, actx)[Symbol.asyncIterator]();
      const buffered: ChatChunk[] = [];
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          buffered.push(next.value);
          if (isMeaningfulChunk(next.value)) break;
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
    const stream = async function* (): AsyncGenerator<ChatChunk> {
      let outcome: Outcome = 'success';
      let failure: unknown;
      try {
        for (const c of buffered) yield c;
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          yield next.value;
        }
      } catch (err) {
        failure = err;
        outcome = err instanceof ProviderError && !err.countsAsFailure ? 'neutral' : 'failure';
        throw err;
      } finally {
        await iterator.return?.().catch(() => undefined);
        lease.finish(outcome, failure);
      }
    };
    return { model: lease.model, stream: stream() };
  }

  private async execute<R>(
    dctx: DispatchContext,
    capability: Capability,
    attemptFn: (adapter: ProviderAdapter, model: ResolvedModel, actx: AttemptContext) => Promise<R>,
  ): Promise<Lease<R>> {
    const { route } = dctx;
    const strategy = this.deps.strategies.get(route.strategy);
    const ordered = strategy.order(route);
    let lastError: ProviderError | undefined;

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

      for (let attempt = 1; attempt <= route.retry.attempts; attempt++) {
        this.throwIfClientAborted(dctx);
        const now = this.clock();
        if (now >= dctx.deadline) throw this.deadlineError(dctx, lastError);

        const decision = await this.deps.breakers.acquire(model.name, this.breakerCfg);
        if (!decision.allowed) {
          this.skip(dctx, model, 'circuit_open', `circuit ${decision.state} for ${model.name}`);
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
        const attemptTimeout = Math.min(
          target.timeoutMs ?? model.timeoutMs,
          dctx.deadline - started,
        );
        const scope = scopedSignal(dctx.signal, attemptTimeout, `${model.name} attempt`);
        let release: (() => void) | undefined;
        let finished = false;
        const finish = (outcome: Outcome, err?: unknown): void => {
          if (finished) return;
          finished = true;
          scope.dispose();
          release?.();
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

        try {
          const sem = this.deps.concurrency.get(model.providerName, model.provider.max_concurrency);
          release = await sem.acquire(
            Math.min(model.provider.queue_timeout_ms, Math.max(1, dctx.deadline - started)),
            scope.signal,
          );
          const value = await attemptFn(adapter, model, {
            requestId: dctx.requestId,
            signal: scope.signal,
            logger: dctx.logger,
            requestHeaders: dctx.requestHeaders,
            route,
            attempt,
          });
          dctx.attempts.push({
            target: model.name,
            provider: model.providerName,
            model: model.upstreamModel,
            attempt,
            outcome: 'ok',
            latencyMs: this.clock() - started,
          });
          return { value, model, finish };
        } catch (raw) {
          const err = this.normalize(raw, model, scope.timedOut());
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
          if (!err.retryable && !err.fallback) throw err;
          lastError = err;
          if (!err.retryable || attempt >= route.retry.attempts) break;
          const delay = computeBackoff(attempt - 1, route.retry, err.retryAfterMs, this.random);
          if (delay === null || !fitsDeadline(delay, dctx.deadline, this.clock())) break;
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

  private skip(dctx: DispatchContext, model: ResolvedModel, code: string, message: string): void {
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
