import type {
  AssistantMessage,
  ChatChunk,
  ChatChunkDelta,
  ChatResponse,
  FinishReason,
  ToolCall,
  Usage,
} from './types.js';

/** Helpers to build, split and merge OpenAI chat chunks. */

export interface ChunkMeta {
  id: string;
  created: number;
  model: string;
}

export function makeChunk(
  meta: ChunkMeta,
  delta: ChatChunkDelta,
  finish: FinishReason | null = null,
): ChatChunk {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

export function usageChunk(meta: ChunkMeta, usage: Usage): ChatChunk {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [],
    usage,
  };
}

/** Splits text into chunks of roughly `size` characters, preferring whitespace boundaries. */
export function splitText(text: string, size = 48): string[] {
  if (text.length <= size) return text ? [text] : [];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const ws = text.lastIndexOf(' ', end - 1);
      if (ws > i + size / 2) end = ws + 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Synthesizes an OpenAI chunk sequence from a complete response (used for synthetic streaming and
 * cache replay): role chunk → content chunks → tool_call chunks → finish chunk → usage chunk.
 */
export function* responseToChunks(
  res: ChatResponse,
  opts: { chunkSize?: number } = {},
): Generator<ChatChunk> {
  const meta: ChunkMeta = { id: res.id, created: res.created, model: res.model };
  const choice = res.choices[0];
  if (!choice) return;
  const msg = choice.message;
  const pieces = splitText(msg.content ?? '', opts.chunkSize);
  yield makeChunk(meta, {
    role: 'assistant',
    content: pieces.length === 0 ? (msg.tool_calls ? null : '') : pieces[0]!,
  });
  for (const piece of pieces.slice(1)) yield makeChunk(meta, { content: piece });
  if (msg.reasoning_content) yield makeChunk(meta, { reasoning_content: msg.reasoning_content });
  if (msg.tool_calls) {
    for (const [index, tc] of msg.tool_calls.entries()) {
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
      for (const argPiece of splitText(tc.function.arguments, opts.chunkSize ?? 48)) {
        yield makeChunk(meta, { tool_calls: [{ index, function: { arguments: argPiece } }] });
      }
    }
  }
  yield makeChunk(meta, {}, choice.finish_reason ?? 'stop');
  if (res.usage) yield usageChunk(meta, res.usage);
}

/** Accumulates streamed chunks back into a complete response (cache writes, usage, tests). */
export class ChunkAccumulator {
  id = '';
  created = 0;
  model = '';
  content = '';
  reasoning = '';
  finishReason: FinishReason | null = null;
  usage: Usage | undefined;
  sawContent = false;
  private readonly toolCalls = new Map<number, ToolCall>();

  push(chunk: ChatChunk): void {
    if (!this.id) {
      this.id = chunk.id;
      this.created = chunk.created;
      this.model = chunk.model;
    }
    if (chunk.usage) this.usage = chunk.usage;
    for (const choice of chunk.choices) {
      if (choice.index !== 0) continue;
      const d = choice.delta;
      if (typeof d.content === 'string' && d.content.length > 0) {
        this.content += d.content;
        this.sawContent = true;
      }
      if (typeof d.reasoning_content === 'string') this.reasoning += d.reasoning_content;
      for (const tc of d.tool_calls ?? []) {
        const existing = this.toolCalls.get(tc.index);
        if (!existing) {
          this.toolCalls.set(tc.index, {
            id: tc.id ?? '',
            type: 'function',
            function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
          });
        } else {
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        }
        this.sawContent = true;
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
  }

  toResponse(): ChatResponse {
    const toolCalls = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const message: AssistantMessage & { content: string | null } = {
      role: 'assistant',
      content: this.content.length > 0 ? this.content : toolCalls.length > 0 ? null : '',
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
    };
    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finishReason ?? 'stop' }],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

/** True when a chunk carries something a client would observe beyond the initial role marker. */
export function isMeaningfulChunk(chunk: ChatChunk): boolean {
  if (chunk.usage) return true;
  return chunk.choices.some((c) => {
    const d = c.delta;
    return (
      c.finish_reason != null ||
      (typeof d.content === 'string' && d.content.length > 0) ||
      (typeof d.reasoning_content === 'string' && d.reasoning_content.length > 0) ||
      (d.tool_calls?.length ?? 0) > 0 ||
      (typeof d.refusal === 'string' && d.refusal.length > 0)
    );
  });
}

export function makeUsage(
  prompt: number,
  completion: number,
  extra: { cached?: number; cacheWrite?: number; reasoning?: number } = {},
): Usage {
  const usage: Usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (extra.cached !== undefined || extra.cacheWrite !== undefined) {
    usage.prompt_tokens_details = {
      cached_tokens: extra.cached ?? 0,
      ...(extra.cacheWrite ? { cache_write_tokens: extra.cacheWrite } : {}),
    };
  }
  if (extra.reasoning !== undefined)
    usage.completion_tokens_details = { reasoning_tokens: extra.reasoning };
  return usage;
}
