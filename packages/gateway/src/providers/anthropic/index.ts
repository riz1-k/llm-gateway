import type { AnthropicProviderConfig } from '../../config/schema.js';
import type { ResolvedModel } from '../../config/resolve.js';
import { ProviderError } from '../../core/errors.js';
import type { ChatChunk, ChatRequest, ChatResponse } from '../../core/types.js';
import { scopedSignal } from '../../util/abort.js';
import type { AdapterDeps, AttemptContext, ProviderAdapter, ProviderHealth } from '../base.js';
import { joinUrl } from '../base.js';
import { upstreamFetch, upstreamJson, upstreamSSE, type UpstreamRequest } from '../http.js';
import {
  AnthropicStreamTranslator,
  anthropicError,
  fromAnthropicResponse,
  toAnthropicRequest,
  type AnthropicResponse,
  type TranslatedRequest,
} from './translate.js';

const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Native Anthropic Messages API adapter. Translates canonical OpenAI requests (tools, images,
 * JSON mode, reasoning effort) to `/v1/messages` and streams Anthropic events back as OpenAI chunks.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly type = 'anthropic';
  readonly name: string;
  private readonly config: AnthropicProviderConfig;
  private readonly deps: AdapterDeps;

  constructor(name: string, config: AnthropicProviderConfig, deps: AdapterDeps) {
    this.name = name;
    this.config = config;
    this.deps = deps;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.config.headers,
      'anthropic-version': this.config.anthropic_version,
    };
    if (this.config.api_key) headers['x-api-key'] = this.config.api_key;
    return headers;
  }

  private baseUrl(target?: ResolvedModel): string {
    return target?.baseUrl ?? this.config.base_url;
  }

  private translate(
    req: ChatRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): TranslatedRequest {
    return toAnthropicRequest(req, {
      model: target.upstreamModel,
      provider: this.name,
      routeMaxTokens: ctx.route.defaults.max_tokens,
      defaultMaxTokens: this.config.default_max_tokens,
      jsonMode: this.config.json_mode,
    });
  }

  private request(target: ResolvedModel, body: unknown, signal: AbortSignal): UpstreamRequest {
    return {
      provider: this.name,
      url: joinUrl(this.baseUrl(target), 'v1/messages'),
      headers: this.headers(),
      body,
      signal,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    };
  }

  /** Anthropic uses 529 for "overloaded"; the generic status mapper would call it a plain 5xx. */
  private remap(err: unknown): unknown {
    if (err instanceof ProviderError && err.status === 529) {
      return new ProviderError({
        status: 529,
        code: 'upstream_unavailable',
        message: err.message,
        provider: this.name,
        retryable: true,
        ...(err.retryAfterMs === undefined ? {} : { retryAfterMs: err.retryAfterMs }),
        cause: err,
      });
    }
    return err;
  }

  async chat(req: ChatRequest, target: ResolvedModel, ctx: AttemptContext): Promise<ChatResponse> {
    const t = this.translate(req, target, ctx);
    let res: AnthropicResponse;
    try {
      res = await upstreamJson<AnthropicResponse>(this.request(target, t.body, ctx.signal));
    } catch (err) {
      throw this.remap(err);
    }
    if ((res as { type?: string }).type === 'error') {
      const e = (res as unknown as { error?: { type?: string; message?: string } }).error;
      throw anthropicError(this.name, e?.type, e?.message ?? 'unknown error');
    }
    return fromAnthropicResponse(res, t);
  }

  async *chatStream(
    req: ChatRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): AsyncIterable<ChatChunk> {
    const t = this.translate(req, target, ctx);
    const translator = new AnthropicStreamTranslator({
      ...t,
      provider: this.name,
      model: target.upstreamModel,
    });
    try {
      for await (const ev of upstreamSSE(
        this.request(target, { ...t.body, stream: true }, ctx.signal),
      )) {
        if (!ev.data) continue;
        let data: unknown;
        try {
          data = JSON.parse(ev.data);
        } catch {
          ctx.logger.debug(
            { provider: this.name, event: ev.event },
            'ignoring non-JSON anthropic event',
          );
          continue;
        }
        for (const chunk of translator.handle(ev.event, data)) yield chunk;
        if (translator.done) return;
      }
    } catch (err) {
      throw this.remap(err);
    }
    if (!translator.done) {
      throw new ProviderError({
        status: 502,
        code: 'upstream_error',
        message: `${this.name}: stream ended before message_stop`,
        provider: this.name,
        retryable: true,
      });
    }
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const scope = scopedSignal(signal, HEALTH_TIMEOUT_MS, `${this.name} health check`);
    const started = Date.now();
    try {
      const res = await upstreamFetch({
        provider: this.name,
        url: joinUrl(this.baseUrl(), 'v1/models'),
        headers: this.headers(),
        signal: scope.signal,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      await res.body?.cancel().catch(() => undefined);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      scope.dispose();
    }
  }
}

export * from './translate.js';
