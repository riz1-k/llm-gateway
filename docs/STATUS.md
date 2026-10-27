# Switchyard status

_Last updated: 2026-10-27, after the release wave (M: npm package, release engineering,
benchmarks, docs). The infra was built in wave K, the platform in wave H and the core in wave G._

## What exists

The core gateway and the platform layer are built. With `redis.url` / `database.url` set, the
gateway uses:

- Postgres teams and virtual keys
- Redis rate limits, budgets, exact and semantic cache, and shared breakers
- a usage stream with a Postgres worker
- the admin API and CLI
- Prometheus metrics

Without them, it falls back to the in-memory core implementations.

| Area          | State                                                                                                                                                                                                                                                                                            | Where                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Monorepo      | pnpm 11 workspace, TS 6 strict ESM, eslint flat (type-aware) + prettier, vitest 5, tsdown                                                                                                                                                                                                        | root                                    |
| Config        | YAML + `${ENV}` / `${ENV:-default}` interpolation, zod schema, cross-reference checks with paths, pricing file, SIGHUP / `POST /admin/config/reload` hot reload (ref-counted snapshots)                                                                                                          | `packages/gateway/src/config/`          |
| HTTP API      | `/v1/chat/completions` (JSON + SSE, `include_usage`), `/v1/embeddings` (+ `input_type` templates), `/v1/rerank`, `/v1/models`, `/healthz`, `/readyz` (`?probe=1`), `/admin/providers/health`, OpenAI error envelope, `x-sy-*` headers, request id, pino logs, body limit, graceful drain         | `src/app.ts`, `src/server.ts`           |
| Pipeline      | auth → validate → route → defaults → estimate → RateLimiter → BudgetGuard → CacheStore → Router → account → UsageSink                                                                                                                                                                            | `src/core/pipeline.ts`                  |
| Router        | fallback / weighted (smooth WRR) / least-latency (EWMA, ε-explore); retries with full jitter + Retry-After cap; per-attempt + route deadline; circuit breaker (pure `decide`/`record` + `MemoryBreakerStore`); per-provider FIFO semaphores; streaming fallback until the first meaningful chunk | `src/core/router.ts`, `src/resilience/` |
| Providers     | `opencode` (full emulation + real `/event` streaming), `openai-compatible` (chat, embeddings, rerank), `openai`, `anthropic` (Messages translation incl. streaming tool use), `mock` (in-process)                                                                                                | `src/providers/`                        |
| Mock provider | standalone deterministic OpenAI-compatible server with header/flag fault injection; bundled into the gateway package as `switchyard-gateway/mock-provider`                                                                                                                                       | `packages/mock-provider/`               |
| CLI           | `serve`, `worker`, `migrate`, `validate-config`, `mock-provider`, admin: `teams`, `keys`, `budgets`, `usage`, `cache purge`, `seed-dev` (local mode via `--config`, remote via `--url` + admin token)                                                                                            | `src/cli.ts`, `src/cli/`                |
| Database      | drizzle-orm schema + drizzle-kit migration (hand-edited: `usage_events` monthly range partitions, `sy_ensure_usage_partition()`), `switchyard migrate` with advisory lock                                                                                                                        | `src/db/`, `drizzle/`                   |
| Keys & teams  | `PlatformKeyStore`: static → local cache → Redis (60 s, negative 10 s) → Postgres; pub/sub invalidation; batched `last_used_at`; `sk-sy-` + 40 base62 generator                                                                                                                                  | `src/auth/db-key-store.ts`              |
| Rate limits   | `RedisRateLimiter`: sliding-window RPM/TPM × key/team in one Lua call (all-or-nothing), TPM reserve + reconcile, `x-ratelimit-*` / `retry-after(-ms)`                                                                                                                                            | `src/limits/`                           |
| Budgets       | `RedisBudgetGuard` + `DbBudgetSource`: daily/monthly counters, pre-flight 402, soft/exceeded alerts (SET NX + webhook), reconciliation from `usage_daily`, linear projection                                                                                                                     | `src/limits/`, `src/usage/reconcile.ts` |
| Cache         | `RedisCacheStore` (gzip ≥ 512 B, MGET/pipelined SET), per-item embedding cache, streaming replay, `RedisVectorIndex` semantic cache (Redis 8 vector sets)                                                                                                                                        | `src/cache/`                            |
| Breakers      | `RedisBreakerStore`: CAS Lua over the pure state machine, per-target coalescing queue, 1 s local cache of closed state, local fallback                                                                                                                                                           | `src/resilience/redis-breaker.ts`       |
| Usage         | `RedisStreamUsageSink` (XADD MAXLEN ~, memory buffer, drop metric) → `UsageWorker` (XREADGROUP, single-statement idempotent insert + rollup, XAUTOCLAIM, dead-letter, partitions/retention, budget reconcile)                                                                                    | `src/usage/`                            |
| Admin API     | SPEC §12 under `/admin`: teams CRUD, keys create/list/revoke/rotate, budgets, budget status, usage reports, cache purge, audit log, redacted config; every mutation audit-logged in the same transaction                                                                                         | `src/admin/`                            |
| Metrics       | `PromMetrics` (all SPEC §13 names + extras), `/metrics` on the API port or `metrics.port`; worker metrics on `--port`                                                                                                                                                                            | `src/observability/metrics.ts`          |
| Dev tooling   | `Makefile`, `scripts/dev.sh`, `scripts/smoke_openai_sdk.py`, `.env.example`                                                                                                                                                                                                                      | root                                    |
| Docs          | `README.md`, `docs/{CONFIG (generated),API,LIBRARY,ARCHITECTURE,RELEASING,ADMIN,METRICS,DEPLOYMENT,OBSERVABILITY}.md`, `docs/adr/` (6 ADRs), `docs/opencode-bridge.md`, `CONTRIBUTING.md`, `SECURITY.md`, this file                                                                              |                                         |
| Release       | npm package `switchyard-gateway` (CLI `switchyard`, library, `./mock-provider`, `./config.schema.json`), Changesets + `release.yml` (npm trusted publishing, GitHub Packages, GitHub Release, GHCR), pack smoke, verdaccio e2e, k6 benchmarks                                                    | see [Release](#release-wave-m)          |

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

- Workflow-level `permissions: contents: read`. Only the push job in `docker.yml` gets
  `packages: write`, `id-token: write` and `attestations: write`.
- No `pull_request_target`. Every action is pinned by commit SHA.
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
- **No signing of the published image** (cosign). GitHub build-provenance attestations and an
  SBOM are generated.
- **The GitHub workflows have not run on GitHub yet.** No push was made; they pass actionlint
  and every step was exercised locally.
- **Prometheus cost counters reset on pod restart.** `increase()` handles that, but long-range
  cost questions should use the Postgres panels.
- **`terraform.tfstate` for local-kind is local** (gitignored). It contains generated passwords
  while a cluster exists.

## Known gaps

- **No OpenTelemetry tracing** (SPEC §13 spans). Metrics and logs are done. `observability.otel`
  and `log_bodies` are accepted but documented as reserved.
- **Platform-on overhead is above the SPEC targets:** about 3.2–3.4 ms p50 on a miss and
  1.1–1.7 ms on a hit, against targets of 3 ms and 1 ms (bench/RESULTS.md). The cause is three
  sequential Redis round trips per request. The next steps (one combined limit-and-budget Lua
  call, non-blocking post-response writes) change semantics and were left for a later release.
- **Not published yet:** npm, GitHub Packages and GHCR wait for the owner's one-time setup
  (RELEASING.md). Bun and Deno are untested.
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
