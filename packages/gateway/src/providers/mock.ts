import {
  decideFailure,
  embeddingToBase64,
  faultsFromHeaders,
  mergeFaults,
  mockEmbeddings,
  mockRerank,
  resolveMode,
  runMockChat,
  wordGroups,
  type MockChatResult,
  type MockEngineOptions,
  type MockFault as EngineFault,
} from '@switchyard/mock-provider';
import { makeChunk, makeUsage, usageChunk, type ChunkMeta } from '../core/chunks.js';
import { ProviderError, providerErrorFromStatus } from '../core/errors.js';
import { newCompletionId, newRerankId, newToolCallId, nowSeconds } from '../core/ids.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  RerankRequest,
  RerankResponse,
  ToolCall,
  Usage,
} from '../core/types.js';
import { mockFaultSchema, type MockFault, type MockProviderConfig } from '../config/schema.js';
import type { ResolvedModel } from '../config/resolve.js';
import { countTokens, estimatePromptTokens } from '../limits/estimate.js';
import { sleep } from '../util/abort.js';
import type { AdapterDeps, AttemptContext, ProviderAdapter, ProviderHealth } from './base.js';
import { mapFetchError } from './http.js';

/**
 * In-process deterministic provider (tests, CI offline tier, chaos demos). Behavior is selected
 * by the target's upstream model id: `mock-echo`, `mock-fixed`, `mock-extractive`, `mock-tools`;
 * embedding/rerank targets use hashed embeddings and lexical rerank.
 *
 * Faults are layered: provider `faults` → model `options.fault` → `x-mock-*` request headers
 * (only when `allow_header_faults: true`; scope with `x-mock-fault-target: <model name>`).
 */
export class MockAdapter implements ProviderAdapter {
  readonly type = 'mock';
  private readonly engineOpts: MockEngineOptions;

  constructor(
    readonly name: string,
    private readonly config: MockProviderConfig,
    private readonly deps: AdapterDeps,
    /** Injectable RNG for fail-rate decisions (tests). */
    private readonly random: () => number = Math.random,
  ) {
    this.engineOpts = {
      fixedText: config.fixed_text,
      extractiveThreshold: config.extractive_threshold,
      scripts: config.scripts,
    };
  }

  async chat(req: ChatRequest, target: ResolvedModel, ctx: AttemptContext): Promise<ChatResponse> {
    await this.applyFaults(target, ctx);
    const result = runMockChat(req, this.engineOpts, resolveMode(target.upstreamModel));
    const toolCalls = toToolCalls(result);
    return {
      id: newCompletionId(),
      object: 'chat.completion',
      created: nowSeconds(),
      model: target.upstreamModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: result.finishReason,
        },
      ],
      usage: chatUsage(req, result.content, toolCalls),
    };
  }

  async *chatStream(
    req: ChatRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): AsyncGenerator<ChatChunk> {
    const fault = await this.applyFaults(target, ctx);
    const result = runMockChat(req, this.engineOpts, resolveMode(target.upstreamModel));
    const toolCalls = toToolCalls(result);
    const meta: ChunkMeta = {
      id: newCompletionId(),
      created: nowSeconds(),
      model: target.upstreamModel,
    };
    const failAfter = fault.streamFailAfter;
    const midStreamFailure = (): ProviderError =>
      new ProviderError({
        status: 502,
        code: 'upstream_error',
        message: `${this.name}: injected mid-stream failure after ${failAfter} chunk(s)`,
        provider: this.name,
        retryable: true,
      });

    yield makeChunk(meta, { role: 'assistant', content: '' });
    for (const [i, piece] of wordGroups(result.content ?? '').entries()) {
      if (failAfter !== undefined && i >= failAfter) throw midStreamFailure();
      this.throwIfAborted(ctx);
      yield makeChunk(meta, { content: piece });
    }
    if (failAfter === 0) throw midStreamFailure();
    for (const [index, tc] of toolCalls.entries()) {
      this.throwIfAborted(ctx);
      yield makeChunk(meta, {
        tool_calls: [
          {
            index,
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: '' },
          },
        ],
      });
      yield makeChunk(meta, {
        tool_calls: [{ index, function: { arguments: tc.function.arguments } }],
      });
    }
    yield makeChunk(meta, {}, result.finishReason);
    yield usageChunk(meta, chatUsage(req, result.content, toolCalls));
  }

  async embed(
    req: EmbeddingRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): Promise<EmbeddingResponse> {
    await this.applyFaults(target, ctx);
    const input = req.input;
    const texts =
      typeof input === 'string'
        ? [input]
        : Array.isArray(input) && input.every((x) => typeof x === 'string')
          ? input
          : null;
    if (!texts) {
      throw new ProviderError({
        status: 400,
        code: 'invalid_request',
        message: `${this.name}: mock embeddings only accept text input`,
        provider: this.name,
      });
    }
    const dim = req.dimensions ?? this.config.embedding_dim;
    const vectors = mockEmbeddings(texts, dim);
    const tokens = texts.reduce((acc, t) => acc + countTokens(t), 0);
    return {
      object: 'list',
      data: vectors.map((v, index) => ({
        object: 'embedding',
        index,
        embedding: req.encoding_format === 'base64' ? embeddingToBase64(v) : v,
      })),
      model: target.upstreamModel,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    };
  }

  async rerank(
    req: RerankRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): Promise<RerankResponse> {
    await this.applyFaults(target, ctx);
    const results = mockRerank(req.query, req.documents, req.top_n).map((r) => ({
      index: r.index,
      relevance_score: r.relevance_score,
      ...(req.return_documents ? { document: { text: req.documents[r.index] ?? '' } } : {}),
    }));
    const tokens =
      countTokens(req.query) * req.documents.length +
      req.documents.reduce((acc, d) => acc + countTokens(d), 0);
    return {
      id: newRerankId(),
      model: target.upstreamModel,
      results,
      usage: { total_tokens: tokens },
    };
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, latencyMs: 0, detail: 'in-process mock' };
  }

  /** Resolves layered faults, applies latency and throws injected failures. */
  private async applyFaults(target: ResolvedModel, ctx: AttemptContext): Promise<EngineFault> {
    const fault = mergeFaults(
      toEngineFault(this.config.faults),
      toEngineFault(this.modelFault(target, ctx)),
      this.config.allow_header_faults
        ? faultsFromHeaders(ctx.requestHeaders, [target.name, target.upstreamModel])
        : undefined,
    );
    if (fault.latencyMs > 0) {
      try {
        await sleep(fault.latencyMs, ctx.signal);
      } catch (err) {
        throw mapFetchError(this.name, err, ctx.signal);
      }
    }
    this.throwIfAborted(ctx);
    const status = decideFailure(fault, this.random);
    if (status !== undefined) {
      const retryAfterMs = fault.retryAfterS === undefined ? undefined : fault.retryAfterS * 1000;
      throw providerErrorFromStatus(
        this.name,
        status,
        `${this.name}: injected ${status} failure (mock)`,
        retryAfterMs,
      );
    }
    return fault;
  }

  private modelFault(target: ResolvedModel, ctx: AttemptContext): MockFault | undefined {
    const raw = target.options.fault;
    if (raw === undefined) return undefined;
    const parsed = mockFaultSchema.safeParse(raw);
    if (!parsed.success) {
      ctx.logger.warn(
        { model: target.name, issues: parsed.error.issues.length },
        'ignoring invalid mock fault options',
      );
      return undefined;
    }
    return parsed.data;
  }

  private throwIfAborted(ctx: AttemptContext): void {
    if (ctx.signal.aborted) throw mapFetchError(this.name, ctx.signal.reason, ctx.signal);
  }
}

function toEngineFault(f: MockFault | undefined): Partial<EngineFault> | undefined {
  if (!f) return undefined;
  return {
    latencyMs: f.latency_ms,
    failRate: f.fail_rate,
    status: f.status,
    retryAfterS: f.retry_after_s,
    streamFailAfter: f.stream_fail_after,
  };
}

function toToolCalls(result: MockChatResult): ToolCall[] {
  return result.toolCalls.map((tc) => ({
    id: newToolCallId(),
    type: 'function',
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
  }));
}

function chatUsage(req: ChatRequest, content: string | null, toolCalls: ToolCall[]): Usage {
  const completion =
    countTokens(content ?? '') +
    toolCalls.reduce(
      (acc, tc) => acc + countTokens(tc.function.name) + countTokens(tc.function.arguments) + 4,
      0,
    );
  return makeUsage(estimatePromptTokens(req), Math.max(1, completion));
}
