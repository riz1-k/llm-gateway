# Switchyard status

_Last updated: 2026-10-28, after wave 6 R1 (OpenTelemetry tracing). Before that: the release
wave (M: npm package, release engineering, benchmarks, docs). The infra was built in wave K, the platform in wave H and the core in wave G._

## What exists

The core gateway and the platform layer are built. With `redis.url` / `database.url` set, the
gateway uses:

- Postgres teams and virtual keys
- Redis rate limits, budgets, exact and semantic cache, and shared breakers
- a usage stream with a Postgres worker
- the admin API and CLI
- Prometheus metrics

Without them, it falls back to the in-memory core implementations.

| Area          | State                                                                                                                                                                                                                                                                                            | Where                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Monorepo      | pnpm 11 workspace, TS 6 strict ESM, eslint flat (type-aware) + prettier, vitest 5, tsdown                                                                                                                                                                                                        | root                                          |
| Config        | YAML + `${ENV}` / `${ENV:-default}` interpolation, zod schema, cross-reference checks with paths, pricing file, SIGHUP / `POST /admin/config/reload` hot reload (ref-counted snapshots)                                                                                                          | `packages/gateway/src/config/`                |
| HTTP API      | `/v1/chat/completions` (JSON + SSE, `include_usage`), `/v1/embeddings` (+ `input_type` templates), `/v1/rerank`, `/v1/models`, `/healthz`, `/readyz` (`?probe=1`), `/admin/providers/health`, OpenAI error envelope, `x-sy-*` headers, request id, pino logs, body limit, graceful drain         | `src/app.ts`, `src/server.ts`                 |
| Pipeline      | auth → validate → route → defaults → estimate → RateLimiter → BudgetGuard → CacheStore → Router → account → UsageSink                                                                                                                                                                            | `src/core/pipeline.ts`                        |
| Router        | fallback / weighted (smooth WRR) / least-latency (EWMA, ε-explore); retries with full jitter + Retry-After cap; per-attempt + route deadline; circuit breaker (pure `decide`/`record` + `MemoryBreakerStore`); per-provider FIFO semaphores; streaming fallback until the first meaningful chunk | `src/core/router.ts`, `src/resilience/`       |
| Providers     | `opencode` (full emulation + real `/event` streaming), `openai-compatible` (chat, embeddings, rerank), `openai`, `anthropic` (Messages translation incl. streaming tool use), `mock` (in-process)                                                                                                | `src/providers/`                              |
| Mock provider | standalone deterministic OpenAI-compatible server with header/flag fault injection; bundled into the gateway package as `switchyard-gateway/mock-provider`                                                                                                                                       | `packages/mock-provider/`                     |
| CLI           | `serve`, `worker`, `migrate`, `validate-config`, `mock-provider`, admin: `teams`, `keys`, `budgets`, `usage`, `cache purge`, `seed-dev` (local mode via `--config`, remote via `--url` + admin token)                                                                                            | `src/cli.ts`, `src/cli/`                      |
| Database      | drizzle-orm schema + drizzle-kit migration (hand-edited: `usage_events` monthly range partitions, `sy_ensure_usage_partition()`), `switchyard migrate` with advisory lock                                                                                                                        | `src/db/`, `drizzle/`                         |
| Keys & teams  | `PlatformKeyStore`: static → local cache → Redis (60 s, negative 10 s) → Postgres; pub/sub invalidation; batched `last_used_at`; `sk-sy-` + 40 base62 generator                                                                                                                                  | `src/auth/db-key-store.ts`                    |
| Rate limits   | `RedisRateLimiter`: sliding-window RPM/TPM × key/team in one Lua call (all-or-nothing), TPM reserve + reconcile, `x-ratelimit-*` / `retry-after(-ms)`                                                                                                                                            | `src/limits/`                                 |
| Budgets       | `RedisBudgetGuard` + `DbBudgetSource`: daily/monthly counters, pre-flight 402, soft/exceeded alerts (SET NX + webhook), reconciliation from `usage_daily`, linear projection                                                                                                                     | `src/limits/`, `src/usage/reconcile.ts`       |
| Cache         | `RedisCacheStore` (gzip ≥ 512 B, MGET/pipelined SET), per-item embedding cache, streaming replay, `RedisVectorIndex` semantic cache (Redis 8 vector sets)                                                                                                                                        | `src/cache/`                                  |
| Breakers      | `RedisBreakerStore`: CAS Lua over the pure state machine, per-target coalescing queue, 1 s local cache of closed state, local fallback                                                                                                                                                           | `src/resilience/redis-breaker.ts`             |
| Usage         | `RedisStreamUsageSink` (XADD MAXLEN ~, memory buffer, drop metric) → `UsageWorker` (XREADGROUP, single-statement idempotent insert + rollup, XAUTOCLAIM, dead-letter, partitions/retention, budget reconcile)                                                                                    | `src/usage/`                                  |
| Admin API     | SPEC §12 under `/admin`: teams CRUD, keys create/list/revoke/rotate, budgets, budget status, usage reports, cache purge, audit log, redacted config; every mutation audit-logged in the same transaction                                                                                         | `src/admin/`                                  |
| Metrics       | `PromMetrics` (all SPEC §13 names + extras), `/metrics` on the API port or `metrics.port`; worker metrics on `--port`                                                                                                                                                                            | `src/observability/metrics.ts`                |
| Tracing       | Opt-in OpenTelemetry: SERVER span per `/v1` request, `sy.limits` / `sy.cache.*` stage spans, CLIENT span per upstream attempt (GenAI semconv), W3C propagation in and out, `x-sy-trace-id`, `trace_id`/`span_id` in logs, OTLP/HTTP export, SDK lazily loaded (ADR 0007)                         | `src/observability/tracing.ts`, `otel-sdk.ts` |
| Dev tooling   | `Makefile`, `scripts/dev.sh`, `scripts/smoke_openai_sdk.py`, `.env.example`                                                                                                                                                                                                                      | root                                          |
| Docs          | `README.md`, `docs/{CONFIG (generated),API,LIBRARY,ARCHITECTURE,RELEASING,ADMIN,METRICS,DEPLOYMENT,OBSERVABILITY}.md`, `docs/adr/` (7 ADRs), `docs/opencode-bridge.md`, `CONTRIBUTING.md`, `SECURITY.md`, this file                                                                              |                                               |
| Release       | npm package `switchyard-gateway` (CLI `switchyard`, library, `./mock-provider`, `./config.schema.json`), Changesets + `release.yml` (npm trusted publishing, GitHub Packages, GitHub Release, GHCR), pack smoke, verdaccio e2e, k6 benchmarks                                                    | see [Release](#release-wave-m)                |

## Release (wave M)

Switchyard is packaged and release-engineered as an open-source product. **Nothing has been
published yet:** the first release happens when the repository is pushed and the owner finishes
the one-time setup in [RELEASING.md](RELEASING.md#one-time-setup-owner).

### Package `switchyard-gateway@0.1.0`

- **Entry points:** ESM-only, Node ≥ 22.12.
  - `.`: the library, with a tiered public API of 133 exports. Every export has TSDoc, enforced
    by `scripts/check-api-docs.mjs`. Internal helpers (Redis key builders, Lua wrappers,
    invalidation bus, writer internals, …) are no longer exported.
  - `./mock-provider`.
  - `./config.schema.json`.
  - `./package.json`.
  - bin: `switchyard`.
- **mock-provider decision:** `@switchyard/mock-provider` stays a private workspace package. It
  is bundled into the CLI and re-exported as `switchyard-gateway/mock-provider`: one artifact,
  no version skew.
- **Tarball:** 16 files, 161.9 kB packed and 638.1 kB unpacked (dist JS and d.ts, drizzle SQL,
  schema, README, CHANGELOG, LICENSE). Source maps are off.
- **Checks:**
  - `publint --strict`: "All good!".
  - `attw --profile esm-only`: 🟢 node16-ESM and bundler for all four entry points.
- **Config JSON Schema:**
  - Generated from zod (`scripts/config-schema.ts`, draft 2020-12, input shape).
  - Rejects typos (`additionalProperties: false`) and accepts `${VAR}` strings for numbers,
    booleans and enums.
  - Unit tests validate every `config/*.yaml`, the Helm `values.yaml` config and the `init`
    starter, and check for drift.
  - `docs/CONFIG.md` is generated from the same schema, with its own drift test.
- **CLI UX:**
  - `switchyard init` writes `gateway.yaml` with the mock provider and the schema comment, plus
    `.env.example`, and never overwrites without `--force`.
  - The config path is resolved from `--config`, then `$SWITCHYARD_CONFIG`, then
    `./gateway.yaml`. `./.env`, `--env-file` and `SWITCHYARD_ENV_FILE` are loaded without
    overriding the real environment.
  - Per-command `--help`, and hints for unknown flags or commands, ECONNREFUSED/DNS/timeouts and
    Postgres auth or missing-database errors.
  - Config errors start with the file path.
  - `serve` no longer hangs when Redis or Postgres is unreachable (startup is bounded by
    `connect_timeout_ms`, with a hint), and shutdown with Redis down no longer hangs.
- **Library:**
  - `type: custom` providers with `createGateway({ adapterFactories })`.
  - The default in-memory cache is now `MemoryCacheStore` (LRU), not a no-op.
  - `LogUsageSink` logs at `debug`.
- **Streamed cost:**
  - `usage.cost` (USD), `usage.sy_cache` and, on hits, `usage.sy_saved_cost` appear in chat
    bodies and in the final streamed usage chunk when `include_usage` is set, including streamed
    cache replays.
  - Backward compatible (additive fields), contract-tested with the official `openai` SDK, and
    documented in [API.md](API.md#cost-in-the-response-body-usagecost).

### Verdaccio proof (2026-10-27, final build)

`scripts/verdaccio-e2e.sh`:

1. Starts a throwaway verdaccio 7.0.2 on `127.0.0.1:48731`.
2. Publishes with `pnpm publish` as a dummy user: `✅ Published package switchyard-gateway@0.1.0`,
   files=16, unpacked=638080, and no `workspace:` ranges in the published manifest.
3. Installs into an empty project (41 packages) and runs:
   - `switchyard --version` → `0.1.0`;
   - `init`;
   - `validate-config` → "✔ gateway.yaml is valid: 1 providers, 2 models, 2 routes";
   - `serve`, then curl chat (`usage.cost` 0.0000033, `sy_cache: miss`) and embeddings (2 × 256);
   - the official `openai@7.45.0` SDK: chat (`cost` 0.00000555), streaming (final chunk
     `cost` 0.0000048) and embeddings;
   - the library: `createGateway` → 200 with cost 0.0000018, the `mock-provider` export and the
     schema JSON import.
4. Stops the registry and the server by PID and deletes everything.

CI runs the same smoke against the packed tarball on Node 22 and 24 (`scripts/pack-smoke.sh`).

### Release engineering

- **Changesets** (`.changeset/`, GitHub changelog). The first release publishes **0.1.0 as-is**:
  no changeset is pending, `changeset publish-plan` → "switchyard-gateway@0.1.0 (latest)", and
  `CHANGELOG.md` has a hand-written 0.1.0 entry.
- **`.github/workflows/release.yml`:**
  - select-mode → version PR | pack → publish to npmjs.com with provenance, using npm trusted
    publishing (OIDC, environment `npm`), with an `NPM_TOKEN` fallback for the first publish;
  - then the git tag and GitHub Release;
  - then `@riz1-k/switchyard-gateway` on GitHub Packages (`GITHUB_TOKEN`);
  - then `docker.yml` through `workflow_call`, pushing `ghcr.io/riz1-k/switchyard:<version>`,
    `<major>.<minor>` and `latest`.
- **CI:** `ci.yml` gained a `package` job (Node 22/24 matrix: schema and docs drift, TSDoc,
  publint, attw, pack smoke). K's security job (audit, gitleaks) is untouched.
- **Hardening:** actions are SHA-pinned and permissions are least-privilege per job.
  `actionlint` 1.7.12 reports 0 errors in 3 files. shellcheck is not installed here, so its
  checks were skipped.
- **Makefile:** `schema`, `check-package`, `pack-smoke`, `verdaccio-e2e`, `bench`. `test-live`
  and `dev` read `ENV_FILE` (default `.env`) instead of `../devenv/.env`.

### Benchmarks

See [bench/RESULTS.md](../bench/RESULTS.md): k6 against a 0 ms mock on one pinned gateway core.

| p50 overhead (200 req/s) | Platform off  | Platform on | Target |
| ------------------------ | ------------- | ----------- | ------ |
| Chat miss                | +2.26 ms      | +3.41 ms    | < 3 ms |
| Exact-cache hit          | +0.48 ms      | +1.72 ms    | < 1 ms |
| Max req/s miss / hit     | 1,243 / 3,630 | 651 / 2,017 |        |

- **Targets:** met with the platform off, missed with it on.
- **Profiling:** one `node --cpu-prof` session found log writes, upstream `fetch`, token
  estimation, GC and ioredis as the top costs.
- **Fixes:** three small fixes (usage log at debug, concurrent budget and rate-limit checks,
  parallel post-response writes). An interleaved A/B showed no significant change on the miss
  path. Documented as is.
- **Caveat:** the numbers come from a shared, loaded laptop.

### Docs

- New: README (rewritten), `docs/CONFIG.md` (generated), `docs/API.md`, `docs/LIBRARY.md`,
  `docs/ARCHITECTURE.md`, `docs/RELEASING.md`, and six ADRs in `docs/adr/` (Hono, opencode
  emulation, Lua sliding-window limits, Redis Streams usage pipeline, semantic cache on vector
  sets, budgets).
- Contributor files: `CONTRIBUTING.md`, `SECURITY.md` (now lists the residual risks from
  SECURITY_REVIEW), issue templates, PR template, `.changeset/README.md`, `.node-version`, and
  `LICENSE` (MIT, riz1-k).

### Hygiene

- **Audit:** `pnpm audit --prod` → "No known vulnerabilities found". The full audit shows 1
  moderate in the dev-only `drizzle-kit → esbuild` chain (SR-23).
- **Secrets:** gitleaks over the working tree reports "no leaks found".
- **Tests:** 341 gateway and 42 mock-provider tests pass. tsc, eslint and `prettier --check` are
  clean.

## How to run

```bash
pnpm install && pnpm build
make dev                      # = scripts/dev.sh → serves config/gateway.local.yaml on :8787 (PORT overrides)
# or: node packages/gateway/dist/cli.js serve --config config/gateway.local.yaml
node packages/gateway/dist/cli.js validate-config config/gateway.local.yaml
node packages/gateway/dist/cli.js mock-provider --port 8790
```

Platform (Postgres `llmgateway` + Redis; see [ADMIN.md](ADMIN.md)):

```bash
node packages/gateway/dist/cli.js migrate --config config/gateway.local.yaml   # once, idempotent
node packages/gateway/dist/cli.js worker  --config config/gateway.local.yaml   # not needed with gateway.local.yaml:
                                                                               # it sets usage.in_process_writer: true
node packages/gateway/dist/cli.js seed-dev --config config/gateway.local.yaml --output ../devenv/gateway-keys.env
node packages/gateway/dist/cli.js usage --config config/gateway.local.yaml --group-by team
```

`scripts/dev.sh` loads `$SWITCHYARD_ENV_FILE` (default: `./.env`, gitignored; for
`OPENCODE_SERVER_PASSWORD`). On this machine point it at the devenv file:
`make dev ENV_FILE=../devenv/.env` (the same variable works for `make test-live`). It runs `dist/cli.js` and falls back to the TypeScript source via `tsx` when there is no
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

Run on 2026-10-27, after the platform build:

- **Gateway:** `pnpm test` passes 301 tests in 21 files.
  - The original 231 tests in 12 files are unchanged and still pass.
  - 70 new platform tests run against real Redis 8.0 (db 1) and Postgres 18 (`llmgateway_test`,
    one schema per file):

| File                         | Tests | Covers                                                                                                                                                   |
| ---------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/platform-unit.test.ts` | 13    | key generator (format, uniformity), header formatting, periods/projection, gzip codec, semantic scope, redaction, parsing                                |
| `platform/ratelimit.test.ts` | 9     | RPM headers, sliding weight, all-or-nothing, TPM reserve/reconcile, 100 concurrent / many keys never exceed, fail open/closed                            |
| `platform/budgets.test.ts`   | 7     | 402 at limit, pre-flight 0, daily+monthly TTLs, alert/soft/off, single alert across replicas + webhook, reconcile, fail open                             |
| `platform/cache.test.ts`     | 11    | store/batch/purge, vector search, miss→hit with saved cost, bypass/refresh, team isolation/shared, SSE replay, per-item embeddings, semantic             |
| `platform/breaker.test.ts`   | 5     | cross-replica trip, single half-open probe, no lost updates (60 concurrent CAS), local cache, Redis-down fallback                                        |
| `platform/keys.test.ts`      | 7     | DB key auth + Redis cache + scope, revocation on a 2nd replica, rotation with grace, negative cache/expiry, static↔team, 503 when DB down                |
| `platform/usage.test.ts`     | 6     | request → stream → worker → PG (JSON/stream/error/hit), idempotent redelivery, XAUTOCLAIM, dead-letter + partitions + retention, buffer/drops, reconcile |
| `platform/admin.test.ts`     | 10    | authz, teams/keys/budgets CRUD + validation, 402 and 429 end to end, usage reports, audit + redaction, readiness, seed-dev idempotency, HTTP client      |
| `platform/metrics.test.ts`   | 2     | every SPEC §13 metric present with samples after real traffic (exact rejection counts), dedicated metrics port                                           |

- **Mock provider:** 42 tests.
- **Total: 343 passing** (273 original + 70 new). `pnpm typecheck`, eslint and
  `prettier --check` are clean.
- **Packaging:** `npm pack --dry-run` gives 16 files and 348 kB, now including `drizzle/`. The
  built `dist/cli.js` finds the migrations by walking up from its own location; override with
  `SWITCHYARD_MIGRATIONS_DIR`.
- **Live suite** from wave G: `pnpm test:live` passed 4/4 tests using 5 real Copilot calls. The
  platform build made zero real LLM calls.

Platform live verification on 2026-10-27, using `dist/cli.js` on :8788 with Redis db 6, Postgres
`llmgateway` and mock routes only:

| Check              | Result                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrate` ×2       | `1 applied, 1 total`, then `0 applied`. Tables plus `usage_events_y2026m10..m12` partitions.                                                                                                                                                                                                                                        |
| Admin API          | `POST /admin/teams` (monthly $5) → 201; `POST /admin/teams/demo/keys {rpm_limit: 3}` → 201 with `sk-sy-…` (46 chars), masked `sk-sy-wDtMhA…`                                                                                                                                                                                        |
| Cache              | Request 1: `x-sy-cache: miss`, `x-sy-cost-usd: 0.022`. Request 2: `x-sy-cache: hit`, `x-sy-cost-usd: 0`, `x-sy-saved-usd: 0.022`.                                                                                                                                                                                                   |
| 429                | 4th request in the minute: `429 rate_limit_exceeded`, `retry-after: 11`, `retry-after-ms: 10040`, `x-ratelimit-limit-requests: 3`, `x-ratelimit-remaining-requests: 0`, `x-ratelimit-reset-requests: 51s`                                                                                                                           |
| 402                | Team with $0.05 monthly: first call 200 ($0.037), next calls `402 budget_exceeded` ("Budget exceeded for team tiny (monthly)"). `GET /admin/teams/tiny/budget`: spent 0.037, utilization 0.74, projected 0.0437.                                                                                                                    |
| Worker             | 15 rows in `usage_events` (cache hit: `saved_usd 0.022`, 0 tokens; 429/402 rows with error codes) and 5 `usage_daily` rows. Consumer group `writers`: lag 0, pending 0.                                                                                                                                                             |
| `switchyard usage` | `--group-by team`: tiny 10 req / $0.0370; demo 5 req / 1 hit / $0.0220 cost / $0.0220 saved. `--team demo --group-by route` works too.                                                                                                                                                                                              |
| `/metrics`         | `sy_requests_total{route="mock-chat",…,cache="hit"} 1`, `sy_cache_saved_usd_total{team="demo",route="mock-chat"} 0.022`, `sy_ratelimit_rejections_total{scope="key",limit="rpm"} 2`, `sy_budget_rejections_total{team="tiny"} 2`, `sy_usage_stream_lag 0`; worker `:9789` with `sy_usage_worker_events_total{result="inserted"} 15` |
| CLI remote mode    | `teams list`, `keys list`, `budgets show`, `keys revoke` → the revoked key gets 401 immediately                                                                                                                                                                                                                                     |

- **Bug found and fixed during the live run:** rejection counters were incremented twice (limiter
  plus pipeline). The test now asserts exact counts.
- **Cleanup:** every process was stopped by PID. The demo rows were truncated from `llmgateway`
  (the schema stays migrated) and the `sy:*` keys were removed from Redis db 6.

## Core live verification (wave G)

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

## Infrastructure (wave K)

Deployment and observability are built and verified end to end. See
[DEPLOYMENT.md](DEPLOYMENT.md) and [OBSERVABILITY.md](OBSERVABILITY.md).

| Area         | What                                                                                                                                                                                                                                                                                    | Where                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Image        | Multi-stage pnpm build → distroless `nodejs24-debian13:nonroot` (uid 65532). Bases pinned by digest, OCI labels, allow-list `.dockerignore`. **188.2 MB** uncompressed (≈ 65 MB compressed); CI enforces < 200 MB                                                                       | `deploy/docker/Dockerfile`, `.dockerignore`     |
| Compose      | gateway, worker, migrate, mock-provider, Redis 8.8.4, Postgres 18.6, Prometheus 3.15.1, Grafana 13.2.4 (+ `seed` in profile demo). Healthchecks, `depends_on` conditions, memory limits (≈ 2.2 GB total), read-only containers. Host ports 8797/55432/56379/9091/3301 on 127.0.0.1 only | `deploy/docker/`, `config/gateway.compose.yaml` |
| Demo traffic | Dependency-free `deploy/demo/traffic.mjs`. Uses the admin API to create 3 teams + a $0.002 sandbox team and an RPM-5 key, then sends weighted chat/stream/embed/rerank/tools traffic. Exits 1 unless cache hits, fallbacks, 429s and 402s were all observed                             | `deploy/demo/`                                  |
| Dashboards   | Overview (22 panels), Cost & Budgets (20), Providers & Reliability (20). schemaVersion 42, `datasource`/`pgds`/`team`/`route` variables, Prometheus + Postgres queries, generated from code                                                                                             | `observability/grafana/`                        |
| Alerts       | 3 recording rules + 8 alerts (error rate, p95, breaker open, budget > 90 % / exhausted, stream lag, dropped events, fail-open), runbook links, promtool unit tests                                                                                                                      | `observability/prometheus/`                     |
| Helm         | API + worker Deployments, migration hook Job, Services, Ingress, ConfigMap, Secret / existingSecret, HPA, PDB, ServiceMonitor, PrometheusRule, `helm test`, probes, restricted securityContext, topology spread, `values.schema.json`, NOTES, README values table                       | `deploy/helm/switchyard/`                       |
| Terraform    | Modules `switchyard`, `redis`, `postgres`, `observability` (kube-prometheus-stack 92.14.0 + dashboard ConfigMaps). `envs/local-kind` (tehcyx/kind, port mappings, image build + `kind load`, mock provider, metrics-server, seed Job). `envs/aws-eks-example` (validate only)           | `deploy/terraform/`                             |
| CI           | `ci.yml`: node (lint/typecheck/build/test with Postgres + Redis services), security (`pnpm audit --prod --audit-level=high`, gitleaks 8.30.1 over full history), infra lint, image build + smoke + size budget. `docker.yml`: multi-arch GHCR push, SBOM, provenance, attestation       | `.github/workflows/`                            |
| Tooling      | `make tools` downloads pinned, checksum-verified promtool 3.15.1, kubeconform 0.8.0, actionlint 1.7.12, tflint 0.65.0, gitleaks 8.30.1. `make lint-infra`, `lint-secrets`, `audit`, `compose-*`, `k8s-*`, `screenshots`                                                                 | `Makefile`, `deploy/scripts/install-tools.sh`   |

CI hardening:

- Workflow-level `permissions` are `contents: read` or `{}`. Write grants are per job: the push
  job in `docker.yml` (`packages`, `id-token`, `attestations`), the release jobs, and
  `security-events: write` (plus `id-token: write` for Scorecard publishing) in the scanners.
- No `pull_request_target`. Every action is pinned by commit SHA, and CI service images by digest.
- actionlint (with shellcheck) and zizmor run in CI; accepted zizmor findings carry an inline
  `# zizmor: ignore[...]` with the reason.
- Supply chain: `docker.yml` signs every pushed image with cosign (keyless, GitHub OIDC);
  `codeql.yml` scans javascript-typescript and actions; `scorecard.yml` publishes OpenSSF
  Scorecard results; Dependabot opens monthly, grouped updates for npm, actions and images.
- `persist-credentials: false` on checkouts.

### Verification (2026-10-27)

Compose and kind were run one after the other, never at the same time, each under the shared
heavy-docker lock and torn down afterwards.

**Compose** (`make compose-up` → `make compose-demo` → `make compose-down`):

- **Startup:** all services healthy on the first `up --wait`. `migrate` logged "1 applied", and
  `seed` created docsqa/opsagent/evals without printing keys.
- **Demo traffic:**

  | Run   | Requests | Cache hits | Fallbacks | Streams | 429 | 402 | 5xx |
  | ----- | -------- | ---------- | --------- | ------- | --- | --- | --- |
  | 150 s | 1997     | 1269       | 228       | 175     | 39  | 82  | 0   |
  | 90 s  | 1253     | 898        | 149       | n/a     | 32  | 53  | 0   |

- **Prometheus (HTTP API):**
  - 3/3 targets up.
  - `sy_cost_usd_total` by team: docsqa $0.165, opsagent $0.025, sandbox $0.0084, evals
    $0.0005. Cache savings for docsqa: $0.376.
  - Fallback reasons seen: `rate_limited`, `circuit_open`, `upstream_unavailable`. Breaker
    states 1 and 2 were observed.
  - Sandbox budget utilization 0.84. 39 key-RPM rejections. Stream lag 0. The worker inserted
    1916 events.
  - All rule groups loaded, with `SwitchyardCircuitOpen` pending.
- **Grafana (HTTP API):** 3 dashboards in the "Switchyard" folder at schemaVersion 42. Both
  datasources healthy (Postgres: "Database Connection OK"). Peak memory: Grafana 378 MiB (the
  limit was raised from 384 MiB to 512 MiB), gateway 164 MiB.
- **Screenshots:** `observability/screenshots/switchyard-{overview,cost,providers}.png`.
- **Config change:** after `usage.stream_maxlen: 100000` was added, gateway and worker were
  restarted. `/readyz` returned ready, and `/readyz?probe=1` returned 401 without the admin
  token and 200 with it.
- **Teardown:** `make compose-down` (`down -v`) left 0 containers and 0 volumes.

**kind** (`make k8s-up` → `make k8s-demo` → `make k8s-down`):

- **Preconditions:** 5.4 GB RAM available and 16 GB disk free. Observability stayed enabled.
- **Apply:** 26 resources created.
  - The first attempt failed at plan time on a conditional type mismatch in the switchyard
    module. The second exposed a PSA violation: the kubernetes provider sends
    `runAsNonRoot: false` when the field is unset. Both are fixed.
  - A later apply added metrics-server and ran a Helm upgrade (revision 2), which put the
    migration hook through the upgrade path as well.
- **Pods:** all Running/Ready (2 API, worker, Postgres, Redis, mock-provider, Prometheus,
  Grafana, operator, kube-state-metrics, metrics-server), and the seed Job Completed.
- **Demo through NodePort 30787 → 127.0.0.1:8797:** 1585 requests, 1002 cache hits, 161
  fallbacks, 152 streams, 28 × 429, 66 × 402, 0 × 5xx.
- **Prometheus:**
  - ServiceMonitor targets up: 2 × gateway :9464 and the worker :9465.
  - All 4 Switchyard rule groups were loaded from the PrometheusRule.
  - `sy_cost_usd_total` by team: docsqa $0.145, opsagent $0.023, sandbox $0.0010, evals $0.0005.
- **Grafana:** the Postgres datasource was healthy.
- **`kubectl top`:**
  - node: 285m CPU, 2516 Mi
  - Grafana 414 Mi, Prometheus 260 Mi, API 173 / 149 Mi, mock 88 Mi, worker 54 Mi, Postgres
    50 Mi, Redis 5 Mi
- **Screenshot:** `observability/screenshots/switchyard-cost-kind.png`.
- **Teardown:** `make k8s-down` destroyed 26 resources, and `kind get clusters` reported "No
  kind clusters found".

**Static validation** (`make lint-infra lint-secrets audit`):

- promtool: 11 rules, unit tests SUCCESS
- helm lint: 0 failed
- kubeconform `-strict` (Kubernetes 1.37): default values 12/12 valid, full values 16/16
- `terraform fmt` and `validate` pass for both envs, and tflint is clean
- actionlint clean, gitleaks found no leaks, and `pnpm audit --prod` found no known
  vulnerabilities

### Ops notes (from the security review, commit ab9df49)

- `/readyz` (Redis + Postgres) is unauthenticated and suitable for kubelet probes.
  `/readyz?probe=1`, which also probes the upstreams, now requires the admin token.
- When a client sends `x-request-id`, the header is echoed back unchanged, but usage rows store
  `<client-id>:req_<24 chars>`, so ledger idempotency on `(ts, request_id)` cannot drop distinct
  requests. Search by prefix.
- Compose, kind and the chart default set `usage.stream_maxlen: 100000`. The schema default is
  1 000 000. At about 700 B per entry that is about 70 MB of Redis; see
  [DEPLOYMENT.md § Redis sizing](DEPLOYMENT.md#redis-sizing).

### Deviations (wave K)

1. **The distroless base is `nodejs24-debian13`** (the brief did not name a Debian release). The
   build stage uses `node:24.22.1-trixie-slim` to match. The image build runs tsdown with
   `--no-dts`, because generating type declarations needs about 2 GB RSS and the image doesn't
   use them. Unused js-tiktoken encodings (everything except o200k) are pruned to stay under
   200 MB, and a tokenizer smoke check guards that pruning.
2. **`make compose-down` always removes volumes** (`down -v`). `make compose-down -v` would be
   parsed by make itself. `make compose-stop` keeps data.
3. **The dashboards are generated** by `observability/grafana/generate-dashboards.mjs`; the JSON
   is checked in, and CI fails if it is stale. The Providers dashboard filters on
   `provider`/`route` instead of `team`, because upstream metrics carry no team label.
4. **Alerts are copied into the chart** (`deploy/helm/switchyard/files/alerts.yml`), because Helm
   cannot read files outside the chart. `make chart-sync` updates the copy, and `make lint-alerts`
   fails if it has drifted.
5. **The demo adds a fourth team, `sandbox`,** with a $0.002 monthly budget, so 402s happen
   reliably.
6. **Small fix in `packages/gateway/src/cli/commands.ts` (`seed-dev`).** With `--output`, keys
   are now written only to the 0600 file: JSON output reports `key: null` and human output skips
   the "New keys" block. This is what ADMIN.md already described, and it keeps keys out of
   container and Job logs. No other `packages/**` changes were needed for containers.
7. **The local-kind env adds metrics-server**, which kind lacks, so `kubectl top` works. The
   Grafana image preload is opt-in (`preload_images`), because kind stages images in `$TMPDIR`,
   which is a tmpfs on this machine.
8. **Grafana's compose memory limit is 512 MiB.** It peaked at 378 MiB, too close to the
   initial 384 MiB limit.

### Infra known gaps

- **The EKS environment has never been applied.** It is only validated, and has no remote state
  backend.
- **No Alertmanager** in compose or in the kind small-footprint profile. Alerts are visible in
  Prometheus and Grafana only.
- **Image signing is unproven on GitHub.** `docker.yml` signs every pushed image with cosign
  (keyless, GitHub OIDC) and verifies it in the same job, but no image has been pushed yet.
- **Workflows on GitHub:** CI, Docker image and Release have run green on GitHub since 2026-10-27 (the opt-in
  release stops at a notice until `RELEASE_ENABLED` is set; see RELEASING.md).
- **Prometheus cost counters reset on pod restart.** `increase()` handles that, but long-range
  cost questions should use the Postgres panels.
- **`terraform.tfstate` for local-kind is local** (gitignored). It contains generated passwords
  while a cluster exists.

## Wave 6 R1 — tracing

Branch `feat/otel-tracing`, 2026-10-27/28. Closes the "No OpenTelemetry tracing" gap (SPEC §13).

**What changed**

- **Config:** `observability.otel` is a real schema: `enabled`, `endpoint`, `headers`,
  `service_name`, `sample_ratio`, `resource_attributes`. Config values win; standard `OTEL_*`
  variables fill unset keys; `OTEL_SDK_DISABLED=true` forces off. `config.schema.json` and
  CONFIG.md regenerated; the three example configs updated.
- **Core:** `src/observability/tracing.ts` (API only) and `src/observability/otel-sdk.ts`
  (loaded with `import()` only when enabled; its own bundle chunk). SDK 3.0 packages are exact-pinned
  optional dependencies, `@opentelemetry/api ^1.9.0` a dependency ([ADR 0007](adr/0007-otel-sdk-packaging.md)).
  An existing global provider wins (embedder rule, LIBRARY.md). Spans flush after the drain on
  SIGTERM.
- **Spans:** see [OBSERVABILITY.md § Tracing](OBSERVABILITY.md#tracing). GenAI semconv from
  semantic-conventions-genai `main@51a0f58` (2026-10-27, on semconv v1.44.0). One CLIENT span per
  attempt is a documented deviation from the spec's "one span with all retries".
- **Propagation:** every `upstreamFetch` user (openai, anthropic, openai-compatible) and the
  opencode bridge inject `traceparent`/`tracestate`/`baggage`. The mock-provider server records
  those three headers (`trace` in `/__mock/stats` `recent`).
- **Clients:** `x-sy-trace-id` response header; `trace_id`/`span_id` on request log lines.
- **Stacks:** Tempo 3.1.1 (digest-pinned, 24 h retention, 256 MB, OTLP/HTTP only) in both compose
  files, a Grafana Tempo datasource with trace-to-metrics links, `observability/tempo/tempo.yaml`,
  Helm `tracing.*` values (env-based), Makefile hints.
- **Tests:** `test/integration/tracing.test.ts` (16, in-memory exporter, host-registered provider),
  `tracing-sdk.test.ts` (4, real SDK against a fake OTLP collector), `tracing-disabled.test.ts`
  (2, no SDK import, no spans, no header); one mock-provider test.

**Live verification (2026-10-28, observe-host Tempo, gateway from this tree on :8788, mock on
:8791).** Span trees from `GET /api/v2/traces/<id>` (abridged):

```
non-stream 8412ddb3…: POST /v1/chat/completions [SERVER] 45.6ms → sy.cache.exact (miss) 0.2ms
                      → chat mock-echo [CLIENT] 24.7ms in=10 out=3 finish=stop cost=9.5e-06
cache hit cb63a09d…:  POST /v1/chat/completions [SERVER] 2.7ms sy.cache=hit saved=9.5e-06
                      → sy.cache.exact (hit) 0.1ms
stream 05170346…:     POST … [SERVER] 12.5ms sy.ttft_ms=9 event sy.first_token → sy.cache.exact
                      → chat mock-echo [CLIENT] 9.5ms time_to_first_chunk=0.006 in=11 out=4
fallback f362420b…:   POST … [SERVER] 9.3ms route=demo-fallback
                      → chat mock-echo [CLIENT ERROR] target=down error.type=upstream_unavailable 503
                      → chat mock-echo [CLIENT] target=echo fallback.index=1 reason=upstream_unavailable
traceparent 4bf92f35…: SERVER parent = caller span 00f067aa0ba902b7 → cache → CLIENT
```

The mock received `traceparent` with each attempt's span id (both fallback attempts matched
Tempo's span ids) and `tracestate: docsqa=w7`. A span sent less than 1 s before SIGTERM reached
Tempo (flush on shutdown).

**Overhead** (cache-miss chat, constant 100 req/s × 12 s, 5 interleaved rounds, gateway pinned to
CPU 2, loader and 0 ms mock on CPU 3, unique prompts; a throwaway Node loop because k6 is not
installed here). `base` is the stable build d9db543 (pre-tracing, and older than this tree in other
ways too). Medians, with the per-round range:

| Mode                             | p50 ms           | p95 ms            | gateway CPU ms/req | errors |
| -------------------------------- | ---------------- | ----------------- | ------------------ | ------ |
| mock direct                      | 1.07 (1.03–1.20) | 2.3 (1.9–2.9)     | –                  | 0      |
| base (d9db543)                   | 5.40 (5.11–6.46) | 62.5 (23.2–154.2) | 3.84 (3.52–5.26)   | 0      |
| tracing off                      | 5.76 (5.51–6.53) | 55.3 (10.5–119.4) | 4.08 (3.87–4.80)   | 0      |
| on, `sample_ratio: 1` (to Tempo) | 5.78 (5.50–6.54) | 23.3 (15.0–169.0) | 4.06 (3.93–5.40)   | 0      |
| on, `sample_ratio: 0.01`         | 5.47 (5.43–6.25) | 32.2 (26.6–73.8)  | 3.92 (3.81–4.32)   | 4      |

Read it as "no difference this machine can resolve". The ranges overlap on every column, and
p95 swings 5–15× between rounds. Load average was 1.2–3.2 and CPU per request was about twice the
RESULTS.md runs, so the laptop was busy (the bench/RESULTS.md caveats apply). The 4 errors were
not reproducible in reruns with error logging (likely keep-alive resets in the loader). An earlier
200 req/s run saturated the machine and is not used.

**Images kept** for the wave-7 screenshot (observe-host pulls the last two too). Remove with:

```bash
docker rmi grafana/tempo:3.1.1@sha256:64e2fbd56d9c2b3412a4b430a58ea59e91a670b1e75f920a0c702213ad145044
docker rmi grafana/grafana@sha256:dbbc38ea21103cefb50396340cd88afec779c7e070b0a7bf5a75b4ce46651d3f
docker rmi prom/prometheus@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2
```

**Not done (gaps):** `trace_id` on `usage_events` (needs a migration and admin API change);
Prometheus exemplars (prom-client exemplars need the OpenMetrics content type, which changes
`/metrics` for every scraper); worker tracing; the full compose stack was validated with
`docker compose config` only, not started (it needs an image build); the image was not rebuilt
(SDK presence measured with `pnpm deploy --prod`).

**For wave 7 (cross-project traces):** DocsQA and OpsAgent export OTLP/HTTP to
`127.0.0.1:4318` (observe-host) or `127.0.0.1:4319` (full stack) and send `traceparent` on their
gateway calls (OpenAI SDK `default_headers`/per-request headers, or the OTel httpx
instrumentation). The gateway joins their trace and follows their sampling decision.

## Known gaps

- **`log_bodies` is reserved** (accepted, does nothing). Traces never carry content either.
- **Tracing gaps (wave 6 R1):** no `trace_id` column on `usage_events` and no Prometheus
  exemplars yet (see [Wave 6 R1 — tracing](#wave-6-r1--tracing)). The worker does not trace.
- **Platform-on overhead is above the SPEC targets:** about 3.2–3.4 ms p50 on a miss and
  1.1–1.7 ms on a hit, against targets of 3 ms and 1 ms (bench/RESULTS.md). The cause is three
  sequential Redis round trips per request. The next steps (one combined limit-and-budget Lua
  call, non-blocking post-response writes) change semantics and were left for a later release.
- **Not published yet:** npm, GitHub Packages and GHCR wait for the owner's one-time setup
  (RELEASING.md).
- **Bun: client disconnects are not detected under `switchyard serve`** (Bun 1.3.14). Bun's
  `node:http` emits no `close` / `aborted` event when a client hangs up before the response
  starts, so `@hono/node-server` never aborts the request signal: the upstream call runs to
  completion and is recorded as a 200 with its cost. Node and Deno record a 499
  `request_aborted`. Embedding with `Bun.serve({ fetch: gateway.fetch })` detects it. Otherwise
  Bun 1.3.14 and Deno 2.9.8 pass every example and probe ([Wave 7 R9](#wave-7-r9--examples--runtimes)).
- **Infra gaps (wave K):** see [Infrastructure → known gaps](#infra-known-gaps).
- **Redis Cluster is not supported:** the Lua scripts touch multiple keys without hash tags. Use a
  single primary, with replicas or Sentinel.
- **`sy_budget_utilization_ratio` only updates on traffic** (admission of a team's request). For
  idle teams use `GET /admin/teams/:id/budget` or the Postgres rollups.
- **Budget webhooks are fire-and-forget** (one attempt, 5 s timeout, failures logged). The alert
  is still deduplicated, so a failed webhook is not retried.
- **Semantic-cache embedding calls are not accounted:** the call made for a semantic lookup is
  not rate-limited, not priced and not in usage events. Local embedders cost nothing, but paid
  embedders would be under-reported.
- **The pre-flight budget estimate is conservative.** Without `max_tokens`, the route default
  completion length at the most expensive target is used, which can reject requests on very small
  budgets (documented in ADMIN.md §6).
- **No per-key concurrency limit** (in-flight requests). RPM/TPM and provider semaphores exist.
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
   known. **Resolved in wave M:** the final streamed usage chunk (with
   `stream_options.include_usage`) carries `usage.cost`, `usage.sy_cache` and, on hits,
   `usage.sy_saved_cost`. Non-streamed bodies carry the same fields (see
   [API.md](API.md#cost-in-the-response-body-usagecost)). Streaming cache hits still also send
   the header (`0`).
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
12. **Without Redis, the `UsageSink` is `LogUsageSink`.** Since wave M it logs the full event at
    `debug` only. The `info` "request completed" line already carries the same fields, and the
    second line per request roughly doubled the logging cost (see bench/RESULTS.md). With Redis
    it is the stream sink.
13. **TypeScript 6.0.3** is used instead of 7.x, because typescript-eslint 8.72 requires
    TypeScript < 6.1.
14. **`createGateway()` returns a `Gateway` object** (`{ app, fetch, reload, setDraining, close,
services, … }`) rather than a bare Hono app. `gateway.app` is the Hono app.
15. **Qwen thinking is disabled.** The `local-qwen` model sets
    `params.chat_template_kwargs.enable_thinking: false`. Without it, qwen3.5 spends short
    `max_tokens` budgets on hidden reasoning and returns empty content.
16. **Platform (wave H) deviations:**
    - **Usage tables keyed by slug:** `usage_events.team`, `usage_daily.team` and the Redis
      budget counters use the immutable team **slug**, not the uuid, so static-key traffic and
      DB-key traffic land in the same rows. `usage_events` keeps `team_id` too.
    - **Extra team columns:** teams have `rpm_limit` / `tpm_limit` (SPEC: limits come from "team
      record") and soft delete (`deleted_at`). A deleted team's slug stays reserved, and deleting
      revokes its keys.
    - **Extra metric label:** `sy_upstream_duration_seconds` has an extra `outcome` label
      (`ok|error`).
    - **Extra metrics:** `sy_budget_alerts_total`, `sy_usage_stream_pending`,
      `sy_usage_events_dropped_total`, `sy_usage_events_buffered`, `sy_platform_errors_total`,
      and, worker only, `sy_usage_worker_events_total` / `sy_usage_worker_errors_total`.
    - **`sy_requests_total` includes gateway rejections** (429/402/4xx after auth) with
      `provider="none"`.
    - **Semantic `min_similarity` is cosine similarity.** Redis `VSIM` scores (`(1+cos)/2`) are
      converted.
    - **Semantic scope:** the semantic cache embeds only the last user message. Prior turns,
      `response_format`, `max_tokens`, `stop` and `reasoning_effort` are part of the scope hash,
      and requests with tools never use it.
    - **Free requests skip budgets:** budgets never block a request whose pre-flight cost is 0
      (local / unpriced models), even when the budget is already exceeded.
    - **Cache hits record 0 tokens** in usage events and `sy_tokens_total`. The cached body keeps
      its original `usage`, and the saved cost goes to `saved_usd`.
    - **Per-item embedding cache:** embeddings are cached per input string (`cache:embi:`), and the
      response reports `x-sy-cache-items: hits/total`. `x-sy-cache` is `hit` only when every item
      hit.
    - **Reconciliation never lowers counters early:** budget reconciliation raises Redis counters to
      the Postgres value at any time, but only lowers them when the usage stream is drained
      (lag 0, pending 0), so in-flight events are never subtracted.
    - **Rate-limit reset headers:** `x-ratelimit-reset-*` is the time until the sliding counter is
      fully drained, which can be up to 2 × window. `retry-after` is the time until the rejected
      request would fit.
    - **New error codes:** `conflict` (409, duplicate slug / revoked key rotation) and
      `service_unavailable` (503: key DB unreachable, Redis down with `fail_open: false`, admin
      data API without a database).
    - **New config:** a top-level `metrics:` section (`enabled, port, path, default_metrics`) and
      new options under `redis` (`fail_open`, `connect_timeout_ms`), `database.pool_max`, `auth`
      (`key_cache_ttl_s`, `local_key_cache_ttl_ms`), `limits.window_s`, `budgets`
      (`reconcile_interval_s`, `definitions_ttl_ms`) and `usage` (`in_process_writer`,
      `stream_maxlen`, `buffer_max`, `consumer_group`, `claim_idle_ms`, `partitions_ahead`).
    - **CLI modes:** admin commands run locally against Postgres/Redis (`--config`) or remotely via
      the admin API (`--url`, `--admin-token`). The extra `seed-dev` command seeds the SPEC §17
      teams.
    - **Extra admin endpoints:** `GET /admin/audit`, and `?include_deleted` /
      `?include_revoked` filters. `group_by=provider` is also supported.
    - **Redis Cluster is unsupported** (multi-key Lua).
    - **`config/gateway.local.yaml` sets `usage.in_process_writer: true`**, so a single dev process
      persists usage.

## Notes for the next waves

### Infra / dashboards (observability + deploy)

- **Processes:** the same image runs `serve`, `worker` and `migrate`.
  - Run `migrate` as an init container or Helm hook before `serve` and `worker`. It is
    idempotent and advisory-locked.
  - The worker scales horizontally: it uses one consumer group, and inserts are idempotent.
- **Probes:** `/healthz` is liveness. `/readyz` is readiness: Redis + Postgres ping, and 503
  while draining.
- **Metrics:** names, labels, PromQL and Postgres queries for the three SPEC dashboards are in
  [METRICS.md](METRICS.md).
  - Scrape the gateway on its API port `/metrics`, or set `metrics.port`.
  - Scrape the worker with `switchyard worker --port 9465`.
  - Gauges that are identical across replicas (`sy_circuit_state`, `sy_usage_stream_lag`,
    `sy_budget_utilization_ratio`) should be aggregated with `max`.
- **Postgres datasource:** database `llmgateway`, tables `usage_daily` (rollups keyed by team slug)
  and `usage_events` (monthly partitions), plus `teams`, `budgets` and `api_keys`.
- **Redis:** Redis 8 is required for vector sets (semantic cache), and Redis Cluster is not
  supported. Use separate `key_prefix` values or db numbers per environment.
- **Secrets:** `SWITCHYARD_ADMIN_TOKEN`, `DATABASE_URL`, `REDIS_URL`.

### Orchestrator: seeding DocsQA / OpsAgent keys

1. Run `switchyard migrate --config config/gateway.local.yaml` against Postgres `llmgateway`.
   It is already applied, and the database is currently empty.
2. Run `switchyard seed-dev --config config/gateway.local.yaml --output <file>`.
   - This creates the teams `docsqa` ($50/month), `opsagent` ($50) and `evals` ($100) with
     `seed-dev` keys restricted to their routes.
   - It writes `DOCSQA_GATEWAY_KEY=…`, `OPSAGENT_GATEWAY_KEY=…` and `EVALS_GATEWAY_KEY=…` to the
     file with mode 0600.
   - Re-running it is a no-op. Use `--rotate` for new keys.
3. Put those keys in each project's `.env`. The static dev keys (`sk-sy-dev-docsqa`, …) in
   `gateway.local.yaml` keep working too, and are attributed to the same DB teams, so their
   spend counts against the seeded budgets.
4. Only a gateway built from this tree enforces this. The stable gateway on :8787 (build
   43ac5be) predates the platform layer.
   - On upgrade, it will activate the platform automatically, because `gateway.local.yaml`
     points at Redis db 0 and `llmgateway`. Run `migrate` first.
   - `gateway.local.yaml` sets `usage.in_process_writer: true`, so no separate worker is needed
     for dev.

### Wave K (deploy / Docker / compose)

Done; see [Infrastructure (wave K)](#infrastructure-wave-k). The original notes are kept below.

- **Entrypoint:** `node packages/gateway/dist/cli.js serve --config <file>`. The `PORT` env var
  overrides the port, and `server.host` (default `0.0.0.0`) the bind address.
- **Health checks:** `GET /healthz` is liveness (always 200). `GET /readyz` returns 503 while
  draining. `?probe=1` probes the providers and requires the admin token.
- **Shutdown:** SIGTERM/SIGINT drain in-flight requests with `server.shutdown_grace_ms` (default
  15 s). SIGHUP reloads the config.
- **Mock provider:** `switchyard mock-provider --port 8790` is a ready-made upstream for compose
  and demos.
- **Networking:** the container needs host networking (or `host.docker.internal`) to reach
  opencode on :4096 and llama.cpp on :8081–8083. Pass `OPENCODE_SERVER_PASSWORD` and
  `SWITCHYARD_ADMIN_TOKEN` as secrets.

### Wave M (npm publish): done

See [Release (wave M)](#release-wave-m). Follow-ups for later waves:

- **Owner, one time:** the npm token, then the trusted-publishing switch
  ([RELEASING.md](RELEASING.md#one-time-setup-owner)). Until the repository is pushed and that
  is done, nothing is published.
- **Brief O** can rely on `usage.cost` / `usage.sy_cache` / `usage.sy_saved_cost` in chat bodies
  and in the final streamed chunk (additive and backward compatible; contract-tested with the
  `openai` SDK).
- **Benchmarks** are sensitive to background load on this shared laptop; re-run `make bench` on
  a quiet machine before quoting numbers outside this repo.

## Cross-project (O)

Complete. Wave O did scope 1–4 and the failure matrix, then paused 2026-10-27 ~16:25 IST on the user's
request (committed: llm-gateway 1df5bf9, docsqa 5db0807, opsagent fc10a46). O2 finished scope 5–9 on
2026-10-27 20:23–21:40 IST: dev dashboards, failure modes in the consumer docs, Dogfooding, the shared
portfolio README section and the STATUS entries ([O2 results](#o2-dashboards-dogfooding-portfolio-story)).
This section stays the cross-project source (failure matrix, traffic, queries).

### Done (brief O scope numbers)

1. **Teams, keys, budgets.** `scripts/seed-portfolio.sh [--check] [docsqa] [opsagent]` (idempotent,
   admin API only): ensures teams `docsqa` $50 / `opsagent` $50 / `evals` $100 (monthly, soft 0.8, block),
   issues DB keys `portfolio-docsqa`, `portfolio-opsagent`, `portfolio-evals` (route allow-lists filtered
   to existing routes) and writes them into the gitignored, mode-0600 `.env` files:
   `docsqa/.env` (`LLM_API_KEY`, `EVAL_JUDGE_API_KEY`) and `opsagent/agent/.env` (`LLM_API_KEY`,
   `EVAL_LLM_API_KEY`). Re-runs keep valid keys, revoke stale ones no `.env` references, refuse to write
   into a non-gitignored file. `--check` → "in sync". Static `sk-sy-dev-*` keys untouched.
2. **Audit** (no violations): `git -C <repo> grep -nIE '(localhost|127\.0\.0\.1|host\.docker\.internal)?:(808[123]|4096)\b|api\.openai\.com|api\.anthropic\.com|claude-(sonnet|haiku|opus)|gpt-[0-9]|qwen|embeddinggemma|jina-reranker|bge-reranker|github-copilot' -- ':!*.md' ':!**/tests/**' ':!**/*.test.*' ':!**/fixtures/**' ':!.github/**' ':!**/*.lock' ':!**/cassettes/**' ':!evals/**' ':!reports/**'`
   on docsqa + opsagent. Hits are only gateway configs (`deploy/gateway.*.yaml`), labels
   (`EMBEDDING_SPACE`), the documented opt-in direct llama.cpp mode (`EMBED_BASE_URL`, default empty =
   gateway), a research script's optional `--base-url`, UI mock data and the opsagent scripted model
   (`:8300`, not an LLM; routable through the hidden `opsagent-scripted` route). Clients use route names only.
3. **Streamed cost** consumed: DocsQA `LLMClient.stream()` reads `usage.cost`/`usage.sy_cache` from the final
   chunk (done event `usage.cost_usd` no longer 0); OpsAgent `GatewayChatOpenAI` keeps them in
   `response_metadata["sy_usage"]`, `UsageTracker` uses them (`cost_source: gateway`). Verified against
   `usage_events`: 54/54 DocsQA turns match to 6 dp (38 streamed); OpsAgent real run 0.022972 + 0.006417 =
   the three `opsagent-chat` rows.
   3b. **Attribution** in `usage_events`: DocsQA `x-sy-tags app:docsqa,feature:answer|condense|retrieve|verify|ingest|judge`
   (+ caller tags e.g. `eval,case:q001`) and `x-sy-user` (opaque `u_…`/`guest`) on chat, embeddings and rerank;
   OpsAgent `app:opsagent,node:agent|judge` (+ `eval,run:<id>`) and `x-sy-user` = the thread's operator.
4. **observe-host stack**: `deploy/docker/docker-compose.observe-host.yml` + `make observe-host-up/down`
   (host network, Prometheus 127.0.0.1:9092 scraping :8787/metrics + optional worker :9465, Grafana
   127.0.0.1:3302 with K's provisioning — datasource URLs are now env-driven (`PROMETHEUS_URL`,
   `GRAFANA_PG_HOST`), the full compose stack sets the old values). Verified: gateway target up, both
   datasources healthy, 3 dashboards provisioned. Stopped with `down -v`. `capture.py --prefix` added
   (`make screenshots SCREENSHOT_ARGS=--prefix=dev-`).
5. **Failure modes** (scratch teams `o-scratch` $0.000001 and `o-ratelimit` rpm 3, both soft-deleted afterwards):

   | Case           | DocsQA before                                                                                      | DocsQA after                                                               | OpsAgent before (HEAD 6ec6232)                                                                 | OpsAgent after                                                                                                   |
   | -------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
   | budget 402     | SSE `error budget_exceeded` + friendly text; sync 402; BFF passes it through, UI alert             | unchanged (+ embeddings 402 mapped, tested)                                | `error budget_exceeded`, message = raw SDK text `LLM gateway error 402: Error code: 402 - {…}` | actionable message + gateway reason; run `error`, thread recoverable (next message on the same thread completed) |
   | rate limit 429 | embed call retried 4× in ~5 s ignoring `retry-after: 26`, reported as "search service unavailable" | 1 attempt, `rate_limited` in 0.02 s (sync 429); short retry-after honoured | SDK retries once honouring retry-after                                                         | same + message "Wait N s" and `retry_after_s`                                                                    |
   | gateway down   | `/readyz` 503 `gateway:false`; error in 5–6 s                                                      | unchanged                                                                  | no readiness endpoint, healthz ignored the gateway                                             | `/readyz` (db+mcp+gateway) 503, `healthz` shows `gateway`; clearer `LLM_UNAVAILABLE` text                        |

### Traffic so far (2026-10-27 15:10–16:20 IST, stable gateway d9db543)

DocsQA API: 4 personas × 12 questions + follow-ups on `mock-chat` (54 turns), 5 real turns (4 `docsqa-chat`

- 1 `docsqa-fast`, one exact-cache hit saving $0.0101855), 3 turns via the UI BFF; evals team: offline tier
  50 cases (39/50, = baseline) + full tier `--ids q001,q002` (2 chat + 2 judge). OpsAgent Agent API: 7 scripted
  scenarios through the hidden `opsagent-scripted` route (3 approvals incl. senior + reject), 1 real
  `opsagent-chat` run with approval. **Copilot upstream calls used: 12** (`select team,route,count(*) from
usage_events where provider='copilot' and cache='miss' and ts > '2026-10-27 15:00+05:30' group by 1,2`:
  docsqa/docsqa-chat 4, docsqa/docsqa-fast 1, evals/docsqa-chat 2, evals/docsqa-judge 2,
  opsagent/opsagent-chat 3) — 8 left of O's 20.

### Pending at the pause (all done by O2)

- **5** dev Grafana screenshots + budget/Prometheus outputs → [O2 results](#o2-dashboards-dogfooding-portfolio-story).
- **6** failure matrix in the docsqa and opsagent docs → their `docs/DEPLOYMENT.md` "Failure modes at the gateway boundary".
- **7** Dogfooding section in the gateway README.
- **8** "Part of a three-project portfolio" section in all three READMEs.
- **9** STATUS entries in docsqa and opsagent.
- `usage_daily` is maintained by the in-process writer (`usage.in_process_writer: true`): no worker needed
  (re-checked by O2: `sum(requests)` in `usage_daily` = 2,658 = `count(*)` of `usage_events`).

### Changes per repo (commits 1df5bf9 / 5db0807 / fc10a46)

- **llm-gateway**: `scripts/seed-portfolio.sh` (new), `deploy/docker/docker-compose.observe-host.yml` (new),
  `observability/prometheus/prometheus.observe-host.yml` (new), `observability/grafana/provisioning/datasources/datasources.yml`
  (env URLs), `deploy/docker/docker-compose.yml` (sets them), `Makefile` (observe-host targets, `SCREENSHOT_ARGS`,
  promtool check of the new config), `observability/screenshots/capture.py` (`--prefix`), this section.
  Checks: typecheck, eslint + prettier, promtool `check config` on both Prometheus configs.
- **docsqa**: `generation/llm.py` (streamed cost, `CallContext.feature`/app tag), `generation/answer.py` and
  `condense.py` (feature tags, attribution around retrieve/verify, 429/402 mapping), `inference/{attribution.py (new),_http.py,errors.py,embeddings.py,rerank.py,__init__.py}`
  (retry-after-aware 429, `InferenceRateLimitedError`/`InferenceBudgetError`, per-request headers, ingest tag),
  `cli.py` + `api/ingest_jobs.py` (ingest tag), `config.py` (`EVAL_JUDGE_API_KEY`), `evals/{cli,judge}.py`,
  `.env.example`, tests (`tests/fakes*.py`, `test_llm_client.py`, `test_inference_clients.py`, `integration/api/test_chat.py`,
  `evals/test_judge.py`). `make check`: 422 passed / 3 skipped, ruff + mypy clean.
- **opsagent**: `agent/src/opsagent/gateway.py` (new), `runtime.py` (GatewayChatOpenAI, tags, attribution
  http client, gateway health check), `api/routes/ops.py` (`/readyz`), `graph/runner.py` (attribution,
  actionable LLM errors), `tracing.py` (streamed cost), `config.py` (`EVAL_LLM_API_KEY`), `evals/runner.py`
  (eval key, judge tags), tests (`test_gateway_attribution.py` new, `test_tracing.py`, `test_gateway_mock.py`).
  `make agent-lint agent-test`: clean, 114 passed; `make evals-replay`: 38/40, 0 input-hash mismatches,
  vs baseline OK (report files moved out of the tree, `reports/latest.*` restored).

### For the orchestrator / devenv

- Nothing to make permanent: no worker is needed. Consumers now read DB keys from their `.env`; re-run
  `scripts/seed-portfolio.sh` after a DB reset.
- Scratch teams `o-scratch`, `o-ratelimit` are soft-deleted (slugs reserved, usage rows kept).
- The opsagent dev store was reset twice (`pnpm reset`) for the traffic runs.

### O2: dashboards, dogfooding, portfolio story

O2 ran 2026-10-27 20:23–21:40 IST against the stable gateway (d9db543, restarted ~20:13, so its
Prometheus counters start then).

**Traffic session** (scripts from O: DocsQA API driver with personas, OpsAgent Agent API driver with
approvals; servers on 127.0.0.1:8011 / 8100 / 8200 / 8300, all stopped afterwards):

- DocsQA, team `docsqa`, `mock-chat`: 5 rounds × 54 turns (4 personas × 12 questions + follow-ups, ⅔
  streamed). The follow-ups condense through `docsqa-fast` (real Claude Haiku): 2 cache misses in the
  first round, cache hits afterwards.
- DocsQA, team `docsqa`, `docsqa-chat`: O's "real" plan replayed (5 turns), all exact-cache hits
  ($0.0668 saved, 0 upstream calls).
- Evals, team `evals`: DocsQA offline tier twice (39/50 both times, = O's run and the baseline) and
  full tier `--ids q001,q002` (2/2; chat from the gateway's exact cache, verdicts from DocsQA's judge
  cache; 0 upstream calls).
- OpsAgent, team `opsagent`: the 7 scripted scenarios (3 with approval decisions incl. a senior approval
  and a reject) through the hidden `opsagent-scripted` route, 5 times (the opsagent dev store was reset
  with `pnpm reset` before each), plus one real `opsagent-chat` run ("What's the
  status of ORD-20004?", 2 calls, 2 tool calls). Its `run_finished.cost_usd` 0.02415
  (`cost_source: gateway`) = `sum(cost_usd)` of its two `usage_events` rows (0.0241497).
- The 2 `mock-tools` rows at 21:27 are the opsagent agent test suite (`make agent-test`), not traffic.

Session by team/route/cache (`select team, route, provider, cache, count(*), sum(cost_usd), sum(saved_usd)
from usage_events where ts > '2026-10-27 20:22:57+05:30' group by 1,2,3,4`):

```text
   team   |       route       | provider | cache  | count |   cost   |  saved
----------+-------------------+----------+--------+-------+----------+----------
 docsqa   | docsqa-chat       | copilot  | hit    |     5 | 0.000000 | 0.066847
 docsqa   | docsqa-embed      | local    | hit    |   526 | 0.000000 | 0.000000
 docsqa   | docsqa-embed      | local    | miss   |     4 | 0.000000 | 0.000000
 docsqa   | docsqa-fast       | copilot  | hit    |    29 | 0.000000 | 0.012719
 docsqa   | docsqa-fast       | copilot  | miss   |     2 | 0.000858 | 0.000000
 docsqa   | mock-chat         | mock     | bypass |   250 | 0.327880 | 0.000000
 evals    | docsqa-chat       | copilot  | hit    |     2 | 0.000000 | 0.019178
 evals    | docsqa-embed      | local    | hit    |   188 | 0.000000 | 0.000000
 evals    | mock-chat         | mock     | bypass |    92 | 0.101560 | 0.000000
 opsagent | mock-tools        | mock     | bypass |     2 | 0.002225 | 0.000000
 opsagent | opsagent-chat     | copilot  | miss   |     2 | 0.024150 | 0.000000
 opsagent | opsagent-scripted | local    | bypass |    90 | 0.000000 | 0.000000
(12 rows)
```

**Copilot upstream calls used by O2: 4** (2 `docsqa-fast` condense calls, 2 `opsagent-chat`); O + O2 = 16
of the 20 planned for the wave.

```text
$ PGPASSWORD=dev psql -h localhost -U dev -d llmgateway -c "select team,route,count(*) from usage_events where provider='copilot' and cache='miss' and ts > '2026-10-27 20:22:57+05:30' group by 1,2"
   team   |     route     | count
----------+---------------+-------
 docsqa   | docsqa-fast   |     2
 opsagent | opsagent-chat |     2
(2 rows)
```

**Screenshots** (`make observe-host-up`, then under the build lock
`make screenshots GRAFANA_URL=http://127.0.0.1:3302 SCREENSHOT_ARGS="--prefix=dev- --range now-1h"` at
21:22; each PNG opened and checked):

- `observability/screenshots/dev-switchyard-cost.png`: spend $0.3206 and cache savings $0.0110 in the hour,
  month-to-date $2.2538, spend rate by team / route / provider-model with all three teams, budget gauges
  docsqa 1.0 % / evals 1.0 % / opsagent 1.5 %, the budget table ($0.4864 / $1.0209 / $0.7465 of
  $50 / $100 / $50), top keys (`portfolio-docsqa` 816, `portfolio-evals` 282, `portfolio-opsagent` 92
  requests), spend by model.
- `observability/screenshots/dev-switchyard-overview.png`: requests/s by route, all 200s, p50/p95/p99,
  TTFT for docsqa-chat / mock-chat / opsagent-chat / opsagent-scripted, cache hit ratio by route,
  tokens/s, process memory and CPU.
- `observability/screenshots/dev-switchyard-providers.png`: upstream latency per provider/model (Copilot
  Sonnet and Haiku, local embeddinggemma, mock), attempts by outcome (all ok), all breakers closed;
  fallbacks / retries / 429-5xx panels are empty (nothing failed in that hour).
- Prometheus missed samples around 20:43–20:55 (visible as a hole in the breaker timeline and the
  process panels). Documented in [OBSERVABILITY.md](OBSERVABILITY.md#from-the-dev-gateway-real-traffic-2026-10-27).

**Budgets** (`GET /admin/teams/:id/budget`, admin token, 21:23 IST):

```text
GET /admin/teams/docsqa/budget
{"team":"docsqa","as_of":"2026-10-27T15:53:28.580Z","spend":{"daily":0.4864,"monthly":0.4864,"persisted":{"daily":0.4863997,"monthly":0.4863997}},"budgets":[{"period":"monthly","period_key":"202610","period_start":"2026-10-01T00:00:00.000Z","period_end":"2026-11-01T00:00:00.000Z","limit_usd":50,"spent_usd":0.4864,"remaining_usd":49.5136,"utilization":0.0097,"projected_usd":0.565536,"projected_utilization":0.0113,"soft_threshold":0.8,"action":"block","status":"ok"}]}
GET /admin/teams/opsagent/budget
{"team":"opsagent","as_of":"2026-10-27T15:53:28.591Z","spend":{"daily":0.74645,"monthly":0.74645,"persisted":{"daily":0.7464502,"monthly":0.7464502}},"budgets":[{"period":"monthly","period_key":"202610","period_start":"2026-10-01T00:00:00.000Z","period_end":"2026-11-01T00:00:00.000Z","limit_usd":50,"spent_usd":0.74645,"remaining_usd":49.25355,"utilization":0.0149,"projected_usd":0.867896,"projected_utilization":0.0174,"soft_threshold":0.8,"action":"block","status":"ok"}]}
GET /admin/teams/evals/budget
{"team":"evals","as_of":"2026-10-27T15:53:28.603Z","spend":{"daily":1.020902,"monthly":1.020902,"persisted":{"daily":1.0209019,"monthly":1.0209019}},"budgets":[{"period":"monthly","period_key":"202610","period_start":"2026-10-01T00:00:00.000Z","period_end":"2026-11-01T00:00:00.000Z","limit_usd":100,"spent_usd":1.020902,"remaining_usd":98.979098,"utilization":0.0102,"projected_usd":1.187,"projected_utilization":0.0119,"soft_threshold":0.8,"action":"block","status":"ok"}]}
```

**Prometheus** (`GET :9092/api/v1/query`, 21:23 IST; counters since the gateway restart):

```text
## sum by (team) (sy_cost_usd_total)
  {'team': 'docsqa'} 0.3287379999999998
  {'team': 'evals'} 0.10156000000000003
  {'team': 'opsagent'} 0.0241497
## sum by (team) (sy_tokens_total)
  {'team': 'docsqa'} 638790
  {'team': 'opsagent'} 381373
  {'team': 'evals'} 194904
## sum by (team) (sy_cache_saved_usd_total)
  {'team': 'docsqa'} 0.07956619999999999
  {'team': 'evals'} 0.0191783
## sum by (team, provider) (sy_cost_usd_total)
  {'provider': 'mock', 'team': 'docsqa'} 0.3278799999999998
  {'provider': 'copilot', 'team': 'docsqa'} 0.000858
  {'provider': 'mock', 'team': 'evals'} 0.10156000000000003
  {'provider': 'copilot', 'team': 'opsagent'} 0.0241497
## max by (team, period) (sy_budget_utilization_ratio)
  {'period': 'monthly', 'team': 'docsqa'} 0.009727994
  {'period': 'monthly', 'team': 'opsagent'} 0.014929004
  {'period': 'monthly', 'team': 'evals'} 0.010209019
## sum by (team) (increase(sy_cost_usd_total[1h]))
  {'team': 'docsqa'} 0.2632481375367109
  {'team': 'evals'} 0.05097021372231591
  {'team': 'opsagent'} 0.00622055928141753
```

**observe-host stack**: `make observe-host-down` (volumes **dropped**); the two images it pulled
(prom/prometheus v3.15.1, grafana/grafana 13.2.4, ≈ 2.3 GB) were removed afterwards to keep the disk
above 11 GB. Heavy and build locks released.

**Dogfooding queries** (21:24 IST; the ledger starts at the first recorded request, 2026-10-27 11:02:08
IST, and the last one counted is 21:22:34 IST; all on the UTC day 2026-10-27, so `from=2026-10-01&to=2026-10-27`
covers everything):

```bash
for g in team route model provider; do
  curl -s "http://127.0.0.1:8787/admin/usage?group_by=$g&from=2026-10-01&to=2026-10-27" -H "Authorization: Bearer $SWITCHYARD_ADMIN_TOKEN"
done
```

```text
group_by=team  (query {"from": "2026-10-01", "to": "2026-10-27", "groupBy": "team"})
group                requests errors cache_hits prompt_tok compl_tok   cost_usd saved_usd
evals                    1225      0        680     921313     53198  1.0209019 0.0859641
opsagent                  294      1          2    1395851     55452  0.7464502 0.0231822
docsqa                   1108      1        704     843452     14694  0.4863997 0.0897517
o-ratelimit                21     12          2       2940        75  0.0014945 0.0000000
o-scratch                  10      7          1         36         0  0.0000000 0.0000000

group_by=route  (query {"from": "2026-10-01", "to": "2026-10-27", "groupBy": "route"})
group                requests errors cache_hits prompt_tok compl_tok   cost_usd saved_usd
mock-chat                 644      4          0    1444203     25546  0.7604205 0.0000000
opsagent-chat             116      0          2     847473     24410  0.5478377 0.0231822
docsqa-chat                68      2         14     171785     13232  0.4794761 0.1539588
docsqa-judge               79      0          2     121661     29140  0.2673610 0.0090380
opsagent-judge             40      0          0      66645     21055  0.1719200 0.0000000
mock-tools                 26      2          0      51604       576  0.0266660 0.0000000
docsqa-fast                32      0         29       1275        58  0.0015650 0.0127190
docsqa-embed             1542     12       1342      28843         0  0.0000000 0.0000000
opsagent-scripted         111      1          0     430103      9402  0.0000000 0.0000000

group_by=model  (query {"from": "2026-10-01", "to": "2026-10-27", "groupBy": "model"})
group                requests errors cache_hits prompt_tok compl_tok   cost_usd saved_usd
claude-sonnet-5.5         182      0         16    1019258     37642  1.0273138 0.1771410
mock-extractive           640      0          0    1444203     25546  0.7604205 0.0000000
claude-haiku-4.5          151      0         31     189581     50253  0.4408460 0.0217570
mock-tools                 24      0          0      51604       576  0.0266660 0.0000000
embeddinggemma-300m      1531      1       1342      28843         0  0.0000000 0.0000000
opsagent-scripted         110      0          0     430103      9402  0.0000000 0.0000000
(none)                     20     20          0          0         0  0.0000000 0.0000000

group_by=provider  (query {"from": "2026-10-01", "to": "2026-10-27", "groupBy": "provider"})
group                requests errors cache_hits prompt_tok compl_tok   cost_usd saved_usd
copilot                   333      0         47    1208839     87895  1.4681598 0.1988980
mock                      664      0          0    1495807     26122  0.7870865 0.0000000
local                    1641      1       1342     458946      9402  0.0000000 0.0000000
(none)                     20     20          0          0         0  0.0000000 0.0000000

totals: {"requests": 2658, "errors": 21, "cache_hits": 1389, "prompt_tokens": 3163592, "cached_tokens": 790383, "completion_tokens": 123419, "reasoning_tokens": 1812, "cost_usd": 2.2552463, "saved_usd": 0.198898}
```

The admin usage API has no fallback column, so fallbacks come from the ledger:

```text
$ psql … -c "select min(ts) first, max(ts) last, count(*) requests, sum(fallbacks) fallbacks, count(*) filter (where fallbacks>0) requests_with_fallback, sum(cost_usd) from usage_events" \
          -c "select team, count(*) filter (where fallbacks>0), sum(fallbacks) from usage_events group by 1" \
          -c "select route, provider, model, fallbacks, count(*) from usage_events where fallbacks>0 group by 1,2,3,4" \
          -c "select sum(requests) daily_requests from usage_daily"
             first             |             last             | requests | fallbacks | requests_with_fallback | cost_usd
-------------------------------+------------------------------+----------+-----------+------------------------+----------
 2026-10-27 11:02:08.341+05:30 | 2026-10-27 21:22:34.96+05:30 |     2658 |         0 |                      0 | 2.255246
(1 row)

    team     | req_with_fallback | fallbacks
-------------+-------------------+-----------
 docsqa      |                 0 |         0
 evals       |                 0 |         0
 opsagent    |                 0 |         0
 o-ratelimit |                 0 |         0
 o-scratch   |                 0 |         0
(5 rows)

 route | provider | model | fallbacks | count
-------+----------+-------+-----------+-------
(0 rows)

 daily_requests
----------------
           2658
(1 row)
```

Errors in the ledger (`status >= 400`): o-ratelimit 12 × 429, o-scratch 7 × 402 (O's failure tests),
docsqa 1 × 499 `request_aborted` (embeddings, client disconnect), opsagent 1 × 502 on `opsagent-scripted`
at 14:57 (scripted server not running). The README table derives tokens = prompt + completion and cache
hit ratio = cache_hits / requests from these rows.

**Changes by O2:**

- **llm-gateway**: `README.md` (link to the dev screenshots under Observability, new **Dogfooding**
  section after Benchmarks, **Part of a three-project portfolio** section before License),
  `docs/OBSERVABILITY.md` ("From the dev gateway" subsection with the three `dev-*` screenshots, how to
  read them and how to reproduce), `observability/screenshots/dev-switchyard-{overview,cost,providers}.png`
  (new), this section (renamed from "Cross-project (O) — paused").
- **docsqa**: `docs/DEPLOYMENT.md` ("Failure modes at the gateway boundary": 402 / 429 / gateway down,
  before/after, link to the gateway error contract), `README.md` (configuration row for
  `LLM_API_KEY`/`EVAL_JUDGE_API_KEY` with `seed-portfolio.sh`, portfolio section at the end),
  `docs/STATUS.md` (cross-project section). `.env.example` already mentioned the script.
- **opsagent**: `docs/DEPLOYMENT.md` (same failure-modes subsection; the `LLM_PRICE_*` paragraph now says
  run cost comes from the gateway, `cost_source: gateway`), `docs/ARCHITECTURE.md` (the "LLM gateway
  errors" row names the gateway codes and links the subsection), `agent/.env.example` (`seed-portfolio.sh`
  comment, `EVAL_LLM_API_KEY=`), `README.md` (configuration row for the keys, portfolio section at the end),
  `docs/STATUS.md` (cross-project section). No code, prompt, model-input or eval-baseline changes in any
  repo, so the OpsAgent replay tier is unaffected.

**Checks (O2, after the changes):** llm-gateway `pnpm typecheck` (exit 0) and `pnpm lint` (eslint +
`prettier --check .`: "All matched files use Prettier code style!"); docsqa `make check`: ruff "All checks
passed!", mypy "no issues found in 89 source files", **422 passed, 3 skipped**; opsagent
`make agent-lint agent-test`: ruff clean, mypy "no issues found in 69 source files", **114 passed**;
`devenv/bin/leakscan.sh` clean on all three (356 / 429 / 482 files + history).

**Left running:** nothing (servers killed by port, observe-host down, locks released).

## Wave 7 R9 — examples + runtimes

Runnable SDK examples, one command to check them all, and a verified runtime matrix. Branch
`feat/examples` (worktree `llm-gateway-examples`). No gateway code changed.

### Examples (`examples/`)

| Example            | Pinned versions                                                    | Covers                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-node`      | `openai` 7.45.1                                                    | chat + `usage.cost`, stream with the final cost chunk, embeddings + `input_type`, tool round trip, `json_schema`, `withResponse()` headers, `AuthenticationError` |
| `openai-python`    | `openai` 3.40.0 (PEP 723, `uv run --script`)                       | the same core; headers via `with_raw_response`, `input_type` via `extra_body`                                                                                     |
| `vercel-ai-sdk`    | `ai` 7.0.154, `@ai-sdk/openai-compatible` 3.0.79, `zod` 4.6.7      | `generateText` (+ response headers), `streamText`, a two-step tool call, `embedMany`, cost via a `metadataExtractor`                                              |
| `langchain-python` | `langchain-openai` 1.7.3, `langchain-core` 1.7.0 (OpsAgent's pins) | `ChatOpenAI(base_url)`, `include_response_headers`, `stream_usage`, `bind_tools` round trip, `OpenAIEmbeddings`                                                   |
| `langchain-js`     | `@langchain/openai` 1.7.1, `@langchain/core` 1.3.0, `zod` 4.6.7    | `configuration.baseURL`, `bindTools` round trip, `withStructuredOutput` (`jsonSchema`)                                                                            |
| `curl`             | curl + jq                                                          | rerank, `x-sy-cache` default/bypass/refresh, `x-sy-user` / `x-sy-tags`, 401/404/400, and with the platform 402 + 429                                              |
| `library-hono`     | `hono` 4.13.14, `@hono/node-server` 2.1.5, the packed gateway      | `createGateway` mounted under `/llm`, a custom `UsageSink` (cost per `x-sy-user`), Node / `Bun.serve` / `Deno.serve`                                              |

- Versions are the current releases on 2026-10-28 (npm / PyPI). The JS examples commit a
  `package-lock.json` and install with `npm ci` into their own folder; nothing was added to the
  root pnpm lockfile. `library-hono` installs `switchyard-gateway` from a `pnpm pack` tarball of the
  checkout (`examples/.pack`, gitignored) and has no lockfile (`.npmrc`), because the tarball's
  integrity changes with every build.
- `examples/config/gateway.examples.yaml` is mock-only: the standalone mock provider as an
  `openai-compatible` upstream (so the real HTTP adapter is exercised), plus an in-process mock
  with a JSON `fixed_text` for the `structured` route. The mock does not enforce JSON schemas;
  the examples show the request shape and parsing.
- The TypeScript examples run as plain `.ts` (Node type stripping, Node ≥ 22.18; Bun and Deno
  natively). They type-check with the root `tsc` 6.0.3 in strict mode (ad hoc tsconfig, exit 0).
  ESLint lints `examples/**/*.ts` without type information (`eslint.config.js`), and
  `.prettierignore` skips the example lockfiles. The Python examples pass `ruff check` and
  `ruff format`; both shell scripts pass shellcheck.

### `examples/run-all.sh`

Installs the example dependencies, packs the gateway, starts `switchyard mock-provider` and
`switchyard serve` on free ports in 18700–18799, runs every example, checks each success line and
that the attribution headers reached the usage events (gateway log, or the Redis stream with
`--platform`), checks that the gateway logged no error, then kills what it started (by PID) and
exits non-zero on any failure (checked with `--only curl,bogus` → exit 1). Options:
`--platform` (Redis db 1 with a random key prefix that is deleted afterwards, Postgres
`llmgateway_test` with the migrations applied to `public`; the curl example creates and
soft-deletes two throwaway teams), `--runtime node|bun|deno`, `--only a,b`. About 9 s for all
seven examples once the dependencies are installed.

Results (2026-10-28, all exit 0, every example PASS, attribution PASS):

| Runtime (gateway, mock, TS examples) | Platform off | `--platform` (402 + 429 included) |
| ------------------------------------ | ------------ | --------------------------------- |
| Node 24.20.0                         | 7/7          | 7/7                               |
| Node 22.23.4 (checksum-verified)     | –            | 7/7                               |
| Bun 1.3.14                           | 7/7          | 7/7                               |
| Deno 2.9.8                           | 7/7          | 7/7                               |

### Runtime probe (beyond the examples)

For each of Node 24.20.0, Bun 1.3.14 and Deno 2.9.8 (`deno run -A` on `dist/cli.js`, packages
from `node_modules`; Deno installed into `~/.local/bin` from the v2.9.8 release zip, SHA-256
verified):

- `switchyard --version` (0.1.0), `init`, `validate-config`: identical output.
- `serve` with Redis and Postgres: `/readyz` reports both OK; three streamed requests return 200;
  `/metrics` serves `sy_requests_total`; SIGHUP logs "config reloaded"; SIGTERM logs "shutdown
  complete" and exits 0 within 30 ms.
- `switchyard worker` on the same runtime: 3 events read and 3 inserted into `usage_events`;
  exits 0 on SIGTERM.
- An oversized body (12 MB) gets 413 on all three.
- The installed tarball's CLI (`node_modules/switchyard-gateway/dist/cli.js`) runs on Bun and Deno,
  and `library-hono` also works with `USE_NODE_SERVER=1` (`@hono/node-server`) on both.
- **Client disconnect before the first byte** (mock latency 1.5 s, `curl --max-time 0.5`):

  | Server                        | Node | Bun                | Deno |
  | ----------------------------- | ---- | ------------------ | ---- |
  | `switchyard serve` (CLI)      | 499  | **200** (not seen) | 499  |
  | `@hono/node-server` + library | 499  | **200** (not seen) | 499  |
  | `Bun.serve` / `Deno.serve`    | –    | 499                | 499  |

  A minimal `node:http` server reproduces it without the gateway: on Bun the request's `close`
  event fires only after the response is written (`aborted=false`), on Node and Deno immediately
  (`aborted=true`). Fixing it in the gateway would mean a Bun-specific server path in
  `startServer` (draining, shutdown, metrics port), which is not a tiny change, so it is
  documented instead (README "Runtime support", LIBRARY.md, Known gaps).

- Deno's `Deno.serve` prints a one-time notice about its legacy `request.signal` behaviour (the
  signal also aborts after a successful response). Streams and usage are unaffected (full stream,
  `[DONE]`, usage 200 in the probe).

### Not covered

- `deno run npm:switchyard-gateway` and `bunx switchyard-gateway` from the registry: the package is
  not published yet. The tarball install covers the same files.
- LlamaIndex and LiteLLM-as-client were skipped: both reach the gateway through the same
  OpenAI-compatible clients shown above.
- The gateway's own test suite was not run under Bun or Deno (vitest on Node only).

### Docs

README: "Examples" section (table) and "Runtime support" table after "As a library"; the feature
bullet links the examples. LIBRARY.md: Bun/Deno note with the `Bun.serve` advice.
`examples/README.md` plus one README per example, with real expected output.
