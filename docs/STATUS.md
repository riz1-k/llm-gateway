# Switchyard status

_Last updated: 2026-10-27, after the core build (wave G)._

## What exists

The core gateway is built. Platform subsystems (Redis/Postgres-backed keys, limits, budgets,
cache, usage, breakers) are in-memory or no-op implementations behind their final interfaces.

| Area          | State                                                                                                                                                                                                                                                                                            | Where                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Monorepo      | pnpm 11 workspace, TS 6 strict ESM, eslint flat (type-aware) + prettier, vitest 5, tsdown                                                                                                                                                                                                        | root                                    |
| Config        | YAML + `${ENV}` / `${ENV:-default}` interpolation, zod schema, cross-reference checks with paths, pricing file, SIGHUP / `POST /admin/config/reload` hot reload (ref-counted snapshots)                                                                                                          | `packages/gateway/src/config/`          |
| HTTP API      | `/v1/chat/completions` (JSON + SSE, `include_usage`), `/v1/embeddings` (+ `input_type` templates), `/v1/rerank`, `/v1/models`, `/healthz`, `/readyz` (`?probe=1`), `/admin/providers/health`, OpenAI error envelope, `x-sy-*` headers, request id, pino logs, body limit, graceful drain         | `src/app.ts`, `src/server.ts`           |
| Pipeline      | auth → validate → route → defaults → estimate → RateLimiter → BudgetGuard → CacheStore → Router → account → UsageSink                                                                                                                                                                            | `src/core/pipeline.ts`                  |
| Router        | fallback / weighted (smooth WRR) / least-latency (EWMA, ε-explore); retries with full jitter + Retry-After cap; per-attempt + route deadline; circuit breaker (pure `decide`/`record` + `MemoryBreakerStore`); per-provider FIFO semaphores; streaming fallback until the first meaningful chunk | `src/core/router.ts`, `src/resilience/` |
| Providers     | `opencode` (full emulation + real `/event` streaming), `openai-compatible` (chat, embeddings, rerank), `openai`, `anthropic` (Messages translation incl. streaming tool use), `mock` (in-process)                                                                                                | `src/providers/`                        |
| Mock provider | standalone deterministic OpenAI-compatible server with header/flag fault injection; bundled into the gateway package as `switchyard-gateway/mock-provider`                                                                                                                                       | `packages/mock-provider/`               |
| CLI           | `serve`, `validate-config`, `mock-provider`                                                                                                                                                                                                                                                      | `src/cli.ts`                            |
| Dev tooling   | `Makefile`, `scripts/dev.sh`, `scripts/smoke_openai_sdk.py`, `.env.example`                                                                                                                                                                                                                      | root                                    |
| Docs          | `README.md`, `docs/opencode-bridge.md`, this file                                                                                                                                                                                                                                                |                                         |

## How to run

```bash
pnpm install && pnpm build
make dev                      # = scripts/dev.sh → serves config/gateway.local.yaml on :8787 (PORT overrides)
# or: node packages/gateway/dist/cli.js serve --config config/gateway.local.yaml
node packages/gateway/dist/cli.js validate-config config/gateway.local.yaml
node packages/gateway/dist/cli.js mock-provider --port 8790
```

`scripts/dev.sh` sources `../devenv/.env` (for `OPENCODE_SERVER_PASSWORD`) and an optional local
`.env`. It runs `dist/cli.js` and falls back to the TypeScript source via `tsx` when there is no
build or when `SWITCHYARD_DEV_SOURCE=1` is set.

- **Base URL:** `http://localhost:8787/v1`
- **Dev keys** (each overridable by env, see `.env.example`):

| Key                  | Team     | Allowed routes                                                     |
| -------------------- | -------- | ------------------------------------------------------------------ |
| `sk-sy-dev-docsqa`   | docsqa   | `docsqa-*`, `mock-chat`, `mock-embed`, `mock-rerank`, `mock-tools` |
| `sk-sy-dev-opsagent` | opsagent | `opsagent-chat`, `opsagent-judge`, `mock-*`                        |
| `sk-sy-dev-evals`    | evals    | all routes                                                         |
| admin token          |          | `sk-sy-dev-admin` (`SWITCHYARD_ADMIN_TOKEN`)                       |

- **Routes** in `config/gateway.local.yaml`:

| Route                                                     | Kind                             | Targets (fallback order)                                                |
| --------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `docsqa-chat`                                             | chat                             | copilot-sonnet → local-qwen                                             |
| `docsqa-fast`                                             | chat                             | copilot-haiku → copilot-sonnet                                          |
| `docsqa-judge`                                            | chat                             | copilot-sonnet (`reasoning_effort: medium`)                             |
| `docsqa-embed`                                            | embedding                        | local-embeddinggemma (:8082, 768-d, query/document templates)           |
| `docsqa-rerank`                                           | rerank                           | local-jina-rerank (:8083)                                               |
| `opsagent-chat`                                           | chat                             | copilot-sonnet → copilot-gpt → local-qwen                               |
| `opsagent-judge`                                          | chat                             | copilot-sonnet (`reasoning_effort: medium`)                             |
| `mock-chat` / `mock-embed` / `mock-rerank` / `mock-tools` | chat / embedding / rerank / chat | mock-extractive / mock-embedder (256-d) / mock-reranker / mock-scripted |
| `demo-fallback` (hidden)                                  | chat                             | mock-down (always 503) → local-qwen                                     |

- **Requirements:**
  - `local-qwen` needs llama-chat on :8081, which is not always running. Start it with
    `../devenv/bin/models-up.sh chat` and stop it with `models-down.sh llama-chat`.
  - The Copilot routes need opencode on :4096 with `OPENCODE_SERVER_PASSWORD`.
  - The native `openai` / `anthropic` providers are enabled only when their API key env var is set.

## Test results

Run on 2026-10-27:

- **Gateway:** `pnpm test` passes 231 tests in 12 files:
  - unit: config, resilience, core, opencode emulation, and the opencode / openai-compatible /
    anthropic translate + stream / mock providers
  - integration: routing (26) and upstream HTTP (12) against the real mock-provider server
  - contract: the official `openai` SDK
- **Mock provider:** 42 tests.
- **Total: 273 passing.** `pnpm typecheck`, eslint and `prettier --check` are clean.
- **Packaging:** `npm pack --dry-run` of `switchyard-gateway` gives 12 files, 202 kB
  (`dist/*.js` + `.d.ts`, with the mock provider bundled).
- **Live suite:** `pnpm test:live` (opt-in, `SWITCHYARD_LIVE=1`) passed 4/4 tests using 5 real
  Copilot calls (plain, stream, json_schema, tool call + follow-up).

Live verification against the running gateway (curl + the Python `openai` SDK via
`scripts/smoke_openai_sdk.py`):

| Check                                | Result                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docsqa-chat` (curl)                 | 200 in 1.48 s, cited answer with [1][2]. Headers: `x-sy-provider: copilot`, `x-sy-model: claude-sonnet-5.5`, `x-sy-cost-usd: 0.00148`, `x-sy-fallbacks: 0`. Usage 320/84 |
| `docsqa-chat` stream (Python SDK)    | "Spring\nSummer\nAutumn\nWinter", TTFT ≈ 0.9 s, usage chunk present                                                                                                      |
| `opsagent-chat` tool round trip      | `finish_reason: tool_calls`, `get_order {"order_id":"ORD-2001"}`. After the tool result: "Yes, order ORD-2001 has shipped. It went out with UPS on October 25, 2026…"    |
| `docsqa-embed` (`input_type: query`) | 768-d. Identical to llama.cpp called directly with the template; differs from the untemplated input                                                                      |
| `docsqa-rerank`                      | the relevant document ranks first (0.0762 > 0.0193 > 0.0049)                                                                                                             |
| `demo-fallback`                      | `x-sy-provider: local`, `x-sy-model: qwen3.5-2b`, `x-sy-fallbacks: 1`                                                                                                    |
| `/readyz?probe=1`, SIGHUP            | all providers ok; "config reloaded" logged                                                                                                                               |

Total real Copilot calls during the build: 10.

## Known gaps

- **Platform subsystems are not implemented yet:** Redis rate limits (RPM/TPM, concurrency),
  budgets, response cache, Redis breaker store, Postgres keys/teams/usage, and the usage worker.
  The no-op implementations always admit, `x-sy-cache` reports `bypass`/`miss`, and usage goes to
  logs (`LogUsageSink`).
- **No `/metrics`** (Prometheus) and no OpenTelemetry yet.
- **Admin API is minimal:** only `POST /admin/config/reload` and `GET /admin/providers/health`.
  There is no keys/teams/usage CRUD, and the `worker`, `migrate`, `keys` and `teams` CLI commands
  are absent.
- **No Dockerfile, compose service or CI workflow.**
- **No changesets and no package-level README** for npm publishing.
- **Copilot streaming is bursty:** short answers often arrive as a single delta. This is
  upstream behavior, not buffering.
- **Native `openai` / `anthropic` adapters** are tested against fixtures and the mock server
  only, never against the real APIs (no keys on this machine).

## Deviations from SPEC / PLAN

1. **`retry.attempts`** is the total number of attempts per target, including the first. It is
   not the number of retries.
2. **Upstream 401/403** map to `upstream_auth` (502). This error is fallback-eligible and counts
   toward the breaker, so one misconfigured provider does not take a route down; the request is
   not returned immediately.
3. **The response `model` field** is the route name the client asked for. The upstream model is in
   `x-sy-model`.
4. **`x-sy-cost-usd` is absent on streaming responses**, because headers are sent before usage is
   known. Cost is still logged and emitted in the usage event at stream end.
5. **Extra error codes:** `unsupported_content` (400), `upstream_invalid_output` (502),
   `request_aborted` (499, client disconnect, logged only), `not_found` (404 for unknown paths)
   and `internal_error` (500).
6. **New `input_titles: string[]` extension** on `/v1/embeddings`, plus a `{title}` template
   placeholder (default `"none"`), as needed by embeddinggemma's document template. Both
   `input_type` and `input_titles` are stripped before the request goes upstream.
7. **Additional routes:** `mock-tools` (scripted tool calls) and the hidden `demo-fallback`
   (mock-down → local-qwen) for demonstrating fallback.
8. **The rerank upstream model alias** is `jina-reranker-v1-tiny-en.f16`, the name llama.cpp
   reports.
9. **`x-api-key` is accepted** as an alternative to `Authorization: Bearer`, for Anthropic-style
   clients.
10. **opencode parameter handling:** `max_tokens`, `seed`, `temperature` and `top_p` are dropped
    because the bridge does not support them; this is logged at debug level. `stop` is emulated
    by truncation, and `n > 1` returns 400.
11. **Synthetic streaming** (await the full reply, then emit ~48-char chunks) is used on opencode
    for JSON mode and `stop` sequences, since output must be validated or truncated before
    sending. Plain chat and tool streaming use the real `/event` deltas.
12. **The default `UsageSink` is `LogUsageSink`**, which writes one "request completed" log line
    per request.
13. **TypeScript 6.0.3** is used instead of 7.x, because typescript-eslint 8.72 requires
    TypeScript < 6.1.
14. **`createGateway()` returns a `Gateway` object** (`{ app, fetch, reload, setDraining, close,
services, … }`) rather than a bare Hono app. `gateway.app` is the Hono app.
15. **Qwen thinking is disabled.** The `local-qwen` model sets
    `params.chat_template_kwargs.enable_thinking: false`. Without it, qwen3.5 spends short
    `max_tokens` budgets on hidden reasoning and returns empty content.
16. **No metrics endpoint or changesets yet** (see gaps).

## Notes for the next waves

### Wave H (platform: Redis/Postgres)

- **Plug into `GatewayServices`** (`src/core/services.ts`): `keys: KeyStore`,
  `rateLimiter: RateLimiter`, `budgets: BudgetGuard`, `cache: CacheStore`, `usage: UsageSink`,
  `breakers: BreakerStore`. Pass them via `createGateway({ config, services: {...} })`. Any
  omitted service falls back to the in-memory default. `ChainedKeyStore` lets DB keys sit in
  front of static config keys.
- **Breaker:** `src/resilience/circuit-breaker.ts` exports pure `decide(state, now, cfg)` and
  `record(state, outcome, now, cfg, probe)` over a JSON-serializable `BreakerState`. A Redis
  store can load the state, apply the functions and write it back (Lua or WATCH/MULTI) without
  re-implementing the state machine. The `snapshot()` method backs `/admin/providers/health`.
- **Order of hooks:** the pipeline already calls them in SPEC order (`Pipeline.admit`,
  `Pipeline.account`). `RateLimiter.check` and `BudgetGuard.check` receive the token/cost
  estimate (`src/limits/estimate.ts`). `account` then reconciles actual usage, records the
  budget, writes the cache (non-streaming, cacheable routes) and emits the `UsageEvent`, which
  already has every SPEC §10 field.
- **Cache:** keys are built in `src/cache/keys.ts`. To replay a cache hit as a stream, use
  `responseToChunks()` from `src/core/chunks.ts`. The `x-sy-cache: default|bypass|refresh`
  request header is parsed already.
- **Usage sink:** emit is fire-and-forget from the pipeline, so batching to Postgres or a Redis
  stream belongs in the sink.

### Wave K (deploy / Docker / compose)

- **Entrypoint:** `node packages/gateway/dist/cli.js serve --config <file>`. The `PORT` env var
  overrides the port, and `server.host` (default `0.0.0.0`) the bind address.
- **Health checks:** `GET /healthz` is liveness (always 200). `GET /readyz` returns 503 while
  draining, and `?probe=1` probes the providers.
- **Shutdown:** SIGTERM/SIGINT drain in-flight requests with `server.shutdown_grace_ms` (default
  15 s). SIGHUP reloads the config.
- **Mock provider:** `switchyard mock-provider --port 8790` is a ready-made upstream for compose
  and demos.
- **Networking:** the container needs host networking (or `host.docker.internal`) to reach
  opencode on :4096 and llama.cpp on :8081–8083. Pass `OPENCODE_SERVER_PASSWORD` and
  `SWITCHYARD_ADMIN_TOKEN` as secrets.

### Wave M (npm publish)

- **Package:** `switchyard-gateway` with bin `switchyard` and exports `.` and `./mock-provider`.
  The mock provider is bundled in through `deps.alwaysBundle`, so the workspace package does not
  need to be published.
- **Build:** `dist/*.js` + `.d.ts` are produced with tsdown using `tsconfig.build.json` (src
  only, because generating dts with tests included runs out of memory). `npm pack --dry-run` was
  verified (12 files, 202 kB).
- **Missing:** changesets, a package-level README, `repository`/`homepage` metadata, and a
  provenance/CI publish workflow.
