/**
 * Pure OpenAI ⇄ Anthropic Messages API translation (requests, responses, and streaming events).
 * No I/O here; see ./index.ts for the adapter.
 */
import { makeChunk, makeUsage, usageChunk, type ChunkMeta } from '../../core/chunks.js';
import { ProviderError } from '../../core/errors.js';
import { nowSeconds } from '../../core/ids.js';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentPart,
  FinishReason,
  ReasoningEffort,
  ToolCall,
  ToolChoice,
  Usage,
} from '../../core/types.js';

// ---------------------------------------------------------------------------------------------
// Anthropic wire types (subset used by the gateway)
// ---------------------------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export type AnthropicImageSource =
  { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };

export interface AnthropicImageBlock {
  type: 'image';
  source: AnthropicImageSource;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | (AnthropicTextBlock | AnthropicImageBlock)[];
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' };

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type: 'enabled'; budget_tokens: number };
  metadata?: { user_id?: string };
  stream?: boolean;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence?: string | null;
  usage: AnthropicUsage;
}

// ---------------------------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------------------------

/** Name of the synthetic tool used to implement `response_format: json_schema` in tool mode. */
export const JSON_TOOL_NAME = 'json_response';

/** Thinking budgets per OpenAI-style `reasoning_effort`. */
export const THINKING_BUDGETS: Partial<Record<ReasoningEffort, number>> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32000,
  max: 63999,
};

export interface TranslateOptions {
  /** Upstream model id. */
  model: string;
  provider: string;
  /** Route default `max_tokens` (used when the request sets none). */
  routeMaxTokens?: number | undefined;
  /** Provider default `max_tokens`. */
  defaultMaxTokens: number;
  /** How `response_format: json_schema` is implemented. */
  jsonMode: 'tool' | 'prompt';
}

export interface TranslatedRequest {
  body: AnthropicRequest;
  /** True when the synthetic JSON tool was forced; its input becomes the response content. */
  jsonTool: boolean;
  /** True when the client asked for JSON output (fences are stripped from text answers). */
  jsonOutput: boolean;
  includeReasoning: boolean;
}

function unsupported(provider: string, message: string): ProviderError {
  return new ProviderError({
    status: 400,
    code: 'unsupported_content',
    message: `${provider}: ${message}`,
    provider,
    fallback: true,
    countsAsFailure: false,
  });
}

function textOf(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter(
      (p): p is { type: 'text'; text: string } =>
        p.type === 'text' && typeof (p as { text?: unknown }).text === 'string',
    )
    .map((p) => p.text)
    .join('\n');
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** Converts an OpenAI `image_url` into an Anthropic image source. */
export function imageSource(url: string, provider: string): AnthropicImageSource {
  const m = DATA_URL.exec(url);
  if (m) return { type: 'base64', media_type: m[1]!, data: m[2]! };
  if (/^https?:\/\//i.test(url)) return { type: 'url', url };
  throw unsupported(provider, 'image_url must be a data: URL or an http(s) URL');
}

function partsToBlocks(
  content: string | ContentPart[],
  provider: string,
): (AnthropicTextBlock | AnthropicImageBlock)[] {
  if (typeof content === 'string')
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  const blocks: (AnthropicTextBlock | AnthropicImageBlock)[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) blocks.push({ type: 'text', text });
    } else if (part.type === 'image_url') {
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
      if (typeof url !== 'string') throw unsupported(provider, 'image_url part without url');
      blocks.push({ type: 'image', source: imageSource(url, provider) });
    } else {
      throw unsupported(provider, `content part type "${part.type}" is not supported`);
    }
  }
  return blocks;
}

function parseArguments(args: string): unknown {
  if (!args.trim()) return {};
  try {
    const v: unknown = JSON.parse(args);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return {};
  }
}

function messageToBlocks(m: ChatMessage, provider: string): AnthropicMessage | null {
  switch (m.role) {
    case 'user': {
      const content = partsToBlocks(m.content, provider);
      return content.length > 0 ? { role: 'user', content } : null;
    }
    case 'assistant': {
      const content: AnthropicContentBlock[] = [];
      const text = textOf(m.content ?? null);
      if (text.length > 0) content.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parseArguments(tc.function.arguments),
        });
      }
      return content.length > 0 ? { role: 'assistant', content } : null;
    }
    case 'tool': {
      const result: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : partsToBlocks(m.content, provider),
      };
      return { role: 'user', content: [result] };
    }
    default:
      return null;
  }
}

/** Translates OpenAI messages, hoisting system/developer messages and merging same-role turns. */
export function translateMessages(
  messages: ChatMessage[],
  provider: string,
): { system: string | undefined; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      const t = textOf(m.content);
      if (t) system.push(t);
      continue;
    }
    const translated = messageToBlocks(m, provider);
    if (!translated) continue;
    const last = out[out.length - 1];
    if (last && last.role === translated.role) {
      // tool_result blocks must come first in a user turn.
      if (translated.role === 'user' && translated.content.some((b) => b.type === 'tool_result')) {
        const results = last.content.filter((b) => b.type === 'tool_result');
        const rest = last.content.filter((b) => b.type !== 'tool_result');
        last.content = [...results, ...translated.content, ...rest];
      } else {
        last.content.push(...translated.content);
      }
    } else {
      out.push(translated);
    }
  }
  return { system: system.length > 0 ? system.join('\n\n') : undefined, messages: out };
}

export function translateToolChoice(
  choice: ToolChoice | undefined,
  parallel: boolean | undefined,
): AnthropicToolChoice | undefined {
  const disable = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === undefined) return parallel === false ? { type: 'auto', ...disable } : undefined;
  if (choice === 'none') return { type: 'none' };
  if (choice === 'auto') return { type: 'auto', ...disable };
  if (choice === 'required') return { type: 'any', ...disable };
  return { type: 'tool', name: choice.function.name, ...disable };
}

function jsonInstruction(schema: Record<string, unknown> | undefined): string {
  const base =
    'Respond with a single valid JSON value only. Do not include any prose, explanation, or Markdown code fences.';
  return schema
    ? `${base}\nThe JSON must conform to this JSON Schema:\n${JSON.stringify(schema)}`
    : base;
}

/** Builds an Anthropic Messages request from a canonical OpenAI chat request. */
export function toAnthropicRequest(req: ChatRequest, opts: TranslateOptions): TranslatedRequest {
  if (req.n != null && req.n > 1) {
    throw new ProviderError({
      status: 400,
      code: 'invalid_request',
      message: `${opts.provider}: n > 1 is not supported by the Anthropic Messages API`,
      provider: opts.provider,
      fallback: true,
      countsAsFailure: false,
    });
  }
  const { system, messages } = translateMessages(req.messages, opts.provider);
  const systemParts = system ? [system] : [];

  let maxTokens =
    req.max_completion_tokens ?? req.max_tokens ?? opts.routeMaxTokens ?? opts.defaultMaxTokens;
  const body: AnthropicRequest = { model: opts.model, messages, max_tokens: maxTokens };

  let tools: AnthropicTool[] | undefined = req.tools?.map((t) => ({
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }));
  let toolChoice = tools?.length
    ? translateToolChoice(req.tool_choice, req.parallel_tool_calls)
    : undefined;

  let jsonTool = false;
  let jsonOutput = false;
  const rf = req.response_format;
  if (rf && rf.type === 'json_schema') {
    jsonOutput = true;
    if (opts.jsonMode === 'tool' && !tools?.length) {
      jsonTool = true;
      tools = [
        {
          name: JSON_TOOL_NAME,
          description:
            rf.json_schema.description ?? `Return the final answer as ${rf.json_schema.name}.`,
          input_schema: rf.json_schema.schema ?? { type: 'object' },
        },
      ];
      toolChoice = { type: 'tool', name: JSON_TOOL_NAME };
    } else {
      systemParts.push(jsonInstruction(rf.json_schema.schema));
    }
  } else if (rf && rf.type === 'json_object') {
    jsonOutput = true;
    systemParts.push(jsonInstruction(undefined));
  }

  if (tools?.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');

  if (req.stop != null) {
    const stops = (Array.isArray(req.stop) ? req.stop : [req.stop]).filter((s) => s.length > 0);
    if (stops.length > 0) body.stop_sequences = stops;
  }
  if (req.user) body.metadata = { user_id: req.user };

  // Extended thinking is incompatible with forced tool use; forced tools win.
  const forcedTool = toolChoice?.type === 'any' || toolChoice?.type === 'tool';
  const budget = req.reasoning_effort ? THINKING_BUDGETS[req.reasoning_effort] : undefined;
  if (budget !== undefined && !forcedTool) {
    if (maxTokens <= budget) maxTokens = budget + maxTokens;
    body.max_tokens = maxTokens;
    body.thinking = { type: 'enabled', budget_tokens: budget };
  } else {
    if (req.temperature != null) body.temperature = Math.min(1, Math.max(0, req.temperature));
    if (req.top_p != null) body.top_p = req.top_p;
  }

  return {
    body,
    jsonTool,
    jsonOutput,
    includeReasoning: req.metadata?.include_reasoning === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------------------------

export function mapStopReason(reason: string | null | undefined, jsonTool: boolean): FinishReason {
  switch (reason) {
    case 'tool_use':
      return jsonTool ? 'stop' : 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function mapUsage(u: AnthropicUsage): Usage {
  const cached = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const prompt = (u.input_tokens ?? 0) + cached + write;
  return makeUsage(prompt, u.output_tokens ?? 0, {
    cached,
    ...(write ? { cacheWrite: write } : {}),
  });
}

/** Strips a single surrounding Markdown code fence (```json … ```), if present. */
export function stripCodeFence(text: string): string {
  const m = /^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1]! : text;
}

export interface ResponseOptions {
  jsonTool: boolean;
  jsonOutput: boolean;
  includeReasoning: boolean;
}

/** Converts an Anthropic Messages response into an OpenAI chat completion. */
export function fromAnthropicResponse(res: AnthropicResponse, opts: ResponseOptions): ChatResponse {
  let text = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  for (const block of res.content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'thinking') reasoning += block.thinking;
    else if (block.type === 'tool_use') {
      if (opts.jsonTool && block.name === JSON_TOOL_NAME) text = JSON.stringify(block.input ?? {});
      else
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
    }
  }
  if (opts.jsonOutput && !opts.jsonTool) text = stripCodeFence(text);
  const content = text.length > 0 ? text : toolCalls.length > 0 ? null : '';
  return {
    id: res.id,
    object: 'chat.completion',
    created: nowSeconds(),
    model: res.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(opts.includeReasoning && reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: mapStopReason(res.stop_reason, opts.jsonTool),
      },
    ],
    usage: mapUsage(res.usage ?? {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Maps an Anthropic error type (body or stream `error` event) to a ProviderError. */
export function anthropicError(
  provider: string,
  type: string | undefined,
  message: string,
  status?: number,
): ProviderError {
  const msg = `${provider}: ${type ?? 'error'}: ${message}`;
  switch (type) {
    case 'overloaded_error':
      return new ProviderError({
        status: 529,
        code: 'upstream_unavailable',
        message: msg,
        provider,
        retryable: true,
      });
    case 'rate_limit_error':
      return new ProviderError({
        status: 429,
        code: 'rate_limited',
        message: msg,
        provider,
        retryable: true,
      });
    case 'api_error':
      return new ProviderError({
        status: status ?? 500,
        code: 'upstream_error',
        message: msg,
        provider,
        retryable: true,
      });
    case 'timeout_error':
      return new ProviderError({
        status: 504,
        code: 'upstream_timeout',
        message: msg,
        provider,
        retryable: true,
      });
    case 'invalid_request_error':
      return new ProviderError({ status: 400, code: 'invalid_request', message: msg, provider });
    case 'authentication_error':
    case 'permission_error':
      return new ProviderError({
        status: status ?? 401,
        code: 'upstream_auth',
        message: msg,
        provider,
        fallback: true,
      });
    case 'not_found_error':
      return new ProviderError({
        status: 404,
        code: 'upstream_not_found',
        message: msg,
        provider,
        fallback: true,
      });
    default:
      return new ProviderError({
        status: status ?? 502,
        code: 'upstream_error',
        message: msg,
        provider,
        retryable: true,
      });
  }
}

// ---------------------------------------------------------------------------------------------
// Streaming translation
// ---------------------------------------------------------------------------------------------

type BlockKind = 'text' | 'tool' | 'json' | 'thinking' | 'other';

interface StreamEventData {
  type?: string;
  index?: number;
  message?: { id?: string; model?: string; usage?: AnthropicUsage };
  content_block?: { type?: string; id?: string; name?: string; text?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

/**
 * Stateful translator from Anthropic stream events to OpenAI chat chunks.
 * Feed every SSE event to `handle()`; check `done` after the stream ends.
 */
export class AnthropicStreamTranslator {
  private meta: ChunkMeta = { id: '', created: nowSeconds(), model: '' };
  private readonly blocks = new Map<number, { kind: BlockKind; toolIndex?: number }>();
  private nextToolIndex = 0;
  private usage: AnthropicUsage = {};
  private stopReason: string | null = null;
  private jsonStarted = false;
  done = false;

  constructor(private readonly opts: ResponseOptions & { provider: string; model: string }) {
    this.meta.model = opts.model;
  }

  /** Translates one event; returns zero or more chunks. Throws ProviderError on `error` events. */
  handle(eventName: string | undefined, raw: unknown): ChatChunk[] {
    const data = (typeof raw === 'object' && raw !== null ? raw : {}) as StreamEventData;
    const type = data.type ?? eventName;
    switch (type) {
      case 'message_start':
        return this.onMessageStart(data);
      case 'content_block_start':
        return this.onBlockStart(data);
      case 'content_block_delta':
        return this.onBlockDelta(data);
      case 'message_delta':
        if (data.delta?.stop_reason !== undefined) this.stopReason = data.delta.stop_reason;
        if (data.usage) this.mergeUsage(data.usage);
        return [];
      case 'message_stop':
        return this.finish();
      case 'error':
        throw anthropicError(
          this.opts.provider,
          data.error?.type,
          data.error?.message ?? 'stream error',
        );
      default:
        // ping, content_block_stop, unknown future events
        return [];
    }
  }

  private mergeUsage(u: AnthropicUsage): void {
    for (const [k, v] of Object.entries(u) as [keyof AnthropicUsage, number | null | undefined][]) {
      if (typeof v === 'number') this.usage[k] = v;
    }
  }

  private onMessageStart(data: StreamEventData): ChatChunk[] {
    const m = data.message ?? {};
    this.meta = {
      id: m.id ?? this.meta.id,
      created: nowSeconds(),
      model: m.model ?? this.meta.model,
    };
    if (m.usage) this.mergeUsage(m.usage);
    return [makeChunk(this.meta, { role: 'assistant', content: '' })];
  }

  private onBlockStart(data: StreamEventData): ChatChunk[] {
    const index = data.index ?? 0;
    const block = data.content_block ?? {};
    if (block.type === 'text') {
      this.blocks.set(index, { kind: 'text' });
      return block.text ? [makeChunk(this.meta, { content: block.text })] : [];
    }
    if (block.type === 'thinking') {
      this.blocks.set(index, { kind: 'thinking' });
      return [];
    }
    if (block.type === 'tool_use') {
      if (this.opts.jsonTool && block.name === JSON_TOOL_NAME) {
        this.blocks.set(index, { kind: 'json' });
        return [];
      }
      const toolIndex = this.nextToolIndex++;
      this.blocks.set(index, { kind: 'tool', toolIndex });
      return [
        makeChunk(this.meta, {
          tool_calls: [
            {
              index: toolIndex,
              id: block.id ?? '',
              type: 'function',
              function: { name: block.name ?? '', arguments: '' },
            },
          ],
        }),
      ];
    }
    this.blocks.set(index, { kind: 'other' });
    return [];
  }

  private onBlockDelta(data: StreamEventData): ChatChunk[] {
    const block = this.blocks.get(data.index ?? 0);
    const d = data.delta ?? {};
    if (!block) return [];
    if (d.type === 'text_delta' && d.text) return [makeChunk(this.meta, { content: d.text })];
    if (d.type === 'input_json_delta' && d.partial_json) {
      if (block.kind === 'json') {
        this.jsonStarted = true;
        return [makeChunk(this.meta, { content: d.partial_json })];
      }
      if (block.kind === 'tool') {
        return [
          makeChunk(this.meta, {
            tool_calls: [{ index: block.toolIndex!, function: { arguments: d.partial_json } }],
          }),
        ];
      }
    }
    if (d.type === 'thinking_delta' && d.thinking && this.opts.includeReasoning) {
      return [makeChunk(this.meta, { reasoning_content: d.thinking })];
    }
    return [];
  }

  /** Emits the finish chunk and the usage chunk (idempotent). */
  finish(): ChatChunk[] {
    if (this.done) return [];
    this.done = true;
    const out: ChatChunk[] = [];
    if (
      this.opts.jsonTool &&
      !this.jsonStarted &&
      this.blocks.size > 0 &&
      [...this.blocks.values()].some((b) => b.kind === 'json')
    ) {
      out.push(makeChunk(this.meta, { content: '{}' }));
    }
    out.push(makeChunk(this.meta, {}, mapStopReason(this.stopReason, this.opts.jsonTool)));
    out.push(usageChunk(this.meta, mapUsage(this.usage)));
    return out;
  }
}
