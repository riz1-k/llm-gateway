import { fnv1a, tokenize } from './text.js';

/**
 * Deterministic hashed bag-of-words embeddings: every lowercased word (weight 1.0) and every
 * character trigram of `#word#` (weight 0.5) is hashed (FNV-1a) into one of `dim` signed buckets;
 * the vector is L2-normalized. Identical text → identical vector; lexically similar texts have
 * high cosine similarity, which is enough for retrieval tests.
 */
export function mockEmbedding(text: string, dim = 256): number[] {
  const v = new Array<number>(dim).fill(0);
  const add = (feature: string, weight: number): void => {
    const h = fnv1a(feature);
    const sign = (h & 0x80000000) !== 0 ? -1 : 1;
    v[h % dim]! += sign * weight;
  };
  for (const word of tokenize(text)) {
    add(`w:${word}`, 1);
    const padded = `#${word}#`;
    for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.5);
  }
  let norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
  if (norm === 0) {
    v[fnv1a(text) % dim] = 1;
    norm = 1;
  }
  return v.map((x) => x / norm);
}

export function mockEmbeddings(texts: readonly string[], dim = 256): number[][] {
  return texts.map((t) => mockEmbedding(t, dim));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Encodes a vector as base64 little-endian float32 (OpenAI `encoding_format: "base64"`). */
export function embeddingToBase64(v: readonly number[]): string {
  const buf = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => buf.writeFloatLE(x, i * 4));
  return buf.toString('base64');
}
