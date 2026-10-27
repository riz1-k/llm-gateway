import { contentTokens, fnv1a } from './text.js';
import type { MockRerankResult } from './types.js';

/**
 * Lexical-overlap reranker: score = |q ∩ d| / |q| over stopword-filtered tokens, plus a tiny
 * deterministic tie-breaker derived from the document hash. Scores are in [0, 1].
 */
export function mockRerank(
  query: string,
  documents: readonly string[],
  topN?: number,
): MockRerankResult[] {
  const q = new Set(contentTokens(query));
  const results = documents.map((doc, index) => {
    const d = new Set(contentTokens(doc));
    let hits = 0;
    for (const t of q) if (d.has(t)) hits++;
    const base = q.size === 0 ? 0 : hits / q.size;
    const tieBreak = (fnv1a(doc) % 1000) / 1e6;
    return { index, relevance_score: Math.min(1, base * 0.999 + tieBreak) };
  });
  results.sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
  return topN !== undefined && topN >= 0 ? results.slice(0, topN) : results;
}
