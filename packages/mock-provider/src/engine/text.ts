import type { MockContentPart, MockMessage } from './types.js';

/** Text utilities shared by the mock behaviors. */

const STOPWORDS = new Set(
  (
    'a an the and or but if of to in on at for with by from is are was were be been being it its this that ' +
    'these those as what which who whom how why when where do does did can could should would will shall may ' +
    'might must i you he she we they me my your our their them his her not no yes than then so such there here ' +
    'about into over under up down out please answer question based using use following source sources context ' +
    'given provided only cite citation citations'
  ).split(' '),
);

/** Lowercased word tokens (Unicode letters/digits). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** Tokens with stopwords removed (falls back to all tokens if everything is a stopword). */
export function contentTokens(text: string): string[] {
  const all = tokenize(text);
  const filtered = all.filter((t) => !STOPWORDS.has(t));
  return filtered.length > 0 ? filtered : all;
}

/** Approximate token count (~1.3 tokens per whitespace-separated word). */
export function approxTokens(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

function isTextPart(p: MockContentPart): p is MockContentPart & { text: string } {
  return p.type === 'text' && typeof (p as { text?: unknown }).text === 'string';
}

/** Concatenated text of a message's content (non-text parts ignored). */
export function messageText(m: MockMessage): string {
  const c = m.content;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  return c
    .filter(isTextPart)
    .map((p) => p.text)
    .join('');
}

export function lastUserText(messages: readonly MockMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') return messageText(m);
  }
  return '';
}

/** 32-bit FNV-1a hash. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
