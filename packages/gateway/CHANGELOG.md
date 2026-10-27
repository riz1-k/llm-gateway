# switchyard-gateway

## 0.1.0

First public release.

### Gateway

- OpenAI-compatible API: `/v1/chat/completions` (JSON and SSE, tools, JSON mode / structured
  output), `/v1/embeddings`, `/v1/models`, plus `/v1/rerank` (Cohere/Jina shape). Official OpenAI
  SDKs work unmodified.
- Virtual models (routes) with `fallback`, `weighted` and `least-latency` strategies, retries
  with full-jitter backoff honoring `Retry-After`, per-attempt and per-route deadlines, shared
  circuit breakers, per-provider concurrency limits, and streaming fallback until the first byte.
- Providers: `openai`, `anthropic` (Messages API translation incl. streaming tool use),
  `openai-compatible` (llama.cpp, vLLM, Ollama, … incl. rerank), `opencode` (bridge with
  tool-calling and JSON-mode emulation), `mock` (deterministic, fault-injectable) and `custom`
  (your own adapter via `createGateway({ adapterFactories })`).
- Cost tracking from a pricing table: `x-sy-cost-usd` header, and `usage.cost` in chat bodies and
  in the final streamed usage chunk (`stream_options.include_usage`), with `usage.sy_cache` /
  `usage.sy_saved_cost` for cache hits.

### Platform (optional Redis 8 + Postgres)

- Database-issued virtual keys and teams (hashed, scoped to routes, rotatable, revocation via
  pub/sub), admin API under `/admin/*` and matching CLI commands.
- Sliding-window RPM/TPM limits per key and team (one atomic Lua call), per-team daily/monthly
  USD budgets with pre-flight checks, soft alerts, webhooks and reconciliation.
- Exact-match cache (gzip, per-item embedding cache, streaming replay) and an opt-in semantic
  cache on Redis 8 vector sets.
- Usage pipeline: Redis stream → `switchyard worker` → partitioned Postgres ledger + daily
  rollups, idempotent and crash-safe.
- Prometheus metrics (`sy_*`), health and readiness endpoints, graceful shutdown, hot config
  reload (SIGHUP / `POST /admin/config/reload`).
- Opt-in OpenTelemetry tracing (`observability.otel`, standard `OTEL_*` variables): a span per
  `/v1` request and per upstream attempt with GenAI semantic conventions, W3C `traceparent` in
  and out, `x-sy-trace-id` response header, `trace_id`/`span_id` in logs, OTLP/HTTP export. The
  SDK packages are optional dependencies, loaded only when tracing is on.

### Packaging

- ESM library + `switchyard` CLI (`init`, `serve`, `validate-config`, `worker`, `migrate`,
  `mock-provider`, `teams`, `keys`, `budgets`, `usage`, `cache`, `seed-dev`), typed public API
  with TSDoc, `config.schema.json` for editor validation, bundled mock provider
  (`switchyard-gateway/mock-provider`). Container image `ghcr.io/riz1-k/switchyard`.
