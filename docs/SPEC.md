# Switchyard — LLM Gateway · Technical Specification

> Open-source TypeScript gateway (Hono + Redis + Postgres) in front of multiple model providers.
> OpenAI-compatible API · fallback & circuit breaking · exact + semantic caching · rate limits ·
> budgets · per-team cost tracking · Prometheus/Grafana · Docker/Helm/Terraform(kind) · npm package.
> Consumers: DocsQA and OpsAgent route **all** model calls (chat, embeddings, rerank) through it.

## 1. Goals / non-goals

**Goals**
1. Drop-in **OpenAI-compatible** endpoint (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`) plus `/v1/rerank` (Cohere/Jina shape). Official OpenAI SDKs (Python/TS) and LangChain `ChatOpenAI` must work unmodified with `base_url` pointed at the gateway.
2. Multiple providers behind **virtual models (routes)** with ordered **fallback**, retries with backoff+jitter honoring `Retry-After`, per-target **timeouts**, shared **circuit breakers**.
3. **Caching**: exact-match (deterministic requests) and opt-in **semantic** cache (Redis 8 vector sets), incl. streaming replay.
4. **Rate limits**: RPM and TPM per key and per team (atomic Lua, sliding window), standard headers.
5. **Budgets**: per-team daily/monthly USD limits, pre-flight cost estimate + post-hoc reconciliation, soft (alert) and hard (block) thresholds.
6. **Cost tracking**: every request priced from a pricing table → usage events → Postgres (partitioned) + daily rollups; per-team/route/model reports; Prometheus counters.
7. **Ops-ready**: structured logs, Prometheus metrics, OpenTelemetry traces (optional), health/readiness, graceful shutdown, hot config reload, Docker image, Helm chart, Terraform (local kind env), Grafana dashboards.
8. **Library + CLI** on npm (`switchyard-gateway`): `createGateway(config)` returns a Hono app; `switchyard serve|worker|migrate|keys|teams|mock-provider|validate-config`.

**Non-goals**: hosted control-plane UI (Grafana + admin API cover it), fine-tuning APIs, assistants/files APIs, image generation.

## 2. Tech stack (pin versions at implementation time; check npm for latest stable)

Node ≥ 22 (dev on 24), TypeScript strict, pnpm workspaces, **Hono** + `@hono/node-server`, **zod** (v4) for config & request validation, **ioredis** (Lua scripts, streams, pipelines), **postgres** (porsager) + **drizzle-orm**/drizzle-kit for schema & migrations, **pino** logging, **prom-client** metrics, `js-tiktoken` for token estimates, **ajv** for JSON-schema validation of emulated tool calls / structured output, `yaml` for config, OpenTelemetry (`@opentelemetry/sdk-node`, optional), **vitest** (+ testcontainers optional; local Redis/PG are available), **tsup** or **tsdown** for builds, **changesets** for releases.

## 3. Repository layout (pnpm monorepo)

```
llm-gateway/
├─ packages/
│  ├─ gateway/                # npm: switchyard-gateway (library + CLI "switchyard")
│  │  ├─ src/
│  │  │  ├─ index.ts          # public API: createGateway, loadConfig, types
│  │  │  ├─ cli.ts            # serve | worker | migrate | keys | teams | mock-provider | validate-config
│  │  │  ├─ app.ts            # Hono app assembly (middleware chain + routes)
│  │  │  ├─ config/           # schema.ts (zod), load.ts (YAML + ${ENV} interpolation), defaults
│  │  │  ├─ http/             # routes: chat.ts, embeddings.ts, rerank.ts, models.ts, admin/*.ts, health.ts, metrics.ts
│  │  │  ├─ core/             # types.ts (canonical request/response), pipeline.ts, router.ts, errors.ts, ids.ts
│  │  │  ├─ providers/        # base.ts, registry.ts, openai.ts, anthropic.ts, openai-compatible.ts, opencode/*.ts, mock.ts
│  │  │  ├─ resilience/       # retry.ts, circuit-breaker.ts, timeout.ts, concurrency.ts (semaphores)
│  │  │  ├─ cache/            # exact.ts, semantic.ts, keys.ts, stream-replay.ts
│  │  │  ├─ limits/           # ratelimit.ts + lua/*.lua, budgets.ts, estimate.ts (token/cost pre-flight)
│  │  │  ├─ usage/            # pricing.ts, events.ts (emit to Redis Stream), writer.ts (worker → PG), rollups.ts
│  │  │  ├─ auth/             # keys.ts (hash/verify/cache), admin.ts
│  │  │  ├─ db/               # drizzle schema.ts, client.ts, migrations/
│  │  │  ├─ observability/    # logger.ts, metrics.ts, tracing.ts
│  │  │  └─ util/             # sse.ts, json.ts, abort.ts
│  │  └─ test/                # unit + integration (vitest)
│  └─ mock-provider/          # fault-injectable fake OpenAI + Anthropic + rerank server (also embedded in CLI)
├─ config/                    # gateway.example.yaml, gateway.local.yaml (devenv), gateway.ci.yaml, pricing.json
├─ deploy/
│  ├─ docker/                 # Dockerfile, docker-compose.yml (gateway, worker, redis, postgres, prometheus, grafana, mock)
│  ├─ helm/switchyard/        # Helm chart
│  └─ terraform/              # modules/{switchyard,redis,postgres,observability}, envs/{local-kind,aws-eks-example}
├─ observability/             # grafana/dashboards/*.json, grafana/provisioning, prometheus/prometheus.yml, alerts.yml
├─ bench/                     # k6 or autocannon load tests + results
├─ docs/                      # SPEC.md (this), ARCHITECTURE.md, ADRs, STATUS.md, guides
└─ .github/workflows/         # ci.yml, release.yml (changesets + npm provenance), docker.yml (GHCR)
```

## 4. Configuration (`gateway.yaml`, validated by zod; `${ENV}` and `${ENV:-default}` interpolation)

```yaml
server: { port: 8787, host: 0.0.0.0, request_timeout_ms: 300000, body_limit_mb: 10 }
redis: { url: ${REDIS_URL:-redis://localhost:6379/0}, key_prefix: "sy:" }
database: { url: ${DATABASE_URL:-postgres://dev:dev@localhost:5432/llmgateway} }
auth:
  admin_token: ${SWITCHYARD_ADMIN_TOKEN}
  static_keys:                       # optional bootstrap keys (dev/CI); DB keys are the normal path
    - { key: ${DOCSQA_GATEWAY_KEY}, team: docsqa, name: bootstrap }
providers:
  copilot:                            # opencode bridge (GitHub Copilot models)
    type: opencode
    base_url: http://127.0.0.1:4096
    username: ${OPENCODE_SERVER_USERNAME:-opencode}
    password: ${OPENCODE_SERVER_PASSWORD}
    agent: gateway
    upstream_provider: github-copilot
    max_concurrency: 4
    timeout_ms: 180000
  local:
    type: openai-compatible
    base_url: http://127.0.0.1:8081/v1     # per-model override allowed (embeddings :8082, rerank :8083)
  openai:   { type: openai,    api_key: ${OPENAI_API_KEY:-}, enabled_if_key: true }
  anthropic:{ type: anthropic, api_key: ${ANTHROPIC_API_KEY:-}, enabled_if_key: true }
  mock:     { type: mock }
models:                               # concrete upstream models ("targets")
  copilot-sonnet: { provider: copilot, model: claude-sonnet-5.5, pricing: { input: 2.0, output: 10.0, cached_input: 0.1 } }   # USD per 1M tokens (shadow price)
  copilot-haiku:  { provider: copilot, model: claude-haiku-4.5, pricing: { input: 1.0, output: 5.0, cached_input: 0.1 } }
  copilot-gpt:    { provider: copilot, model: gpt-5.6-terra, pricing: { input: 1.25, output: 10.0 } }
  local-qwen:     { provider: local, model: qwen3.5-2b, pricing: { input: 0, output: 0 } }
  local-embeddinggemma:
    provider: local
    base_url: http://127.0.0.1:8082/v1
    model: embeddinggemma-300m
    kind: embedding
    input_templates: { query: "task: search result | query: {text}", document: "title: none | text: {text}" }
    pricing: { input: 0 }
  local-jina-rerank: { provider: local, base_url: http://127.0.0.1:8083/v1, model: jina-reranker-v1-tiny-en, kind: rerank, pricing: { input: 0 } }
  mock-chat: { provider: mock, model: mock-extractive }
routes:                               # virtual models exposed to clients
  docsqa-chat:
    targets: [copilot-sonnet, local-qwen]
    strategy: fallback                # fallback | weighted | least-latency
    retry: { attempts: 2, backoff_ms: 250, max_backoff_ms: 4000 }
    timeout_ms: 120000
    cache: { exact: { ttl_s: 86400 }, semantic: { enabled: false } }
    defaults: { reasoning_effort: null }
  docsqa-judge: { targets: [copilot-sonnet], defaults: { reasoning_effort: medium }, cache: { exact: { ttl_s: 604800 } } }
  docsqa-embed: { targets: [local-embeddinggemma], cache: { exact: { ttl_s: 2592000 } } }
  docsqa-rerank: { targets: [local-jina-rerank] }
  opsagent-chat: { targets: [copilot-sonnet, copilot-gpt, local-qwen], cache: { exact: { ttl_s: 3600 } } }
limits:
  defaults: { key: { rpm: 600, tpm: 2000000 }, team: { rpm: 1200, tpm: 5000000 } }
budgets: { enforcement: hard, soft_threshold: 0.8, alert_webhook: null }
usage: { stream: "sy:usage", batch_size: 500, flush_interval_ms: 1000, retention_days: 400 }
observability: { log_level: info, metrics: true, otel: { enabled: false, endpoint: null } }
```

Config is hot-reloadable (`SIGHUP` or `POST /admin/config/reload`): routes/models/providers swap atomically; in-flight requests finish on the old snapshot.

## 5. Canonical types & request pipeline

All inbound formats are normalized into canonical types in `core/types.ts` (OpenAI chat schema is the canonical shape; provider adapters translate to/from it).

```ts
interface GatewayContext {
  requestId: string; startedAt: number; route: RouteConfig; team: Team; key: ApiKey;
  endUser?: string; tags: string[]; cacheMode: 'default'|'bypass'|'refresh';
  signal: AbortSignal; logger: Logger; attempts: AttemptRecord[];
}
interface ProviderAdapter {
  readonly type: string;
  chat(req: ChatRequest, target: ResolvedTarget, ctx: GatewayContext): Promise<ChatResponse>;
  chatStream(req: ChatRequest, target: ResolvedTarget, ctx: GatewayContext): AsyncIterable<ChatChunk>; // OpenAI chunk shape
  embed?(req: EmbeddingRequest, target: ResolvedTarget, ctx: GatewayContext): Promise<EmbeddingResponse>;
  rerank?(req: RerankRequest, target: ResolvedTarget, ctx: GatewayContext): Promise<RerankResponse>;
  health?(): Promise<ProviderHealth>;
}
// Adapters throw ProviderError { status, code, retryable, retryAfterMs?, provider, cause }.
```

**Pipeline for `/v1/chat/completions`** (each step is a small, unit-tested module):
1. `requestId` (honor `x-request-id`), logger child, metrics timer, OTel span.
2. **Auth**: Bearer key → `sha256` → Redis-cached key record (60 s TTL, pub/sub invalidation) → Postgres fallback. Reject revoked/expired. Admin routes use `admin_token`.
3. **Validate** body (zod; unknown fields passed through to OpenAI-family providers).
4. **Resolve route** (`model` = route name; also allow direct `models:` names if key scope permits). Enforce key scope (`allowed_routes`).
5. **Estimate** prompt tokens (`js-tiktoken` o200k; ±) and max completion (`max_tokens` or route default) → **pre-flight cost** (upper bound).
6. **Rate limit** (key + team; RPM & TPM; TPM reserves the estimate, reconciled after) → 429 + headers.
7. **Budget** check: `spent(period) + preflight_cost ≤ limit` else 402 `budget_exceeded` (soft threshold → alert once per period).
8. **Cache lookup** (exact; then semantic if enabled): hit → respond (stream replay if `stream`), mark `x-sy-cache: hit`, cost 0 (record `saved_usd`).
9. **Dispatch** via router: for each target (strategy order) → skip if breaker open → acquire provider concurrency slot → call with per-attempt timeout → on retryable error retry same target (`retry.attempts`, exp backoff + full jitter, honor `Retry-After` ≤ cap) then fall back to next target. Non-retryable (400/401/403/404/422) → return immediately. **Streaming**: fallback allowed only until the first chunk is flushed to the client; afterwards errors end the stream with an error chunk + `[DONE]`.
10. **Account**: actual usage → cost (pricing table; cached input tokens priced separately; reasoning tokens counted as output) → budget INCRBYFLOAT, TPM reconciliation → response headers → cache write (only successful, `finish_reason ∈ {stop, tool_calls, length}`, cacheable request) → emit **usage event** (`XADD sy:usage`) → metrics.

**Cacheability (exact)**: route cache enabled AND `x-sy-cache != bypass` AND (temperature unset/0 or provider ignores temperature) AND no `n>1`. Key = `sha256(canonicalJSON({route, messages, tools, tool_choice, response_format, max_tokens, stop, top_p, reasoning_effort, seed}))`, namespaced per team unless route sets `cache.shared: true`. Values stored gzip'd with metadata (provider, model, usage, created_at). Streaming replay synthesizes chunks (≈ 20-token chunks) with usage in the final chunk.

**Semantic cache** (opt-in per route; off for DocsQA because prompts embed retrieved context): embed the canonical "last user message + system hash" with the route's `semantic.embed_route`, `VSIM` against `sy:sem:{route}:{scope}` vector set (`VADD … SETATTR` stores response key + system hash), threshold `semantic.min_similarity` (default 0.95), only for requests without tools; mark `x-sy-cache: semantic-hit`.

## 6. Providers

### 6.1 `openai` (native)
Passthrough of chat/embeddings to `https://api.openai.com/v1` (configurable `base_url`), streaming passthrough with `stream_options.include_usage` forced on (and stripped from client output if the client didn't ask), map `usage.prompt_tokens_details.cached_tokens`.

### 6.2 `anthropic` (native Messages API)
Translate OpenAI ⇄ Anthropic: system messages → `system`; `tool` role → `tool_result` blocks; assistant `tool_calls` → `tool_use` blocks; images (data URLs/URLs) → image blocks; `tools[].function.parameters` → `input_schema`; `tool_choice` (`auto|none|required|{function}` → `auto|none|any|{type:tool,name}`); `max_tokens` required (default from route); `stop` → `stop_sequences`; `reasoning_effort` → `thinking`/effort per model capability; `response_format json_schema` → tool-forcing or prompt-based (configurable). Stop reasons → `finish_reason` (`end_turn|stop_sequence → stop`, `tool_use → tool_calls`, `max_tokens → length`). **Streaming**: Anthropic SSE (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`) → OpenAI chunks incl. incremental `tool_calls[i].function.arguments` (from `input_json_delta`) and a final usage chunk (input + cache read/write, output). Test with recorded fixtures + the mock provider's Anthropic mode.

### 6.3 `openai-compatible` (llama.cpp, vLLM, Ollama, Groq, …)
Chat (native tools if the server supports them, `--jinja` llama.cpp does), embeddings, and **rerank** (`POST {base_url}/rerank`, llama.cpp returns `results[{index, relevance_score}]`). Per-model `base_url` override (llama.cpp serves one model per port). Embedding `input_templates` applied from `input_type`. Usage: use server `usage` if present else estimate.

### 6.4 `opencode` (bridge to opencode serve → GitHub Copilot models) — **critical for local use**

Facts are in PLAN.md §1.1 (read them). Implementation requirements:
- **Stateless per request**: create session (`title: "switchyard"`, `agent`), send one message, read result, **always delete the session** (finally-block; also on abort/timeout after `POST /session/{id}/abort`). Basic auth header from config.
- **Transcript rendering**: caller `system`/`developer` messages → opencode `system` field (joined, plus protocol instructions below). If the conversation is a single user message → send its text as-is. Otherwise render the full history into one text part:
  ```
  <conversation>
  <message role="user">…</message>
  <message role="assistant">…
  <tool_call id="call_1">{"name":"get_order","arguments":{"order_id":"ORD-1"}}</tool_call></message>
  <message role="tool" tool_call_id="call_1" name="get_order">{…}</message>
  <message role="user">…</message>
  </conversation>
  Reply with the assistant's next message only.
  ```
  Images/file parts → opencode `file` parts (data URLs) if supported, else 400 `unsupported_content`.
- **Tool-calling emulation** (when `tools` present and `tool_choice != "none"`): append to `system` a `# Tools` section listing each tool as `{"name","description","parameters"}` JSON inside `<tools>…</tools>` and the protocol: *to call tools output one or more `<tool_call>{"name": …, "arguments": {…}}</tool_call>` blocks after an optional short sentence; nothing after the last block; never fabricate tool results*. `tool_choice: "required"` / `{function: X}` → explicit MUST rule. Parse with a tolerant scanner (handles code fences, trailing text), `JSON.parse`, validate `name` ∈ tools and `arguments` with **ajv** against the tool schema. On failure → **one repair round-trip** (append the invalid output + validator errors, ask to re-emit) → else return content as plain text (finish `stop`) and log `tool_emulation_failed`. Output: `message.tool_calls[{id: "call_<nanoid>", type:"function", function:{name, arguments: JSON string}}]`, `content` = text outside blocks or `null`, `finish_reason: "tool_calls"`.
- **JSON mode emulation**: `response_format.type = json_object` → instruct "single JSON object, no prose, no code fences"; `json_schema` → include the schema; strip fences, parse, ajv-validate (`strict` honored), one repair round-trip, else 502 `upstream_invalid_output`.
- **Reasoning**: `reasoning_effort` (`low|medium|high|xhigh|max`, `minimal`→ no variant) → opencode `variant`; route default applies. Reasoning text is *not* returned in `content` (optionally in `message.reasoning_content` when request sets `metadata.include_reasoning`).
- **Streaming**: preferred = subscribe to opencode `GET /event` (SSE, filter by `sessionID`; text deltas from message-part updates) and translate to OpenAI chunks; required fallback = await full response then emit synthetic chunks. With tools: stream text until a `<tool_call>` tag starts, buffer the rest, then emit `tool_calls` deltas. Investigate the event format against the live server (port 4096) and record it in `docs/opencode-bridge.md`.
- **Usage**: `prompt_tokens = input + cache.read + cache.write`, `completion_tokens = output + reasoning`, `completion_tokens_details.reasoning_tokens`, `prompt_tokens_details.cached_tokens = cache.read`. Cost from gateway pricing (shadow price — Copilot is subscription-billed).
- **Errors**: `info.error.data.statusCode` 429 → retryable `rate_limited` (+retry-after if present); 5xx/network → retryable; 400 → `invalid_request`; auth errors → 502 `upstream_auth` and open breaker. `max_concurrency` semaphore with queue timeout → retryable `upstream_busy`.
- Temperature/top_p are ignored for models that don't support them (log once at debug).

### 6.5 `mock` (deterministic; tests, CI offline tier, chaos demos)
Models/modes: `mock-echo` (echo last user message), `mock-fixed` (configured text), **`mock-extractive`** (RAG-aware: parses `<source id="n" …>…</source>` blocks from the prompt, picks the 1–2 sentences with highest lexical overlap with the question and answers with `[n]` citations; returns exactly `NO_ANSWER` when overlap < threshold — lets DocsQA's offline eval exercise citations/refusals deterministically), `mock-tools` (scripted tool calls from `metadata.mock_script` or a JSON file keyed by test id), embeddings (deterministic hashed bag-of-words vectors, configurable dim), rerank (lexical overlap scores). **Fault injection** via config or request headers (only when `mock.allow_header_faults: true`): `x-mock-latency-ms`, `x-mock-fail-rate`, `x-mock-status` (e.g. 429/500/503), `x-mock-retry-after`, `x-mock-stream-fail-after` (chunks). The standalone `packages/mock-provider` server exposes OpenAI-style and Anthropic-style endpoints with the same behaviors (used for adapter contract tests and docker/k8s demos).

## 7. Routing & resilience

- Strategies: `fallback` (ordered), `weighted` (`targets: [{model, weight}]`, smooth weighted round-robin), `least-latency` (EWMA of upstream latency per target, with exploration ε=0.05). All strategies skip targets whose breaker is open.
- **Circuit breaker** per target (state in Redis hash `sy:cb:{target}` so replicas agree; local cache 1 s): rolling window (default 30 s) failure rate ≥ 50% with ≥ 10 requests, or 5 consecutive failures → **open** for `cooldown_s` (default 30, exponential up to 5 min); then **half-open**: allow 1 probe; success closes. Metric `sy_circuit_state`.
- Retries: exponential backoff with full jitter; honor `Retry-After` (cap 20 s); budgets across attempts (`route.timeout_ms` total deadline).
- Hedging (optional, off by default): send a second request to the next target if the first hasn't produced a byte within `hedge_after_ms`.
- Every attempt recorded in `ctx.attempts` (target, status, latency, error code) → logged, traced, `x-sy-fallbacks` header.

## 8. Rate limiting (Lua, atomic)

Sliding-window counter (current + previous window weighted) for `rpm` and `tpm` at scopes `key` and `team`, in one `EVALSHA` per request (checks all four, increments only if all pass). TPM increments by the pre-flight estimate; after completion a reconciliation script adjusts by `(actual - estimate)`. Headers `x-ratelimit-*` reflect the tightest scope. Limits come from key record (overrides) → team record → config defaults. Unit tests with real Redis (db 1) including concurrency (100 parallel calls never exceed the limit).

## 9. Budgets

Per team: `daily` and/or `monthly` (UTC) limits in USD, `soft_threshold` (0–1), `action: block|alert`. Spend counter `sy:budget:{team}:{period}:{YYYYMMDD|YYYYMM}` (INCRBYFLOAT, TTL to period end + 1 day), reconciled every 5 min from Postgres rollups (authoritative). Pre-flight: reject if `spent + preflight_cost > limit` (hard). Soft threshold crossing → structured log + metric + optional webhook (once per period, deduped with `SET NX`). `GET /admin/teams/:id/budget` shows spend, limit, utilization, projected end-of-period spend (linear).

## 10. Usage & cost pipeline

- Pricing: `config/pricing.json` (USD per 1M tokens: input, cached_input, output; per-request fee optional; rerank priced per 1K searches or tokens) overridable per model in YAML.
- Request path emits `XADD sy:usage MAXLEN ~ 1e6 * {json}` (non-blocking; if Redis is down, buffer in memory up to N events then drop with a metric).
- **Worker** (`switchyard worker`, separate Deployment in k8s; can also run in-process via `usage.in_process_writer: true` for single-node dev): consumer group `writers`, `XREADGROUP` batches (≤500 / 1 s), bulk insert into `usage_events` (monthly **range partitions**, created ahead by the worker), upsert `usage_daily`, `XACK`; pending-entry reclaim (`XAUTOCLAIM`) for crashed consumers; idempotent on `request_id` (unique per partition key).
- Event fields: `ts, request_id, team_id, key_id, route, provider, model, status, error_code, cache, stream, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, cost_usd, saved_usd (cache hits), latency_ms, ttft_ms, attempts, fallbacks, end_user, tags[]`.

## 11. Data model (Postgres `llmgateway`, drizzle migrations)

`teams(id uuid pk, slug unique, name, metadata jsonb, created_at)` ·
`api_keys(id uuid pk, team_id fk, name, key_prefix (first 12 chars, e.g. "sk-sy-ab12cd"), key_hash char(64) unique, allowed_routes text[] null=all, rpm_limit int null, tpm_limit int null, expires_at, revoked_at, last_used_at, created_at)` ·
`budgets(id, team_id fk, period enum(daily,monthly), limit_usd numeric(14,6), soft_threshold numeric(4,3), action enum(block,alert), webhook_url, unique(team_id, period))` ·
`usage_events(... see §10, pk(ts, request_id)) PARTITION BY RANGE (ts)` ·
`usage_daily(day date, team_id, route, provider, model, requests, errors, cache_hits, prompt_tokens, cached_tokens, completion_tokens, cost_usd, saved_usd, latency_ms_sum, pk(day, team_id, route, provider, model))` ·
`audit_log(id, at, actor, action, target, data jsonb)`.
Keys: generated as `sk-sy-` + 40 base62 chars; only the hash is stored; plaintext returned once.

## 12. Admin API (Bearer `admin_token`)

`POST/GET /admin/teams`, `GET/PATCH/DELETE /admin/teams/:id` · `POST /admin/teams/:id/keys` (returns plaintext once) · `GET /admin/teams/:id/keys` (masked) · `POST /admin/keys/:id/revoke` · `POST /admin/keys/:id/rotate` · `PUT /admin/teams/:id/budgets` · `GET /admin/teams/:id/budget` · `GET /admin/usage?team=&route=&model=&from=&to=&group_by=day|team|route|model|key` · `GET /admin/providers/health` (breakers, EWMA latency, error rates, concurrency) · `POST /admin/cache/purge {route?}` · `GET /admin/config` (secrets redacted) · `POST /admin/config/reload`. All mutations audit-logged. CLI wraps these (`switchyard teams create docsqa --monthly-budget 25`, `switchyard keys create --team docsqa --name local`).

## 13. Observability

Metrics (prefix `sy_`): `requests_total{route,provider,model,status,cache}`, `request_duration_seconds{route,status}` (histogram), `upstream_duration_seconds{provider,model}`, `ttft_seconds{route}`, `tokens_total{team,route,model,type}`, `cost_usd_total{team,route,provider,model}`, `cache_saved_usd_total{team,route}`, `cache_requests_total{route,kind,result}`, `ratelimit_rejections_total{scope,limit}`, `budget_rejections_total{team}`, `budget_utilization_ratio{team,period}` (gauge), `fallbacks_total{route,from,to,reason}`, `retries_total{target,reason}`, `circuit_state{target}` (0 closed/1 half-open/2 open), `inflight_requests{provider}`, `provider_queue_wait_seconds{provider}`, `usage_stream_lag` + Node defaults. Logs: pino JSON with `requestId, team, route, provider, model, status, latency_ms, cost_usd, cache` (no prompt bodies unless `log_bodies: true`, which redacts keys). Tracing: OTel spans per request and per attempt (`gen_ai.*` semantic conventions).

Grafana dashboards (JSON in `observability/grafana/dashboards`): **Overview** (RPS, p50/p95/p99, error rate, cache hit ratio, tokens/s), **Cost & Budgets** (spend by team/route/model over time, budget utilization gauges, projected spend, top keys, cache savings — Prometheus + Postgres datasources), **Providers & Reliability** (upstream latency, breaker states, fallbacks, retries, 429s, queue wait).

## 14. Deployment

- **Docker**: multi-stage (pnpm fetch/build → prod deps → distroless `nodejs24` or `node:24-slim` non-root), `switchyard serve` default cmd, same image runs `worker`/`migrate`.
- **docker-compose**: gateway, worker, redis:8, postgres:18, prometheus, grafana (provisioned datasources + dashboards), mock-provider. Linux note: to reach host services (opencode :4096, llama.cpp) use `network_mode: host` for gateway or bind host services to the docker bridge IP.
- **Helm chart** `deploy/helm/switchyard`: Deployments (api, worker), Service, optional Ingress, ConfigMap (gateway.yaml), Secret refs, HPA (CPU + optional custom metric), PDB, ServiceMonitor (if CRD present), pre-install/upgrade **migration Job** hook, probes (`/healthz` liveness, `/readyz` readiness = Redis+PG reachable), securityContext (non-root, read-only rootfs), resources.
- **Terraform**: `modules/switchyard` (namespace, secrets, `helm_release` of the local chart), `modules/redis` & `modules/postgres` (StatefulSets with PVCs using official images), `modules/observability` (kube-prometheus-stack helm_release tuned for small clusters + dashboards as ConfigMaps with `grafana_dashboard: "1"` label), `envs/local-kind` (kind cluster via `tehcyx/kind` provider, image build+`kind load` via `terraform_data` local-exec, NodePort/port mappings for gateway 30787 and Grafana 30300, in-cluster mock provider as upstream by default; optional host bridge to opencode/llama.cpp), `envs/aws-eks-example` (validated with `terraform validate` only; clearly marked example). `make k8s-up` / `make k8s-down`.

## 15. Testing strategy

- **Unit** (vitest): config parsing/interpolation, canonical translation (OpenAI⇄Anthropic incl. streaming fixtures), opencode transcript rendering + tool-call/JSON parsing & repair, cost calc, cache key canonicalization, breaker state machine, retry/backoff, rate-limit Lua (real Redis db 1), budget math.
- **Integration**: spin the gateway in-process against the mock provider (+ real Redis/PG test DB `llmgateway_test`): fallback on 503/timeout, breaker opening, streaming fallback-before-first-byte, 429 propagation with headers, budget 402, cache hit/replay, usage events land in PG via the worker.
- **Contract**: official `openai` npm SDK (chat, stream, tools, embeddings) and `@anthropic-ai/sdk`-shaped fixtures against the gateway; Python `openai` SDK smoke script.
- **Live smoke** (manual/opt-in `pnpm test:live`): opencode bridge — plain chat, stream, JSON schema, tool call round-trip (≤ 6 real calls).
- **Load** (`bench/`): k6 or autocannon vs mock provider (0 ms upstream) → report gateway overhead p50/p99 and max RPS on this laptop in `bench/RESULTS.md`. Target: < 3 ms p50 overhead on cache-miss path (excluding upstream), < 1 ms on cache hit.

## 16. Packaging & release

`packages/gateway` → npm `switchyard-gateway`: ESM + types, `bin: { switchyard }`, `exports` (`.`, `./mock-provider`), `files` whitelist, `engines.node >= 22`, provenance. Changesets for versioning; `release.yml` publishes on merge to main when a changeset is pending (needs `NPM_TOKEN` secret — documented); `docker.yml` builds multi-arch image to `ghcr.io/riz1-k/switchyard` with `GITHUB_TOKEN`. `npm pack --dry-run` verified locally.

## 17. Integration with DocsQA & OpsAgent (wave 4)

Teams `docsqa` (monthly budget $50 shadow), `opsagent` ($50), `evals` ($100); keys in each project's `.env`; Grafana "Cost & Budgets" shows per-team spend from real traffic. Both projects call only route names from §4.
