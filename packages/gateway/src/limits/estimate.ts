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

/**
 * js-tiktoken's byte-pair merge is quadratic in the byte length of each pre-token (a run of
 * letters, punctuation or whitespace), and encoding is CPU work on the event loop, so untrusted
 * request bodies could stall the gateway (10 KB of "aaaa…" took ~10 s). Estimation is bounded:
 *
 * - long runs are estimated instead of encoded: more than {@link MAX_EXACT_RUN} characters, or
 *   more than {@link MAX_EXACT_RUN_NON_ASCII} consecutive non-ASCII characters (CJK, emoji: 3–4
 *   bytes each);
 * - at most {@link EXACT_BUDGET_BYTES} UTF-8 bytes per request are encoded exactly (a
 *   {@link TokenBudget} is shared by all texts of one request); the rest is estimated.
 *
 * Worst case is ≈ 50 ms of encoding per request instead of unbounded; ordinary prose is exact.
 *
 * The estimate is UTF-8 bytes / 4 (≈ chars/4 for ASCII, ≈ 0.75 per CJK character).
 */
export const MAX_EXACT_RUN = 12;
export const MAX_EXACT_RUN_NON_ASCII = 4;
export const EXACT_BUDGET_BYTES = 16_384;

const LONG_RUN = new RegExp(
  [
    `[\\p{L}\\p{M}]{${MAX_EXACT_RUN + 1},}`,
    `[^\\s\\p{L}\\p{M}\\p{N}]{${MAX_EXACT_RUN + 1},}`,
    `\\s{${MAX_EXACT_RUN + 1},}`,
    `[^\\x00-\\x7F\\s\\p{N}]{${MAX_EXACT_RUN_NON_ASCII + 1},}`,
  ].join('|'),
  'gu',
);

/** Remaining exact-tokenization allowance, shared by every text of one request. */
export interface TokenBudget {
  exactBytes: number;
}

export const newTokenBudget = (): TokenBudget => ({ exactBytes: EXACT_BUDGET_BYTES });

const heuristicTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

export function countTokens(text: string, budget: TokenBudget = newTokenBudget()): number {
  if (!text) return 0;
  // Cheap pre-check (bytes ≥ chars) before measuring the exact byte length.
  if (!encoder || text.length > budget.exactBytes) return heuristicTokens(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > budget.exactBytes) return Math.ceil(bytes / 4);
  budget.exactBytes -= bytes;
  const enc = encoder;
  const encode = (s: string): number => (s ? enc.encode(s, [], []).length : 0);
  try {
    let total = 0;
    let last = 0;
    for (const m of text.matchAll(LONG_RUN)) {
      total += encode(text.slice(last, m.index)) + heuristicTokens(m[0]);
      last = m.index + m[0].length;
    }
    return total + encode(text.slice(last));
  } catch {
    return heuristicTokens(text);
  }
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

function messageTokens(m: ChatMessage, budget: TokenBudget): number {
  let n = 4; // per-message framing overhead
  n += countTokens(contentToText(m.content ?? null), budget);
  if (Array.isArray(m.content))
    n += m.content.filter((p) => p.type === 'image_url').length * IMAGE_TOKENS;
  if (m.role === 'assistant' && m.tool_calls) {
    for (const tc of m.tool_calls)
      n += countTokens(tc.function.name, budget) + countTokens(tc.function.arguments, budget) + 4;
  }
  return n;
}

/** Upper-bound-ish prompt token estimate for a chat request (messages + tool schemas). */
export function estimatePromptTokens(
  req: Pick<ChatRequest, 'messages' | 'tools' | 'response_format'>,
): number {
  const budget = newTokenBudget();
  let n = 3;
  for (const m of req.messages) n += messageTokens(m, budget);
  if (req.tools?.length) n += countTokens(JSON.stringify(req.tools), budget) + 20;
  if (req.response_format && req.response_format.type === 'json_schema') {
    n += countTokens(JSON.stringify(req.response_format.json_schema.schema ?? {}), budget);
  }
  return n;
}

export function estimateTextTokens(
  texts: string[],
  budget: TokenBudget = newTokenBudget(),
): number {
  return texts.reduce((acc, t) => acc + countTokens(t, budget), 0);
}
