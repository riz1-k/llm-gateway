import {
  makeChunk,
  makeUsage,
  responseToChunks,
  splitText,
  usageChunk,
  type ChunkMeta,
} from '../../core/chunks.js';
import { ProviderError } from '../../core/errors.js';
import { newCompletionId, nowSeconds } from '../../core/ids.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  FinishReason,
  ReasoningEffort,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  Usage,
} from '../../core/types.js';
import type { OpencodeProviderConfig } from '../../config/schema.js';
import type { ResolvedModel } from '../../config/resolve.js';
import { AsyncQueue } from '../../util/async-queue.js';
import type { AdapterDeps, AttemptContext, ProviderAdapter, ProviderHealth } from '../base.js';
import {
  OpencodeClient,
  OPENCODE_DISABLED_TOOLS,
  mapOpencodeError,
  type OpencodeMessageResult,
  type PromptBody,
} from './client.js';
import { OpencodeEventHub, type OpencodeEvent } from './events.js';
import {
  buildJsonInstructions,
  buildJsonRepairPrompt,
  isJsonFormat,
  parseJsonOutput,
  type JsonFormat,
} from './json-mode.js';
import {
  buildToolInstructions,
  buildToolRepairPrompt,
  parseToolCalls,
  ToolStreamFilter,
} from './tools.js';
import { renderTranscript } from './transcript.js';

/**
 * Provider adapter for an `opencode serve` bridge (GitHub Copilot models).
 *
 * Every request uses a fresh opencode session that is always deleted afterwards. opencode is not
 * OpenAI-compatible and Copilot Claude rejects opencode's native structured output, so this
 * adapter emulates tool calling and JSON mode (see tools.ts / json-mode.ts) and renders multi-turn
 * conversations into a transcript (transcript.ts). Streaming uses opencode's `/event` SSE feed.
 */

interface Plan {
  body: PromptBody;
  tools: ToolDefinition[] | undefined;
  toolChoice: ToolChoice | undefined;
  parallel: boolean | undefined;
  json: JsonFormat | undefined;
  stop: string[];
  includeReasoning: boolean;
}

interface TurnResult {
  text: string;
  reasoning: string;
  finish: FinishReason;
  tokens: TokenTotals;
}

interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

interface FinalOutput {
  content: string | null;
  toolCalls: ToolCall[];
  finish: FinishReason;
  reasoning: string;
}

const VARIANTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

export function reasoningToVariant(effort: ReasoningEffort | null | undefined): string | undefined {
  return effort && VARIANTS.has(effort) ? effort : undefined;
}

export function mapUsage(t: TokenTotals): Usage {
  return makeUsage(t.input + t.cacheRead + t.cacheWrite, t.output + t.reasoning, {
    cached: t.cacheRead,
    cacheWrite: t.cacheWrite,
    reasoning: t.reasoning,
  });
}

const addTokens = (a: TokenTotals, b: TokenTotals): TokenTotals => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

/** Truncates text at the first stop sequence (opencode has no native `stop`). */
export function applyStop(text: string, stop: string[]): { text: string; stopped: boolean } {
  let cut = -1;
  for (const s of stop) {
    if (!s) continue;
    const i = text.indexOf(s);
    if (i !== -1 && (cut === -1 || i < cut)) cut = i;
  }
  return cut === -1 ? { text, stopped: false } : { text: text.slice(0, cut), stopped: true };
}

type StreamItem =
  | { kind: 'event'; ev: OpencodeEvent }
  | { kind: 'lost' }
  | { kind: 'final'; result: OpencodeMessageResult }
  | { kind: 'error'; err: unknown };

/**
 * Turns opencode session events into text/reasoning deltas for the assistant message.
 * Uses `message.part.delta` when available; falls back to diffing full `message.part.updated`
 * texts for parts that never received deltas.
 */
export class SessionStreamTracker {
  private readonly userMessages = new Set<string>();
  private readonly partTypes = new Map<string, string>();
  private readonly partMessage = new Map<string, string>();
  private readonly emitted = new Map<string, number>();
  private readonly sawDelta = new Set<string>();
  private readonly pending = new Map<string, string[]>();
  text = '';

  handle(ev: OpencodeEvent): { kind: 'text' | 'reasoning'; delta: string }[] {
    const p = ev.properties;
    switch (ev.type) {
      case 'message.updated': {
        const info = p.info as { id?: string; role?: string } | undefined;
        if (info?.role === 'user' && info.id) this.userMessages.add(info.id);
        return [];
      }
      case 'message.part.updated': {
        const part = p.part as
          { id?: string; type?: string; messageID?: string; text?: unknown } | undefined;
        if (!part?.id || !part.type) return [];
        this.partTypes.set(part.id, part.type);
        if (part.messageID) this.partMessage.set(part.id, part.messageID);
        if (this.isUserPart(part.id)) return [];
        const out: { kind: 'text' | 'reasoning'; delta: string }[] = [];
        const queued = this.pending.get(part.id);
        if (queued) {
          this.pending.delete(part.id);
          for (const d of queued) out.push(...this.emit(part.id, d));
        }
        if (!this.sawDelta.has(part.id) && typeof part.text === 'string') {
          const done = this.emitted.get(part.id) ?? 0;
          if (part.text.length > done) out.push(...this.emit(part.id, part.text.slice(done)));
        }
        return out;
      }
      case 'message.part.delta': {
        const partId = p.partID as string | undefined;
        const delta = p.delta;
        if (!partId || typeof delta !== 'string' || p.field !== 'text') return [];
        if (typeof p.messageID === 'string') {
          if (this.userMessages.has(p.messageID)) return [];
          this.partMessage.set(partId, p.messageID);
        }
        this.sawDelta.add(partId);
        if (!this.partTypes.has(partId)) {
          const q = this.pending.get(partId) ?? [];
          q.push(delta);
          this.pending.set(partId, q);
          return [];
        }
        return this.emit(partId, delta);
      }
      default:
        return [];
    }
  }

  private isUserPart(partId: string): boolean {
    const m = this.partMessage.get(partId);
    return m !== undefined && this.userMessages.has(m);
  }

  private emit(partId: string, delta: string): { kind: 'text' | 'reasoning'; delta: string }[] {
    const type = this.partTypes.get(partId);
    this.emitted.set(partId, (this.emitted.get(partId) ?? 0) + delta.length);
    if (type === 'text') {
      this.text += delta;
      return [{ kind: 'text', delta }];
    }
    if (type === 'reasoning') return [{ kind: 'reasoning', delta }];
    return [];
  }
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly type = 'opencode';
  private readonly client: OpencodeClient;
  private readonly hub: OpencodeEventHub;
  private readonly warned = new Set<string>();

  constructor(
    readonly name: string,
    private readonly config: OpencodeProviderConfig,
    private readonly deps: AdapterDeps,
  ) {
    const f = deps.fetch ?? fetch;
    this.client = new OpencodeClient(name, config, f);
    this.hub = new OpencodeEventHub(this.client.url('/event'), this.client.headers, f, deps.logger);
  }

  // -------------------------------------------------------------------------------------------
  // Request planning
  // -------------------------------------------------------------------------------------------

  private plan(req: ChatRequest, target: ResolvedModel, ctx: AttemptContext): Plan {
    if ((req.n ?? 1) > 1) {
      throw new ProviderError({
        status: 400,
        code: 'invalid_request',
        message: `${this.name}: n > 1 is not supported`,
        provider: this.name,
      });
    }
    const transcript = renderTranscript(req.messages, this.name);
    const toolsActive = (req.tools?.length ?? 0) > 0 && req.tool_choice !== 'none';
    const json = isJsonFormat(req.response_format) ? req.response_format : undefined;
    const system = [
      transcript.system,
      toolsActive
        ? buildToolInstructions(req.tools!, req.tool_choice, req.parallel_tool_calls)
        : undefined,
      json ? buildJsonInstructions(json) : undefined,
    ]
      .filter((s): s is string => Boolean(s))
      .join('\n\n');
    this.noteIgnoredParams(req, target, ctx);
    const variant = reasoningToVariant(req.reasoning_effort);
    const stop = req.stop == null ? [] : Array.isArray(req.stop) ? req.stop : [req.stop];
    return {
      body: {
        agent: this.config.agent,
        model: { providerID: this.config.upstream_provider, modelID: target.upstreamModel },
        ...(system ? { system } : {}),
        ...(variant ? { variant } : {}),
        tools: { ...OPENCODE_DISABLED_TOOLS },
        parts: transcript.parts,
      },
      tools: toolsActive ? req.tools : undefined,
      toolChoice: req.tool_choice,
      parallel: req.parallel_tool_calls,
      json,
      stop,
      includeReasoning: req.metadata?.include_reasoning === true,
    };
  }

  private noteIgnoredParams(req: ChatRequest, target: ResolvedModel, ctx: AttemptContext): void {
    const ignored: string[] = [];
    if (!this.config.temperature_models.includes(target.upstreamModel)) {
      if (req.temperature != null) ignored.push('temperature');
      if (req.top_p != null) ignored.push('top_p');
    }
    if (req.max_tokens != null || req.max_completion_tokens != null) ignored.push('max_tokens');
    if (req.seed != null) ignored.push('seed');
    for (const p of ignored) {
      const k = `${target.upstreamModel}:${p}`;
      if (this.warned.has(k)) continue;
      this.warned.add(k);
      ctx.logger.debug(
        { model: target.upstreamModel, param: p },
        'parameter not supported by opencode; ignored',
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------------------------

  private async createSession(ctx: AttemptContext): Promise<string> {
    return this.client.createSession(`${this.config.session_title} ${ctx.requestId}`, ctx.signal);
  }

  /** Aborts (if unfinished) and deletes the session. Never throws. */
  private async cleanup(
    sessionId: string,
    abortFirst: boolean,
    ctx: AttemptContext,
  ): Promise<void> {
    const signal = AbortSignal.timeout(5000);
    try {
      if (abortFirst) await this.client.abort(sessionId, signal).catch(() => undefined);
      await this.client.deleteSession(sessionId, signal);
    } catch (err) {
      ctx.logger.warn(
        { session: sessionId, err: (err as Error).message },
        'failed to delete opencode session',
      );
    }
  }

  private async withSession<T>(
    ctx: AttemptContext,
    fn: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    const sessionId = await this.createSession(ctx);
    let completed = false;
    try {
      const result = await fn(sessionId);
      completed = true;
      return result;
    } finally {
      await this.cleanup(sessionId, !completed, ctx);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Turn execution & output post-processing
  // -------------------------------------------------------------------------------------------

  /** Interprets an opencode message result (throws classified errors). */
  private interpret(result: OpencodeMessageResult): TurnResult {
    const info = result.info;
    const t = info?.tokens ?? {};
    const tokens: TokenTotals = {
      input: t.input ?? 0,
      output: t.output ?? 0,
      reasoning: t.reasoning ?? 0,
      cacheRead: t.cache?.read ?? 0,
      cacheWrite: t.cache?.write ?? 0,
    };
    const parts = result.parts ?? [];
    const text = parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text!)
      .join('');
    const reasoning = parts
      .filter((p) => p.type === 'reasoning' && typeof p.text === 'string')
      .map((p) => p.text!)
      .join('');
    let finish: FinishReason = 'stop';
    if (info?.error) {
      if (info.error.name === 'MessageOutputLengthError') finish = 'length';
      else if (info.error.name === 'ContentFilterError') finish = 'content_filter';
      else throw mapOpencodeError(this.name, info.error);
    } else if (info?.finish === 'length') {
      finish = 'length';
    }
    if (!text && finish === 'stop') {
      throw new ProviderError({
        status: 502,
        code: 'upstream_error',
        message: `${this.name}: empty response from model`,
        provider: this.name,
        retryable: true,
      });
    }
    return { text, reasoning, finish, tokens };
  }

  private async turn(
    sessionId: string,
    body: PromptBody,
    ctx: AttemptContext,
  ): Promise<TurnResult> {
    return this.interpret(await this.client.prompt(sessionId, body, ctx.signal));
  }

  /** Applies stop sequences, tool-call emulation and JSON mode (with repair round-trips). */
  private async postprocess(
    sessionId: string,
    plan: Plan,
    first: TurnResult,
    ctx: AttemptContext,
  ): Promise<{ out: FinalOutput; tokens: TokenTotals }> {
    let tokens = first.tokens;
    const stopped = applyStop(first.text, plan.stop);
    let text = stopped.text;
    let finish: FinishReason = stopped.stopped ? 'stop' : first.finish;

    const repairTurn = async (prompt: string): Promise<TurnResult> => {
      const r = await this.turn(
        sessionId,
        { ...plan.body, parts: [{ type: 'text', text: prompt }] },
        ctx,
      );
      tokens = addTokens(tokens, r.tokens);
      return r;
    };

    if (plan.tools) {
      const opts = { toolChoice: plan.toolChoice, parallel: plan.parallel };
      let parsed = parseToolCalls(text, plan.tools, opts);
      const preamble = parsed.content;
      const mustCall = plan.toolChoice === 'required' || typeof plan.toolChoice === 'object';
      for (
        let i = 0;
        i < this.config.repair_attempts && parsed.errors.length > 0 && (parsed.found || mustCall);
        i++
      ) {
        ctx.logger.info({ errors: parsed.errors, attempt: i + 1 }, 'tool_emulation_repair');
        const r = await repairTurn(buildToolRepairPrompt(parsed.errors));
        parsed = parseToolCalls(r.text, plan.tools, opts);
        if (parsed.errors.length === 0 && parsed.content === null)
          parsed = { ...parsed, content: preamble };
      }
      if (parsed.errors.length > 0) {
        ctx.logger.warn({ errors: parsed.errors }, 'tool_emulation_failed');
        return {
          out: { content: text, toolCalls: [], finish: 'stop', reasoning: first.reasoning },
          tokens,
        };
      }
      if (parsed.calls.length > 0) {
        return {
          out: {
            content: parsed.content,
            toolCalls: parsed.calls,
            finish: 'tool_calls',
            reasoning: first.reasoning,
          },
          tokens,
        };
      }
      text = parsed.content ?? text;
    }

    if (plan.json && finish !== 'length') {
      let parsed = parseJsonOutput(text, plan.json);
      for (let i = 0; i < this.config.repair_attempts && !parsed.ok; i++) {
        ctx.logger.info({ errors: parsed.errors, attempt: i + 1 }, 'json_emulation_repair');
        const r = await repairTurn(buildJsonRepairPrompt(parsed.errors, plan.json));
        parsed = parseJsonOutput(r.text, plan.json);
        finish = r.finish;
      }
      if (!parsed.ok) {
        throw new ProviderError({
          status: 502,
          code: 'upstream_invalid_output',
          message: `${this.name}: model output does not satisfy response_format after repair: ${parsed.errors.join('; ')}`,
          provider: this.name,
          fallback: true,
          countsAsFailure: false,
        });
      }
      text = parsed.text;
    }
    return { out: { content: text, toolCalls: [], finish, reasoning: first.reasoning }, tokens };
  }

  private toResponse(
    out: FinalOutput,
    tokens: TokenTotals,
    target: ResolvedModel,
    includeReasoning: boolean,
  ): ChatResponse {
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
            content: out.content,
            ...(out.toolCalls.length > 0 ? { tool_calls: out.toolCalls } : {}),
            ...(includeReasoning && out.reasoning ? { reasoning_content: out.reasoning } : {}),
          },
          finish_reason: out.finish,
        },
      ],
      usage: mapUsage(tokens),
    };
  }

  // -------------------------------------------------------------------------------------------
  // ProviderAdapter
  // -------------------------------------------------------------------------------------------

  async chat(req: ChatRequest, target: ResolvedModel, ctx: AttemptContext): Promise<ChatResponse> {
    const plan = this.plan(req, target, ctx);
    return this.withSession(ctx, async (sessionId) => {
      const first = await this.turn(sessionId, plan.body, ctx);
      const { out, tokens } = await this.postprocess(sessionId, plan, first, ctx);
      return this.toResponse(out, tokens, target, plan.includeReasoning);
    });
  }

  async *chatStream(
    req: ChatRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): AsyncGenerator<ChatChunk> {
    const plan = this.plan(req, target, ctx);
    // JSON mode must be validated before anything is sent; stop sequences cannot be un-sent.
    if (this.config.streaming === 'synthetic' || plan.json || plan.stop.length > 0) {
      yield* responseToChunks(await this.chat(req, target, ctx));
      return;
    }

    const meta: ChunkMeta = {
      id: newCompletionId(),
      created: nowSeconds(),
      model: target.upstreamModel,
    };
    const sessionId = await this.createSession(ctx);
    const queue = new AsyncQueue<StreamItem>();
    let unsubscribe: (() => void) | undefined;
    let completed = false;
    try {
      try {
        unsubscribe = await this.hub.subscribe(sessionId, {
          onEvent: (ev) => queue.push({ kind: 'event', ev }),
          onLost: () => queue.push({ kind: 'lost' }),
        });
      } catch (err) {
        ctx.logger.warn(
          { err: (err as Error).message },
          'opencode event stream unavailable; streaming the final reply',
        );
      }
      void this.client.prompt(sessionId, plan.body, ctx.signal).then(
        (result) => queue.push({ kind: 'final', result }),
        (err: unknown) => queue.push({ kind: 'error', err }),
      );

      const tracker = new SessionStreamTracker();
      const filter = plan.tools ? new ToolStreamFilter() : undefined;
      let roleSent = false;
      const contentChunk = (content: string): ChatChunk => {
        const c = makeChunk(meta, roleSent ? { content } : { role: 'assistant', content });
        roleSent = true;
        return c;
      };

      let result: OpencodeMessageResult | undefined;
      for await (const item of queue) {
        if (item.kind === 'error') throw item.err;
        if (item.kind === 'final') {
          result = item.result;
          break;
        }
        if (item.kind === 'lost') continue;
        for (const d of tracker.handle(item.ev)) {
          if (d.kind === 'text') {
            const out = filter ? filter.push(d.delta) : d.delta;
            if (out) yield contentChunk(out);
          } else if (plan.includeReasoning) {
            yield makeChunk(
              meta,
              roleSent
                ? { reasoning_content: d.delta }
                : { role: 'assistant', reasoning_content: d.delta },
            );
            roleSent = true;
          }
        }
      }
      if (!result)
        throw new ProviderError({
          status: 502,
          code: 'upstream_error',
          message: `${this.name}: stream ended without a reply`,
          provider: this.name,
          retryable: true,
        });

      const first = this.interpret(result);
      let finish: FinishReason = first.finish;
      let tokens = first.tokens;
      if (!plan.tools) {
        // Deltas may have been missed (late subscription, lost stream): send the remainder.
        if (first.text.startsWith(tracker.text)) {
          const rest = first.text.slice(tracker.text.length);
          for (const piece of splitText(rest)) yield contentChunk(piece);
        } else if (tracker.text.length === 0) {
          for (const piece of splitText(first.text)) yield contentChunk(piece);
        } else {
          ctx.logger.debug('streamed text diverged from final reply; keeping streamed text');
        }
      } else {
        const processed = await this.postprocess(sessionId, plan, first, ctx);
        tokens = processed.tokens;
        finish = processed.out.finish;
        const emitted = filter!.emittedText.trim();
        const content = processed.out.content ?? '';
        if (content && content.startsWith(emitted)) {
          const rest = content.slice(emitted.length);
          for (const piece of splitText(rest)) yield contentChunk(piece);
        }
        for (const [index, tc] of processed.out.toolCalls.entries()) {
          const header = {
            index,
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: '' },
          };
          yield makeChunk(
            meta,
            roleSent
              ? { tool_calls: [header] }
              : { role: 'assistant', content: null, tool_calls: [header] },
          );
          roleSent = true;
          yield makeChunk(meta, {
            tool_calls: [{ index, function: { arguments: tc.function.arguments } }],
          });
        }
      }
      if (!roleSent) yield contentChunk('');
      yield makeChunk(meta, {}, finish);
      yield usageChunk(meta, mapUsage(tokens));
      completed = true;
    } finally {
      unsubscribe?.();
      queue.close();
      await this.cleanup(sessionId, !completed, ctx);
    }
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const h = await this.client.health(signal ?? AbortSignal.timeout(3000));
      return {
        ok: h.healthy,
        latencyMs: Date.now() - started,
        detail: `opencode ${h.version ?? 'unknown'}`,
      };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, detail: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    this.hub.close();
  }
}
