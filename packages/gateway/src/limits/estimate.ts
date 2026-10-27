import type { Tiktoken } from 'js-tiktoken/lite';
import type { ChatMessage, ChatRequest, ContentPart } from '../core/types.js';

/**
 * Token estimation with js-tiktoken (o200k_base). The encoder is loaded lazily (the rank table is
 * a few MB); until `initTokenizer()` resolves, a chars/4 heuristic is used.
 */
let encoder: Tiktoken | undefined;
let loading: Promise<void> | undefined;

export function initTokenizer(): Promise<void> {
  loading ??= (async () => {
    const [{ Tiktoken }, ranks] = await Promise.all([
      import('js-tiktoken/lite'),
      import('js-tiktoken/ranks/o200k_base'),
    ]);
    encoder = new Tiktoken(ranks.default);
  })();
  return loading;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  if (encoder) {
    try {
      return encoder.encode(text, [], []).length;
    } catch {
      // fall through to heuristic on pathological input
    }
  }
  return Math.ceil(text.length / 4);
}

export function contentToText(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((p) =>
      p.type === 'text' && typeof (p as { text?: unknown }).text === 'string'
        ? (p as { text: string }).text
        : '',
    )
    .join('');
}

const IMAGE_TOKENS = 765; // OpenAI high-detail 512px tile estimate

function messageTokens(m: ChatMessage): number {
  let n = 4; // per-message framing overhead
  n += countTokens(contentToText(m.content ?? null));
  if (Array.isArray(m.content))
    n += m.content.filter((p) => p.type === 'image_url').length * IMAGE_TOKENS;
  if (m.role === 'assistant' && m.tool_calls) {
    for (const tc of m.tool_calls)
      n += countTokens(tc.function.name) + countTokens(tc.function.arguments) + 4;
  }
  return n;
}

/** Upper-bound-ish prompt token estimate for a chat request (messages + tool schemas). */
export function estimatePromptTokens(
  req: Pick<ChatRequest, 'messages' | 'tools' | 'response_format'>,
): number {
  let n = 3;
  for (const m of req.messages) n += messageTokens(m);
  if (req.tools?.length) n += countTokens(JSON.stringify(req.tools)) + 20;
  if (req.response_format && req.response_format.type === 'json_schema') {
    n += countTokens(JSON.stringify(req.response_format.json_schema.schema ?? {}));
  }
  return n;
}

export function estimateTextTokens(texts: string[]): number {
  return texts.reduce((acc, t) => acc + countTokens(t), 0);
}
