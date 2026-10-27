# ADR 0005: Semantic cache on Redis 8 vector sets

- **Status:** Accepted
- **Date:** 2026-07

## Context

The exact cache only hits on byte-identical requests (after canonicalization). Chat apps often
get the same question in different words. A semantic cache answers those from a stored response
when the new prompt's embedding is close enough. It needs a vector index with TTL-like cleanup
and per-team isolation, and it should not need another datastore.

## Decision

- Use Redis 8's native vector sets (`VADD`, `VSIM`, `VREM`), one set per route and scope.
  Elements are unquantized (`NOQUANT`), so similarity thresholds are exact. Redis reports VSIM
  scores as `(1 + cosine) / 2`; the index converts to and from cosine.
- **What is embedded:** the last user message. Everything else that changes the answer goes into
  the scope hash, which is part of the set key: system and developer prompts, earlier turns, and
  every response-affecting request field (the same fields as the exact-cache key). Only requests
  with an identical scope can share an answer. Requests with tools are not eligible.
- **Element:** the element id is the exact-cache key of the stored response, and its attributes
  carry metadata. A hit loads the response through the exact cache, so TTLs and purges apply to
  both. Dangling elements are removed when their response has expired.
- **Opt-in:** each route enables it (`cache.semantic.enabled`) with its own `embed_route` and
  `min_similarity` (default 0.95). Hits are marked `x-sy-cache: semantic-hit` and carry
  `x-sy-semantic-similarity`.

## Consequences

- No extra infrastructure: Redis is already required for limits and the exact cache.
- Each lookup on a miss costs one embedding call (through the gateway's own routing, cached by
  the exact cache) plus one `VSIM`. That only pays off for routes with real paraphrase traffic.
  It is off for RAG routes, whose prompts embed retrieved context and rarely repeat.
- Wrong-answer risk is controlled by the threshold and the strict scope hash, not eliminated.
  Keep `min_similarity` high for factual routes.
- It needs Redis 8 or later. On older Redis, semantic lookups fail and the gateway logs it and
  serves the request uncached.

## Alternatives considered

- **RediSearch / Redis Stack vector indexes:** heavier, a module dependency, and an index schema
  to manage.
- **pgvector:** puts a Postgres query on the hot path and couples the cache to database health.
- **A dedicated vector DB:** another system to run for a cache.
