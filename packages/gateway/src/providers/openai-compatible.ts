import type { OpenAICompatibleProviderConfig, OpenAIProviderConfig } from '../config/schema.js';
import type { ResolvedModel } from '../config/resolve.js';
import { ChunkAccumulator, makeUsage, usageChunk } from '../core/chunks.js';
import { ProviderError } from '../core/errors.js';
import { newCompletionId, newRerankId, nowSeconds } from '../core/ids.js';
import type {
  ChatChunk,
  ChatChunkChoice,
  ChatRequest,
  ChatResponse,
  EmbeddingData,
  EmbeddingRequest,
  EmbeddingResponse,
  RerankRequest,
  RerankResponse,
  RerankResult,
} from '../core/types.js';
import {
  countTokens,
  contentToText,
  estimatePromptTokens,
  estimateTextTokens,
} from '../limits/estimate.js';
import { scopedSignal } from '../util/abort.js';
import type { AdapterDeps, AttemptContext, ProviderAdapter, ProviderHealth } from './base.js';
import { joinUrl } from './base.js';
import { upstreamJson, upstreamSSE, upstreamFetch, type FetchLike } from './http.js';

/** Request fields that only the gateway understands and must never reach an upstream. */
const GATEWAY_ONLY_FIELDS = ['metadata', 'input_type', 'input_titles'] as const;

const HEALTH_TIMEOUT_MS = 5_000;

type OpenAIFamilyConfig = OpenAICompatibleProviderConfig | OpenAIProviderConfig;

/** Removes gateway-only and null-valued fields from an outgoing body (shallow). */
export function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    if ((GATEWAY_ONLY_FIELDS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  if (out.reasoning_effort === 'none') delete out.reasoning_effort;
  return out;
}

/**
 * Adapter for any server speaking the OpenAI REST dialect (llama.cpp, vLLM, Ollama, Groq, …):
 * chat (incl. native tools and SSE streaming), embeddings, and Cohere/Jina-style rerank.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly type: string = 'openai-compatible';
  readonly name: string;
  protected readonly config: OpenAIFamilyConfig;
  protected readonly deps: AdapterDeps;

  constructor(name: string, config: OpenAIFamilyConfig, deps: AdapterDeps) {
    this.name = name;
    this.config = config;
    this.deps = deps;
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  protected get fetchImpl(): FetchLike | undefined {
    return this.deps.fetch;
  }

  protected baseUrl(target?: ResolvedModel): string {
    return target?.baseUrl ?? this.config.base_url;
  }

  /** Auth + configured headers. Subclasses add vendor headers. */
  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.config.headers };
    if (this.config.api_key) headers.authorization = `Bearer ${this.config.api_key}`;
    return headers;
  }

  protected get supportsTools(): boolean {
    return this.config.type === 'openai-compatible' ? this.config.supports_tools : true;
  }

  protected get supportsStreamUsage(): boolean {
    return this.config.type === 'openai-compatible' ? this.config.supports_stream_usage : true;
  }

  /** Builds the upstream chat body: model params as defaults, client request on top. */
  protected buildChatBody(
    req: ChatRequest,
    target: ResolvedModel,
    stream: boolean,
  ): Record<string, unknown> {
    if (req.tools && req.tools.length > 0 && !this.supportsTools) {
      throw new ProviderError({
        status: 400,
        code: 'unsupported_content',
        message: `${this.name}: upstream ${target.upstreamModel} does not support tools`,
        provider: this.name,
        retryable: false,
        fallback: true,
        countsAsFailure: false,
      });
    }
    const body = sanitizeBody({ ...target.params, ...req, model: target.upstreamModel });
    if (stream) {
      body.stream = true;
      if (this.supportsStreamUsage) {
        const existing =
          typeof body.stream_options === 'object' && body.stream_options !== null
            ? (body.stream_options as Record<string, unknown>)
            : {};
        body.stream_options = { ...existing, include_usage: true };
      } else {
        delete body.stream_options;
      }
    } else {
      delete body.stream;
      delete body.stream_options;
    }
    return body;
  }

  // ------------------------------------------------------------------------------------------
  // Chat
  // ------------------------------------------------------------------------------------------

  async chat(req: ChatRequest, target: ResolvedModel, ctx: AttemptContext): Promise<ChatResponse> {
    const body = this.buildChatBody(req, target, false);
    const raw = await upstreamJson<Partial<ChatResponse>>({
      provider: this.name,
      url: joinUrl(this.baseUrl(target), 'chat/completions'),
      headers: this.buildHeaders(),
      body,
      signal: ctx.signal,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    return normalizeChatResponse(raw, req, target);
  }

  async *chatStream(
    req: ChatRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): AsyncIterable<ChatChunk> {
    const body = this.buildChatBody(req, target, true);
    const acc = new ChunkAccumulator();
    let sawUsage = false;
    let meta: { id: string; created: number; model: string } | undefined;
    for await (const ev of upstreamSSE({
      provider: this.name,
      url: joinUrl(this.baseUrl(target), 'chat/completions'),
      headers: this.buildHeaders(),
      body,
      signal: ctx.signal,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    })) {
      const data = ev.data.trim();
      if (data === '') continue;
      if (data === '[DONE]') break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        ctx.logger.debug({ provider: this.name }, 'ignoring non-JSON SSE event');
        continue;
      }
      if (isErrorPayload(parsed)) {
        throw new ProviderError({
          status: 502,
          code: 'upstream_error',
          message: `${this.name}: upstream stream error: ${parsed.error.message ?? 'unknown error'}`,
          provider: this.name,
          retryable: true,
        });
      }
      const chunk = normalizeChunk(parsed, meta, target);
      meta ??= { id: chunk.id, created: chunk.created, model: chunk.model };
      if (chunk.usage) sawUsage = true;
      acc.push(chunk);
      yield chunk;
    }
    if (!sawUsage) {
      const m = meta ?? {
        id: newCompletionId(),
        created: nowSeconds(),
        model: target.upstreamModel,
      };
      const prompt = estimatePromptTokens(req);
      const toolCalls = acc.toResponse().choices[0]?.message.tool_calls ?? [];
      const completion =
        countTokens(acc.content) +
        countTokens(acc.reasoning) +
        toolCalls.reduce(
          (n, tc) => n + countTokens(tc.function.name) + countTokens(tc.function.arguments),
          0,
        );
      yield usageChunk(m, makeUsage(prompt, completion));
    }
  }

  // ------------------------------------------------------------------------------------------
  // Embeddings
  // ------------------------------------------------------------------------------------------

  async embed(
    req: EmbeddingRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): Promise<EmbeddingResponse> {
    const body = sanitizeBody({ ...target.params, ...req, model: target.upstreamModel });
    const raw = await upstreamJson<Partial<EmbeddingResponse>>({
      provider: this.name,
      url: joinUrl(this.baseUrl(target), 'embeddings'),
      headers: this.buildHeaders(),
      body,
      signal: ctx.signal,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    return normalizeEmbeddingResponse(raw, req, target, this.name);
  }

  // ------------------------------------------------------------------------------------------
  // Rerank
  // ------------------------------------------------------------------------------------------

  async rerank(
    req: RerankRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): Promise<RerankResponse> {
    const body: Record<string, unknown> = {
      model: target.upstreamModel,
      query: req.query,
      documents: req.documents,
    };
    if (req.top_n !== undefined) body.top_n = req.top_n;
    const raw = await upstreamJson<unknown>({
      provider: this.name,
      url: joinUrl(this.baseUrl(target), 'rerank'),
      headers: this.buildHeaders(),
      body,
      signal: ctx.signal,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    return normalizeRerankResponse(raw, req, target, this.name);
  }

  // ------------------------------------------------------------------------------------------
  // Health
  // ------------------------------------------------------------------------------------------

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const scope = scopedSignal(signal, HEALTH_TIMEOUT_MS, `${this.name} health check`);
    const started = Date.now();
    try {
      const res = await upstreamFetch({
        provider: this.name,
        url: joinUrl(this.baseUrl(), 'models'),
        headers: this.buildHeaders(),
        signal: scope.signal,
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
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

// ---------------------------------------------------------------------------------------------
// Normalization (exported for reuse/tests)
// ---------------------------------------------------------------------------------------------

function isErrorPayload(v: unknown): v is { error: { message?: string } } {
  return typeof v === 'object' && v !== null && 'error' in v && typeof v.error === 'object';
}

/** Fills missing fields in a non-streaming upstream response and estimates usage if absent. */
export function normalizeChatResponse(
  raw: Partial<ChatResponse>,
  req: ChatRequest,
  target: ResolvedModel,
): ChatResponse {
  const choices = (Array.isArray(raw.choices) ? raw.choices : []).map((c, i) => ({
    ...c,
    index: typeof c.index === 'number' ? c.index : i,
    message: { ...c.message, role: 'assistant' as const, content: c.message?.content ?? null },
    finish_reason: c.finish_reason ?? 'stop',
  }));
  const res: ChatResponse = {
    ...raw,
    id: raw.id ?? newCompletionId(),
    object: 'chat.completion',
    created: raw.created ?? nowSeconds(),
    model: raw.model ?? target.upstreamModel,
    choices,
  };
  if (!raw.usage) {
    const msg = choices[0]?.message;
    const completion =
      countTokens(contentToText(msg?.content ?? null)) +
      (msg?.tool_calls ?? []).reduce(
        (n, tc) => n + countTokens(tc.function.arguments) + countTokens(tc.function.name),
        0,
      );
    res.usage = makeUsage(estimatePromptTokens(req), completion);
  }
  return res;
}

/** Fills defaults on a streamed chunk (some servers omit id/created/object/index). */
export function normalizeChunk(
  raw: unknown,
  meta: { id: string; created: number; model: string } | undefined,
  target: ResolvedModel,
): ChatChunk {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ChatChunk>;
  const choices: ChatChunkChoice[] = (Array.isArray(obj.choices) ? obj.choices : []).map(
    (c, i) => ({
      ...c,
      index: typeof c.index === 'number' ? c.index : i,
      delta: c.delta ?? {},
      finish_reason: c.finish_reason ?? null,
    }),
  );
  const chunk: ChatChunk = {
    ...obj,
    id: obj.id ?? meta?.id ?? newCompletionId(),
    object: 'chat.completion.chunk',
    created: obj.created ?? meta?.created ?? nowSeconds(),
    model: obj.model ?? meta?.model ?? target.upstreamModel,
    choices,
  };
  if (obj.usage === null || obj.usage === undefined) delete chunk.usage;
  return chunk;
}

export function normalizeEmbeddingResponse(
  raw: Partial<EmbeddingResponse>,
  req: EmbeddingRequest,
  target: ResolvedModel,
  provider: string,
): EmbeddingResponse {
  if (!Array.isArray(raw.data)) {
    throw new ProviderError({
      status: 502,
      code: 'upstream_error',
      message: `${provider}: embeddings response has no data array`,
      provider,
      retryable: true,
    });
  }
  const data: EmbeddingData[] = raw.data
    .map((d, i) => ({
      object: 'embedding' as const,
      index: typeof d.index === 'number' ? d.index : i,
      embedding: d.embedding,
    }))
    .sort((a, b) => a.index - b.index);
  const texts = Array.isArray(req.input)
    ? req.input.filter((x): x is string => typeof x === 'string')
    : typeof req.input === 'string'
      ? [req.input]
      : [];
  const prompt = raw.usage?.prompt_tokens ?? estimateTextTokens(texts);
  return {
    object: 'list',
    data,
    model: raw.model ?? target.upstreamModel,
    usage: { prompt_tokens: prompt, total_tokens: raw.usage?.total_tokens ?? prompt },
  };
}

interface RawRerankResult {
  index?: unknown;
  relevance_score?: unknown;
  score?: unknown;
}

/** Normalizes llama.cpp / Jina / Cohere / TEI rerank responses into the Cohere shape. */
export function normalizeRerankResponse(
  raw: unknown,
  req: RerankRequest,
  target: ResolvedModel,
  provider: string,
): RerankResponse {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const list: unknown = Array.isArray(raw) ? raw : (obj.results ?? obj.data);
  if (!Array.isArray(list)) {
    throw new ProviderError({
      status: 502,
      code: 'upstream_error',
      message: `${provider}: rerank response has no results array`,
      provider,
      retryable: true,
    });
  }
  let results: RerankResult[] = list
    .map((r: RawRerankResult, i: number) => {
      const index = typeof r.index === 'number' ? r.index : i;
      const score =
        typeof r.relevance_score === 'number'
          ? r.relevance_score
          : typeof r.score === 'number'
            ? r.score
            : 0;
      return { index, relevance_score: score };
    })
    .filter((r) => r.index >= 0 && r.index < req.documents.length)
    .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
  if (req.top_n !== undefined && req.top_n >= 0) results = results.slice(0, req.top_n);
  if (req.return_documents) {
    results = results.map((r) => ({ ...r, document: { text: req.documents[r.index] ?? '' } }));
  }
  const usage = obj.usage as { total_tokens?: unknown; prompt_tokens?: unknown } | undefined;
  const total =
    typeof usage?.total_tokens === 'number'
      ? usage.total_tokens
      : typeof usage?.prompt_tokens === 'number'
        ? usage.prompt_tokens
        : estimateTextTokens([req.query, ...req.documents]) +
          req.documents.length * countTokens(req.query);
  return {
    id: typeof obj.id === 'string' ? obj.id : newRerankId(),
    model: typeof obj.model === 'string' ? obj.model : target.upstreamModel,
    results,
    usage: { total_tokens: total },
  };
}
