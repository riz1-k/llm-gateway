import { createHash } from 'node:crypto';
import type { ResolvedRoute } from '../config/resolve.js';
import type { ChatRequest, EmbeddingRequest, RerankRequest } from '../core/types.js';

export type CacheMode = 'default' | 'bypass' | 'refresh';

export function parseCacheMode(header: string | null | undefined): CacheMode {
  const v = header?.trim().toLowerCase();
  return v === 'bypass' || v === 'refresh' ? v : 'default';
}

/** Deterministic JSON: object keys sorted, undefined dropped. */
export function canonicalJSON(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const child = (v as Record<string, unknown>)[k];
        if (child !== undefined) out[k] = walk(child);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Exact-cache eligibility per SPEC §5 (cache enabled, not bypassed, deterministic, n ≤ 1). */
export function isChatCacheable(route: ResolvedRoute, req: ChatRequest, mode: CacheMode): boolean {
  if (mode === 'bypass') return false;
  const exact = route.cache?.exact;
  if (!exact || exact.enabled === false) return false;
  if ((req.n ?? 1) > 1) return false;
  if (req.temperature != null && req.temperature !== 0) return false;
  return true;
}

export function isRouteCacheable(route: ResolvedRoute, mode: CacheMode): boolean {
  if (mode === 'bypass') return false;
  const exact = route.cache?.exact;
  return Boolean(exact && exact.enabled !== false);
}

function scope(route: ResolvedRoute, team: string): string {
  return route.cache?.shared ? 'shared' : `team:${team}`;
}

/**
 * Chat request fields that do not take part in the cache key: transport options, attribution,
 * fields normalized separately (`max_tokens`), and sampling fields that are fixed for every
 * cacheable request (`temperature` 0/unset, `n` ≤ 1 — see {@link isChatCacheable}).
 * Everything else — including passthrough fields such as `logprobs`, `logit_bias`,
 * `parallel_tool_calls` or `metadata` — changes the response and is part of the key.
 */
const CHAT_KEY_IGNORED = new Set([
  'model',
  'stream',
  'stream_options',
  'user',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'n',
]);

/** The parts of a chat request that determine its response (messages excluded on request). */
export function chatKeyMaterial(
  req: ChatRequest,
  opts: { withoutMessages?: boolean } = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req)) {
    if (CHAT_KEY_IGNORED.has(k) || (opts.withoutMessages && k === 'messages')) continue;
    params[k] = v;
  }
  return { params, max_tokens: req.max_completion_tokens ?? req.max_tokens };
}

export function chatCacheKey(route: ResolvedRoute, team: string, req: ChatRequest): string {
  const material = canonicalJSON({ route: route.name, ...chatKeyMaterial(req) });
  return `chat:${route.name}:${scope(route, team)}:${sha256(material)}`;
}

export function embeddingCacheKey(
  route: ResolvedRoute,
  team: string,
  req: EmbeddingRequest,
): string {
  const material = canonicalJSON({
    route: route.name,
    input: req.input,
    input_type: req.input_type,
    input_titles: req.input_titles,
    dimensions: req.dimensions,
    encoding_format: req.encoding_format,
  });
  return `emb:${route.name}:${scope(route, team)}:${sha256(material)}`;
}

export function rerankCacheKey(route: ResolvedRoute, team: string, req: RerankRequest): string {
  const material = canonicalJSON({
    route: route.name,
    query: req.query,
    documents: req.documents,
    top_n: req.top_n,
  });
  return `rr:${route.name}:${scope(route, team)}:${sha256(material)}`;
}

/**
 * Per-input-item embedding cache key: one entry per (route, scope, text, input_type, title,
 * dimensions, encoding_format), so re-ingesting a corpus only embeds new/changed chunks even when
 * batches are composed differently.
 */
export function embeddingItemCacheKey(
  route: ResolvedRoute,
  team: string,
  req: EmbeddingRequest,
  text: string,
  title: string | null,
): string {
  const material = canonicalJSON({
    route: route.name,
    text,
    title,
    input_type: req.input_type,
    dimensions: req.dimensions,
    encoding_format: req.encoding_format,
  });
  return `embi:${route.name}:${scope(route, team)}:${sha256(material)}`;
}

/** Cache scope segment used in keys and semantic index names (`shared` or `team:<slug>`). */
export function cacheScope(route: ResolvedRoute, team: string): string {
  return scope(route, team);
}
