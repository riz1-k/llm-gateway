# Switchyard

**An OpenAI-compatible LLM gateway that makes any backend behave like OpenAI, including ones that
can't do tool calling or JSON mode natively.**

Switchyard sits between your apps and your model providers. Apps talk plain OpenAI (official SDKs,
LangChain `ChatOpenAI`, curl) to _virtual models_ such as `docsqa-chat`. Switchyard routes each
call across providers with ordered fallback, retries, timeouts and circuit breakers, and prices
every request. With Redis and Postgres it adds a platform layer: teams and virtual keys, RPM/TPM
limits, USD budgets, exact and semantic caching, persisted usage, an admin API and Prometheus
metrics. It speaks to:

- OpenAI and Anthropic (native Messages API translation, including streaming tool use)
- OpenAI-compatible servers (llama.cpp, vLLM, Ollama, Groq, …), including embeddings and
  Cohere/Jina-style **rerank**
- an **opencode bridge** to GitHub Copilot models, where it emulates tool calling and structured
  output that the bridge doesn't support
- a deterministic **mock provider** for tests, CI and chaos demos

```
TypeScript (strict, ESM) · Hono · zod v4 · ajv · pino · ioredis (Redis 8) · drizzle-orm (Postgres) · prom-client · vitest — Node ≥ 22
```

## Features

|                          |                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drop-in OpenAI API**   | `POST /v1/chat/completions` (incl. SSE streaming, `stream_options.include_usage`, tools, `response_format`), `POST /v1/embeddings` (+ `input_type` templates), `POST /v1/rerank`, `GET /v1/models`. OpenAI error envelope. Verified with the official `openai` npm and Python SDKs.                                                                           |
| **Virtual models**       | Routes map a public name to ordered targets with `fallback`, `weighted` (smooth WRR) or `least-latency` (EWMA + ε-exploration) strategies. Per-key route allow-lists.                                                                                                                                                                                         |
| **Resilience**           | Retries with exponential backoff + full jitter honoring `Retry-After` (capped). Per-attempt timeout plus total route deadline. Circuit breakers per target (rolling window, consecutive-failure trip, exponential cooldown, half-open probe). Per-provider concurrency semaphores with queue timeout. **Streaming fallback until the first byte is flushed.** |
| **Emulation layer**      | For backends without native support: tool calling via `<tool_call>` blocks with a tolerant parser, ajv schema validation and one repair round-trip; JSON mode (`json_object` / `json_schema`, strict) with validation and repair; multi-turn transcript rendering; reasoning-effort mapping.                                                                  |
| **Cost attribution**     | Every response carries `x-sy-cost-usd` computed from usage × pricing table (cached / cache-write / reasoning tokens handled). Usage events per request (team, key, route, provider, tokens, cost, latency, TTFT, attempts, fallbacks, tags).                                                                                                                  |
| **Ops**                  | Request-ID propagation, structured pino logs (never prompt bodies by default), `/healthz`, `/readyz` (+ provider probes), graceful shutdown with drain, hot config reload (SIGHUP / admin API) with atomic snapshot swap.                                                                                                                                     |
| **Teams & virtual keys** | Postgres-backed teams and `sk-sy-…` keys (SHA-256 at rest, plaintext shown once), with per-key route allow-lists, RPM/TPM overrides and expiry. Keys are cached in Redis and invalidated over pub/sub on every replica. Rotation supports a grace period, and every admin mutation is audit-logged.                                                           |
| **Rate limits**          | Sliding-window RPM and TPM at key and team scope, checked in one atomic Lua call. TPM reserves the pre-flight estimate and is reconciled to actual usage. Returns OpenAI-style `x-ratelimit-*` headers plus `retry-after`.                                                                                                                                    |
| **Budgets**              | Daily and monthly USD budgets per team. A pre-flight upper-bound check returns 402 `budget_exceeded`. Soft-threshold alerts fire once per period and can call a webhook. Spend is reconciled from Postgres, and the admin view shows utilization with a linear projection.                                                                                    |
| **Caching**              | Exact response cache (canonical request hash, per-team namespace, gzip) for chat, embeddings (per input item) and rerank. Semantic cache on Redis 8 vector sets. Streaming replay of hits; `x-sy-cache: default\|bypass\|refresh`; savings reported in `x-sy-saved-usd`.                                                                                      |
| **Usage & reporting**    | Usage events go to a Redis stream. `switchyard worker` writes them to monthly-partitioned Postgres tables plus daily rollups using consumer groups, idempotent inserts and XAUTOCLAIM. Reports are available from the CLI and the admin API.                                                                                                                  |
| **Observability**        | Prometheus `/metrics` (SPEC §13 names, see [docs/METRICS.md](docs/METRICS.md)), circuit breakers shared across replicas through Redis, and `/readyz` checks of Redis and Postgres.                                                                                                                                                                            |

## Quickstart

```bash
pnpm install
pnpm build

# 1) A fully offline gateway against the built-in mock provider
cat > /tmp/sy.yaml <<'EOF'
auth: { static_keys: [{ key: sk-sy-local-demo-key, team: demo }] }
providers: { mock: { type: mock } }
models:   { rag: { provider: mock, model: mock-extractive } }
routes:   { chat: { targets: [rag] } }
EOF
node packages/gateway/dist/cli.js serve --config /tmp/sy.yaml --port 8787

curl -s localhost:8787/v1/chat/completions \
  -H 'Authorization: Bearer sk-sy-local-demo-key' -H 'content-type: application/json' \
  -d '{"model":"chat","messages":[{"role":"user","content":"<source id=\"1\">Hono is a small web framework.</source> What is Hono?"}]}'
# → "Hono is a small web framework. [1]"   (+ x-sy-route / x-sy-provider / x-sy-cost-usd headers)
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="sk-sy-local-demo-key")
print(client.chat.completions.create(model="chat", messages=[{"role": "user", "content": "hi"}]).choices[0].message.content)
```

**Local dev stack** (opencode bridge on :4096, llama.cpp on :8081–8083): `make dev` runs
`scripts/dev.sh`, which sources `../devenv/.env` and serves `config/gateway.local.yaml` on :8787.
Then run `uv run --with openai python scripts/smoke_openai_sdk.py` for an end-to-end check with
the Python SDK.

CLI:

```
switchyard serve --config <file> [--port <n>] [--host <addr>]
switchyard migrate --config <file>            # Postgres schema (idempotent)
switchyard worker --config <file> [--port n]  # usage stream → Postgres (+ /metrics)
switchyard validate-config <file>
switchyard mock-provider [--port 8790] [--latency-ms n] [--fail-rate p] [--fail-status code]
switchyard teams|keys|budgets|usage|cache|seed-dev …   # admin, see below
```

### Admin quickstart (Redis + Postgres)

Add `redis.url` and `database.url` to the config. Every option is documented in
[`config/gateway.example.yaml`](config/gateway.example.yaml); the full guide is
[docs/ADMIN.md](docs/ADMIN.md).

```bash
export SWITCHYARD_ADMIN_TOKEN=$(openssl rand -hex 24)
switchyard migrate --config gateway.yaml
switchyard serve   --config gateway.yaml &      # or set usage.in_process_writer: true and skip the worker
switchyard worker  --config gateway.yaml &

# Local mode (--config) talks to Postgres directly; remote mode uses the admin API:
export SWITCHYARD_URL=http://localhost:8787
switchyard teams create docsqa --name DocsQA --monthly-budget 50
switchyard keys create --team docsqa --name local --routes docsqa-chat,docsqa-embed
#   ✔ key sk-sy-…   (shown once)
switchyard budgets show --team docsqa
switchyard usage --team docsqa --group-by route
switchyard seed-dev --output .env.gateway-keys   # dev: teams docsqa/opsagent/evals with budgets + keys
```

The same operations are available over HTTP under `/admin/*` with
`Authorization: Bearer $SWITCHYARD_ADMIN_TOKEN`. For example,
`POST /admin/teams/:id/keys` and `GET /admin/teams/:id/budget`.

Library:

```ts
import { createGateway, loadConfig } from 'switchyard-gateway';
const gateway = createGateway({ config: loadConfig('gateway.yaml') });
export default gateway.app; // a Hono app: mount it anywhere
```

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    A[DocsQA<br/>openai SDK] --- B[OpsAgent<br/>LangChain]
  end
  A & B -->|"OpenAI API + Bearer sk-sy-…"| H

  subgraph Switchyard
    H[Hono HTTP<br/>request-id · auth · validation] --> P
    subgraph P[Pipeline]
      direction LR
      R[resolve route] --> E[estimate] --> RL[RateLimiter] --> BG[BudgetGuard] --> C[CacheStore]
      C --> D[Router] --> ACC[account<br/>cost · usage · cache write]
    end
    D --> S{strategy<br/>fallback / weighted / least-latency}
    S --> CB[BreakerStore] --> SEM[semaphore] --> T[attempt w/ timeout<br/>retry + backoff]
  end

  T --> OC[opencode adapter<br/>transcript · tool & JSON emulation · /event streaming]
  T --> OA[openai / openai-compatible]
  T --> AN[anthropic<br/>Messages ⇄ OpenAI]
  T --> MK[mock<br/>deterministic + faults]
  OC --> COP[(opencode serve<br/>→ GitHub Copilot)]
  OA --> LL[(llama.cpp · vLLM · OpenAI)]
  AN --> ANT[(Anthropic API)]
```

The request path, in order: `requestId → auth (KeyStore) → validate (zod) → resolve route
(scope check) → route defaults → estimate tokens/cost → RateLimiter.check → BudgetGuard.check →
CacheStore.get → Router.dispatch → account (cost → reconcile → budget record → cache write →
UsageSink.emit) → headers`.

The router walks targets in strategy order:

1. Skip disabled targets and targets whose breaker is open.
2. Acquire a provider concurrency slot.
3. Call the adapter with a scoped timeout signal.
4. Retry retryable errors (429/5xx/timeout/network) on the same target with backoff, then fall
   back to the next target.

Client errors (upstream 400/422) are returned immediately. A streaming attempt is committed only
when its first meaningful chunk arrives, so failures before any text still fall back.

## Configuration

YAML, validated by zod, with `${ENV}` / `${ENV:-default}` interpolation applied to parsed values
(never raw text). Errors are reported with paths, e.g.
`routes.chat.targets[1]: unknown model "missing"`. See the documented
[`config/gateway.example.yaml`](config/gateway.example.yaml) and the machine-specific
[`config/gateway.local.yaml`](config/gateway.local.yaml).

| Section                      | Purpose                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`                     | port, host, default route deadline, body limit, shutdown grace                                                                                                                                    |
| `auth`                       | `admin_token`, `static_keys[{key, team, name, allowed_routes?, allow_direct_models?, rpm?, tpm?}]`                                                                                                |
| `providers.<name>`           | `type: opencode \| openai-compatible \| openai \| anthropic \| mock` + `base_url`, credentials, `max_concurrency`, `queue_timeout_ms`, `timeout_ms`, `headers`, `enabled_if_key`                  |
| `models.<name>`              | concrete target: `provider`, upstream `model`, `kind: chat\|embedding\|rerank`, per-model `base_url`, `input_templates`, `pricing`, `timeout_ms`, default `params`                                |
| `routes.<name>`              | public virtual model: `targets`, `strategy`, `retry{attempts,backoff_ms,max_backoff_ms,max_retry_after_ms}`, `timeout_ms`, `cache`, `defaults{reasoning_effort,max_tokens,temperature}`, `hidden` |
| `retry`, `breaker`           | global defaults                                                                                                                                                                                   |
| `pricing_file`               | USD per 1M tokens table (`config/pricing.json`); per-model `pricing` overrides                                                                                                                    |
| `redis`, `database`          | enable the platform layer (see [docs/ADMIN.md](docs/ADMIN.md)); `redis.fail_open` controls behaviour when Redis is down                                                                           |
| `limits`, `budgets`, `usage` | rate-limit defaults and window, budget enforcement, alerts and reconciliation, usage stream and worker settings                                                                                   |
| `metrics`, `observability`   | `/metrics` path or separate port, log level, body logging                                                                                                                                         |

### Request & response headers

| Request                                          | Meaning                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `Authorization: Bearer sk-sy-…` (or `x-api-key`) | virtual key bound to a team                                       |
| `x-request-id`                                   | propagated (generated if absent/unsafe)                           |
| `x-sy-user`, `x-sy-tags`                         | end-user attribution, comma-separated tags (land in usage events) |
| `x-sy-cache: default \| bypass \| refresh`       | cache control                                                     |

| Response                                                    | Meaning                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `x-request-id`, `x-sy-route`, `x-sy-provider`, `x-sy-model` | where the request went (`x-sy-model` = upstream model)           |
| `x-sy-cache`                                                | `miss` / `bypass` / `hit` / `semantic-hit`                       |
| `x-sy-cost-usd`                                             | priced from usage (non-streaming responses and cache hits)       |
| `x-sy-saved-usd`, `x-sy-semantic-similarity`                | on cache hits: original cost saved; cosine similarity (semantic) |
| `x-sy-cache-items`                                          | embeddings: `<cached>/<total>` input items served from cache     |
| `x-sy-fallbacks`, `x-sy-latency-ms`                         | number of targets skipped/failed before success; gateway latency |
| `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`     | tightest rate-limit scope (key or team)                          |
| `retry-after`, `retry-after-ms`                             | on 429 (gateway limits) and upstream-unavailable 503s            |

Error codes (OpenAI envelope `{"error":{"message","type","code","param"}}`):

| Status | Codes                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`, `unsupported_content`                                                                   |
| 401    | `invalid_api_key`                                                                                          |
| 402    | `budget_exceeded`                                                                                          |
| 403    | `model_not_allowed`                                                                                        |
| 404    | `model_not_found`                                                                                          |
| 409    | `conflict` (admin API)                                                                                     |
| 429    | `rate_limit_exceeded`                                                                                      |
| 502    | `upstream_error`, `upstream_invalid_output`                                                                |
| 503    | `upstream_unavailable` (+ `retry-after`), `service_unavailable` (Redis/Postgres down in fail-closed paths) |
| 504    | `upstream_timeout`                                                                                         |

### Embedding templates

Some embedding models need task prefixes (embeddinggemma: `task: search result | query: …`).
Clients send the extension field `input_type: "query" | "document"` (and optionally
`input_titles: string[]`), and the gateway applies the target model's `input_templates`:

```yaml
input_templates:
  query: 'task: search result | query: {text}'
  document: 'title: {title} | text: {text}' # {title} ← input_titles[i] or "none"
```

## Testing

```bash
pnpm test        # 343 tests: unit + integration (in-process gateway ⇄ mock provider over HTTP) + openai SDK contract
                 #   + platform integration against real Redis (db 1) and Postgres (llmgateway_test)
pnpm lint        # eslint (type-aware) + prettier
pnpm typecheck
pnpm test:live   # opt-in: 5 real calls through the opencode bridge (SWITCHYARD_LIVE=1)
```

The platform tests need Redis 8 on `redis://127.0.0.1:6379/1` and the Postgres database
`llmgateway_test` (`postgres://dev:dev@127.0.0.1:5432/llmgateway_test`). Override them with
`SWITCHYARD_TEST_REDIS_URL` and `SWITCHYARD_TEST_DATABASE_URL`. db 0 is refused. Each test file
uses its own Redis key prefix and Postgres schema and removes them afterwards; tests never run
FLUSHDB.

Highlights:

- Fallback on 503 and on timeout; 429 retried with Retry-After; 400 never retried.
- Breaker opens and recovers through a half-open probe; total deadline returns 504.
- Streaming falls back before the first byte; after it, the stream ends with an error event and
  `[DONE]`.
- Embedding templates verified upstream; rerank normalization.
- Anthropic chat, streaming and `tool_use` translation against recorded SSE fixtures and the mock
  server.
- The opencode adapter is tested against an in-memory fake that reproduces the real `/event`
  stream.
- Rate limits: 100 concurrent calls never exceed the limit, and neither do many keys sharing one
  team limit. Checks are all-or-nothing across scopes. TPM reservation and reconciliation, and
  the sliding-window math, are tested with an injected clock.
- Budgets: 402 at the limit, a soft alert fires exactly once across replicas, reconciliation never
  lowers counters while events are in flight.
- Usage: request → stream → worker → Postgres, idempotent redelivery, XAUTOCLAIM after a consumer
  crash, dead-lettering, partitions and retention.
- Keys: revocation reaches a second replica through pub/sub; the gateway returns 503 (not 401)
  when Postgres is down; static keys keep working.

## Docs

- [docs/opencode-bridge.md](docs/opencode-bridge.md): how the Copilot bridge works, including the
  emulation protocols and the live `/event` findings
- [docs/ADMIN.md](docs/ADMIN.md): platform setup, admin API, CLI, limits, budgets, cache, usage
  pipeline, Redis key layout, failure modes
- [docs/METRICS.md](docs/METRICS.md): Prometheus metric reference, PromQL and Postgres queries
  for dashboards
- [docs/STATUS.md](docs/STATUS.md): what exists, test results, deviations, roadmap notes
- [docs/SPEC.md](docs/SPEC.md): the full specification

## License

MIT
