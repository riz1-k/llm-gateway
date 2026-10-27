import { contentTokens, lastUserText, messageText } from './text.js';
import type { MockMessage } from './types.js';

/**
 * `mock-extractive`: a deterministic, RAG-aware "model". It parses `<source id="n" …>…</source>`
 * blocks, scores every source sentence by lexical overlap with the question and answers with the
 * 1–2 best sentences followed by `[n]` citations — or exactly `NO_ANSWER` when nothing overlaps
 * enough. This lets RAG evaluations exercise citations and refusals offline.
 */

export const NO_ANSWER = 'NO_ANSWER';

export interface ParsedSource {
  id: string;
  text: string;
}

const SOURCE_RE = /<source\b([^>]*)>([\s\S]*?)<\/source>/gi;
const ID_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export function parseSources(text: string): ParsedSource[] {
  const out: ParsedSource[] = [];
  for (const m of text.matchAll(SOURCE_RE)) {
    const idMatch = ID_RE.exec(m[1] ?? '');
    const id = idMatch ? (idMatch[1] ?? idMatch[2] ?? idMatch[3] ?? '') : String(out.length + 1);
    out.push({ id, text: (m[2] ?? '').trim() });
  }
  return out;
}

/**
 * The question is the last user message with source blocks removed; if it contains a
 * `Question:` label, only the text after the last label is used (prompt templates usually put
 * instructions before it).
 */
export function extractQuestion(messages: readonly MockMessage[]): string {
  const stripped = lastUserText(messages).replace(SOURCE_RE, ' ');
  const idx = stripped.toLowerCase().lastIndexOf('question:');
  return (idx >= 0 ? stripped.slice(idx + 'question:'.length) : stripped).trim();
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** |q ∩ s| / |q| over stopword-filtered token sets. */
export function overlapScore(questionTokens: ReadonlySet<string>, sentence: string): number {
  if (questionTokens.size === 0) return 0;
  const s = new Set(contentTokens(sentence));
  let hits = 0;
  for (const t of questionTokens) if (s.has(t)) hits++;
  return hits / questionTokens.size;
}

export function extractiveAnswer(messages: readonly MockMessage[], threshold = 0.2): string {
  const allText = messages.map(messageText).join('\n');
  const sources = parseSources(allText);
  const question = extractQuestion(messages);
  const q = new Set(contentTokens(question));
  if (sources.length === 0 || q.size === 0) return NO_ANSWER;

  const scored: { sentence: string; id: string; score: number; order: number }[] = [];
  let order = 0;
  for (const src of sources) {
    for (const sentence of splitSentences(src.text)) {
      scored.push({ sentence, id: src.id, score: overlapScore(q, sentence), order: order++ });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const picked = scored.filter((s) => s.score >= threshold && s.score > 0).slice(0, 2);
  if (picked.length === 0) return NO_ANSWER;
  return picked.map((p) => `${p.sentence} [${p.id}]`).join(' ');
}
