# Switchyard administration

This guide covers the platform layer: Postgres-backed teams, keys, budgets and usage; Redis-backed
rate limits, cache, breakers and the usage stream; the admin API; and the CLI. For metric names
and dashboard queries see [METRICS.md](METRICS.md).

## 1. Enable the platform

The platform turns on when the config sets `redis.url` and/or `database.url` (see
`config/gateway.example.yaml` for every option):

| Configured     | What you get                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| neither        | The in-memory core: static keys only, no limits or budgets, no cache, usage goes to logs.                                                                            |
| `redis.url`    | RPM/TPM rate limits, exact and semantic response cache, circuit breakers shared by all replicas, and the usage stream.                                               |
| `database.url` | DB virtual keys and teams, plus the admin data API.                                                                                                                  |
| both           | Everything above, plus budgets (Redis counters with definitions in Postgres), pub/sub key revocation, and usage persisted by the worker. This is the intended setup. |

```bash
switchyard migrate --config gateway.yaml        # or: --database-url postgres://…   (idempotent, advisory-locked)
switchyard serve   --config gateway.yaml
switchyard worker  --config gateway.yaml --port 9465   # usage stream → Postgres (+ /metrics on :9465)
```

- **Single-process dev setups:** set `usage.in_process_writer: true`, and the gateway runs the
  worker loop itself. `config/gateway.local.yaml` does this.
- **Readiness:** `/readyz` returns 503 until Redis and Postgres both answer a ping.
- **Migrations** live in `packages/gateway/drizzle/` and ship in the npm package. Change
  `src/db/schema.ts`, then run `pnpm --filter switchyard-gateway db:generate` and review the SQL.
  `usage_events` is partitioned by hand-edited SQL that drizzle-kit cannot express.

## 2. Keys and authentication

| Credential              | Format                                           | Where it lives                                                                                    |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Virtual key** (DB)    | `sk-sy-` + 40 base62 chars (238 bits of entropy) | Postgres stores only the SHA-256 hash plus a 12-char display prefix. The plaintext is shown once. |
| **Static key** (config) | anything                                         | `auth.static_keys` (bootstrap / CI). Attributed to the DB team with the same slug if one exists.  |
| **Admin token**         | anything (use ≥ 32 random chars)                 | `auth.admin_token` → `Authorization: Bearer …` on `/admin/*`. Empty disables admin.               |

- **Lookup order:** static keys, then the per-process cache (`auth.local_key_cache_ttl_ms`,
  default 5 s), then the Redis record cache `key:{sha256}` (`auth.key_cache_ttl_s`, default
  60 s; unknown keys are negatively cached for 10 s), then Postgres.
- **Database down:** an unknown key returns **503**, not 401, and static keys keep working.
- **Revocation and rotation** delete the Redis record and broadcast on `<prefix>invalidate`, so
  every replica drops the key immediately.
- **Rotation** issues a new key. The old one is revoked immediately, or after `grace_s` seconds.
- **`last_used_at`** is written in batches every 30 s, not on every request.
- **Per-key restrictions:** `allowed_routes` (a route allow-list, `null` = all), `rpm_limit` /
  `tpm_limit` (override the team and config defaults) and `expires_at`.
- **Actor attribution:** every mutation writes an `audit_log` row in the same transaction. The
  actor is `api`, or `api:<x-sy-actor header>` when that header is sent. CLI local mode uses
  `cli:<os user>`, and CLI remote mode sends `x-sy-actor: cli-<os user>`.

## 3. Admin API

All endpoints are under `/admin` and need `Authorization: Bearer <admin_token>`. Every `:id`
accepts the team UUID or its slug. Errors use the OpenAI envelope (`400 invalid_request` with
`param`, `404 not_found`, `409 conflict`, `503 service_unavailable`).

| Method & path            | Body / query                                                                                                         | Returns                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /teams`            | `{slug, name?, rpm_limit?, tpm_limit?, metadata?, budgets?: {daily?, monthly?}}`                                     | 201 team (409 if the slug exists, including soft-deleted teams)                                                                                                                                      |
| `GET /teams`             | `?include_deleted=true`                                                                                              | `{data: [team]}` with key counts and budgets                                                                                                                                                         |
| `GET /teams/:id`         |                                                                                                                      | team                                                                                                                                                                                                 |
| `PATCH /teams/:id`       | `{name?, rpm_limit?, tpm_limit?, metadata?}` (`null` clears a limit)                                                 | team                                                                                                                                                                                                 |
| `DELETE /teams/:id`      |                                                                                                                      | Soft delete. Revokes every key of the team. The slug stays reserved.                                                                                                                                 |
| `POST /teams/:id/keys`   | `{name?, allowed_routes?, rpm_limit?, tpm_limit?, expires_at? \| expires_in_days?, metadata?}`                       | 201 `{key, record}`. **`key` is the only time the plaintext is shown.**                                                                                                                              |
| `GET /teams/:id/keys`    | `?include_revoked=true`                                                                                              | `{data: [record]}`, masked (`sk-sy-AbCdEf…`), with `status` active / revoked / expired                                                                                                               |
| `POST /keys/:id/revoke`  |                                                                                                                      | record                                                                                                                                                                                               |
| `POST /keys/:id/rotate`  | `{grace_s?: 0..2592000}`                                                                                             | `{key, record, previous}` (`record.rotated_from` = old id)                                                                                                                                           |
| `PUT /teams/:id/budgets` | `{daily?: B \| null, monthly?: B \| null}`, B = `{limit_usd, soft_threshold=0.8, action=block\|alert, webhook_url?}` | `{data: [budget]}`. `null` removes that period; an omitted period is unchanged.                                                                                                                      |
| `GET /teams/:id/budget`  |                                                                                                                      | Live spend per period: `spent_usd, remaining_usd, utilization, projected_usd` (linear), `status` ok / soft / exceeded, plus the persisted Postgres spend                                             |
| `GET /usage`             | `?team&route&model&from=YYYY-MM-DD&to=YYYY-MM-DD&group_by=day\|team\|route\|model\|provider\|key`                    | `{rows: [{group, label, requests, errors, cache_hits, *_tokens, cost_usd, saved_usd, avg_latency_ms}], totals}` from `usage_daily` (`group_by=key` reads `usage_events`). Defaults to month-to-date. |
| `POST /cache/purge`      | `{route?, team?}`                                                                                                    | `{deleted}`: number of removed exact cache entries and semantic sets                                                                                                                                 |
| `GET /audit`             | `?limit=50`                                                                                                          | `{data: [{id, at, actor, action, target, data}]}`, newest first                                                                                                                                      |
| `GET /config`            |                                                                                                                      | Effective config with secrets redacted                                                                                                                                                               |
| `POST /config/reload`    |                                                                                                                      | Hot reload (same as SIGHUP)                                                                                                                                                                          |
| `GET /providers/health`  |                                                                                                                      | Breaker states, EWMA latency, error rates, concurrency                                                                                                                                               |

```bash
A="Authorization: Bearer $SWITCHYARD_ADMIN_TOKEN"; G=http://localhost:8787
curl -s -XPOST $G/admin/teams -H "$A" -H 'content-type: application/json' \
  -d '{"slug":"docsqa","name":"DocsQA","budgets":{"monthly":{"limit_usd":50}}}'
curl -s -XPOST $G/admin/teams/docsqa/keys -H "$A" -H 'content-type: application/json' \
  -d '{"name":"local","allowed_routes":["docsqa-chat","docsqa-embed"]}'      # → {"key":"sk-sy-…", …}
curl -s $G/admin/teams/docsqa/budget -H "$A"
curl -s "$G/admin/usage?group_by=route&team=docsqa" -H "$A"
```

## 4. CLI

The CLI runs admin commands in two modes:

- **Local mode** (`--config gateway.yaml`) talks to Postgres and Redis directly. It works while
  the gateway is down.
- **Remote mode** (`--url http://gateway:8787 --admin-token …`, or the `SWITCHYARD_URL` /
  `SWITCHYARD_ADMIN_TOKEN` env vars) goes through the admin API.

Add `--json` to any command for machine-readable output.

```bash
switchyard teams create docsqa --name DocsQA --monthly-budget 50 [--daily-budget 5] [--rpm 600] [--tpm 2000000]
switchyard teams list | get <slug> | delete <slug>
switchyard keys create --team docsqa --name local [--routes docsqa-chat,docsqa-embed] [--rpm N] [--tpm N] [--expires-in-days 90]
switchyard keys list --team docsqa [--all]
switchyard keys revoke <key-id>
switchyard keys rotate <key-id> [--grace-s 3600]
switchyard budgets set --team docsqa --monthly 50 [--daily 5|none] [--soft 0.8] [--action block|alert] [--webhook URL]
switchyard budgets show --team docsqa
switchyard usage --team docsqa --from 2026-10-01 --to 2026-10-31 --group-by route
switchyard cache purge [--route docsqa-chat] [--team docsqa]
switchyard seed-dev [--rotate] [--output .env.gateway-keys]
```

### Development seed

`switchyard seed-dev` creates the portfolio teams (SPEC §17) and is idempotent:

| Team       | Monthly budget (USD, shadow) | Key name   | Env var                | Route allow-list                                                          |
| ---------- | ---------------------------- | ---------- | ---------------------- | ------------------------------------------------------------------------- |
| `docsqa`   | 50                           | `seed-dev` | `DOCSQA_GATEWAY_KEY`   | `docsqa-*` and `mock-*` (filtered to the routes that exist in the config) |
| `opsagent` | 50                           | `seed-dev` | `OPSAGENT_GATEWAY_KEY` | `opsagent-chat`, `opsagent-judge`, `mock-*`                               |
| `evals`    | 100                          | `seed-dev` | `EVALS_GATEWAY_KEY`    | all routes                                                                |

- **First run:** creates the teams, budgets and keys and prints `ENV_VAR=sk-sy-…` lines once.
- **Later runs:** report `exists` and print no keys, because plaintexts cannot be retrieved.
- **`--rotate`:** issues fresh keys.
- **`--output <file>`:** writes the env lines to a mode-0600 file instead of stdout. Point the
  consumer projects' `.env` at it.

## 5. Rate limits

- **Algorithm:** a sliding-window counter (current plus weighted previous window,
  `limits.window_s`, default 60 s) for **RPM** and **TPM** at **key** and **team** scope.
  All four are checked and incremented together in one atomic Lua call, so concurrent requests
  cannot overshoot; this is covered by a 100-parallel-calls test.
- **Limit resolution:** the key record's `rpm_limit`/`tpm_limit`, else `limits.defaults.key`.
  The team record, else `limits.defaults.team`.
- **TPM** reserves the pre-flight estimate (prompt tokens + `max_tokens`, or the route default)
  and is reconciled to actual usage after the response. Requests rejected by a budget release
  their reservation.
- **Headers** describe the tightest scope:
  - `x-ratelimit-limit-requests|tokens`
  - `x-ratelimit-remaining-requests|tokens`
  - `x-ratelimit-reset-requests|tokens` in OpenAI duration format, e.g. `1m9s`. This is the time
    until the counter fully drains, which with a sliding window can be up to 2× the window.
  - On 429 only: `retry-after` (seconds) and `retry-after-ms`, the time until this request
    would fit.
- **Redis unavailable:** requests are admitted (`redis.fail_open: true`, the default; counted in
  `sy_platform_errors_total`). With `fail_open: false` they get a 503.

## 6. Budgets

- **Scope:** per team, a `daily` and/or `monthly` (UTC) limit in USD with `soft_threshold` and
  `action`.
- **Spend tracking:** Redis counters `budget:{team}:{period}:{YYYYMMDD|YYYYMM}` are
  incremented with actual cost after each request.
- **Hard check:** when `budgets.enforcement: hard` and `action: block`, a request returns **402
  `budget_exceeded`** if `spent + pre-flight cost > limit`.
  - The pre-flight cost is an **upper bound**: prompt tokens plus `max_tokens` (or the route
    default) at the route's most expensive target. On a small budget, requests without
    `max_tokens` can be rejected even at zero spend. Send `max_tokens` to keep the bound tight.
  - Requests whose pre-flight cost is 0 are never blocked, e.g. free or local models.
- **Alerts:** crossing `soft_threshold`, or reaching the limit, fires an alert at most once per
  team, period and level (Redis `SET NX`). The alert produces a structured log line,
  `sy_budget_alerts_total`, and an optional webhook POST (`webhook_url`, else
  `budgets.alert_webhook`). The body is `{type: budget.soft_threshold|budget.exceeded, team,
period, period_key, spent_usd, limit_usd, utilization, soft_threshold, action, ts}`.
- **Reconciliation:** every `budgets.reconcile_interval_s` (default 300 s), the worker resyncs
  the counters from `usage_daily`, which is authoritative.
  - Counters are always raised to the Postgres value.
  - They are only lowered when the usage stream is fully drained, so in-flight events are never
    lost from the counter.
- **Live view:** `GET /admin/teams/:id/budget` (or `switchyard budgets show`) shows spend,
  utilization and the linear end-of-period projection.

## 7. Response cache

- **Exact cache:** a canonical request hash keyed `cache:chat:{route}:{team}:{hash}`, plus
  `emb` (embeddings) and `rr` (rerank). Entries are gzip-compressed when ≥ 512 bytes and expire
  after the route's `cache.exact.ttl_s`.
  - Namespaced per team unless the route sets `cache.shared: true`.
  - Only successful, complete responses are stored (`finish_reason` stop / tool_calls / length,
    or embeddings / rerank).
  - Requests with a non-zero `temperature` or `n > 1` bypass the cache.
- **Embeddings** are cached **per input item** (`cache:embi:…`), so a batch with 9 known and 1
  new input calls upstream for 1. The response reports `x-sy-cache-items: <hits>/<total>`.
- **Request header `x-sy-cache`:** `default`, `bypass` (no read, no write) or `refresh` (no read,
  overwrite).
- **Response header `x-sy-cache`:** `hit` | `semantic-hit` | `miss` | `bypass`.
  - Hits also return `x-sy-cost-usd: 0` and `x-sy-saved-usd: <original cost>`.
  - The usage event records `saved_usd` and zero upstream tokens.
- **Streaming hits** are replayed as SSE chunks with the original usage chunk.
- **Semantic cache** (`cache.semantic.enabled`, needs `embed_route`) uses Redis 8 vector sets
  (`sem:{route}:{team|shared}:{context-hash}`, FP32, `VSIM`).
  - It embeds the last user message. The context hash covers everything else that changes the
    answer: prior turns, response_format, max_tokens, stop and reasoning_effort.
  - It answers when cosine similarity ≥ `min_similarity` (default 0.95) and adds
    `x-sy-semantic-similarity`.
  - Requests with tools skip it.
- **Purge:** `POST /admin/cache/purge {route?, team?}` or `switchyard cache purge` (SCAN +
  UNLINK; never FLUSHDB).

## 8. Usage pipeline

```
gateway ──XADD sy:usage MAXLEN ~1e6──▶ Redis stream ──XREADGROUP writers──▶ switchyard worker
   │ (in-memory buffer if Redis is down;                                       │ one SQL statement per batch:
   │  oldest dropped beyond usage.buffer_max)                                  │ INSERT usage_events ON CONFLICT DO NOTHING
   └ sy_usage_events_dropped_total                                             │ → aggregate inserted rows → UPSERT usage_daily
                                                                               └ XACK; XAUTOCLAIM stale entries; dead-letter malformed
```

- **Idempotent:** the key is `(ts, request_id)`, so redelivered entries are neither inserted
  nor rolled up twice. You can run several workers with the same group.
- **Partitions:** `usage_events` has monthly partitions. The worker creates
  `usage.partitions_ahead` months in advance, creates past months on demand, and drops
  partitions older than `usage.retention_days`.
- **Shutdown:** SIGTERM flushes the gateway's buffer, and the worker finishes the current batch
  before exiting.

## 9. Redis key layout

All keys use `redis.key_prefix` (default `sy:`). The usage stream name comes from `usage.stream`.

| Key                                          | Type            | TTL                             |
| -------------------------------------------- | --------------- | ------------------------------- |
| `rl:{key\|team}:{id}:{rpm\|tpm}`             | hash            | 2 × window                      |
| `budget:{team}:{daily\|monthly}:{period}`    | string          | period end + 1 day              |
| `budget-alert:{team}:{period}:{key}:{level}` | string (NX)     | period end + 1 day              |
| `key:{sha256}`                               | string          | `key_cache_ttl_s`               |
| `cache:{chat\|emb\|embi\|rr}:…`              | string          | route ttl                       |
| `sem:{route}:{team\|shared}:{context-hash}`  | vector set      | route ttl (refreshed)           |
| `cb:{target}`                                | hash            | ≥ breaker window + max cooldown |
| `invalidate`                                 | pub/sub channel | -                               |
| `sy:usage`, `sy:usage:dead`                  | stream          | MAXLEN ~                        |

The Lua scripts touch several keys, so Redis Cluster is not supported. Use a single primary,
with replicas or Sentinel.

## 10. Failure modes

| Failure                  | Behaviour                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Redis down               | Fail open by default: no rate limits or budget checks, cache misses, breakers fall back to per-process state, usage is buffered in memory. `/readyz` returns 503, so orchestrators stop routing new traffic. |
| Postgres down            | Cached keys keep working (Redis 60 s, local 5 s). Unknown keys get 503. Static keys work. Admin data endpoints return 503. The worker retries and leaves entries pending in the stream.                      |
| Worker down              | The stream grows (`sy_usage_stream_lag`) up to `stream_maxlen`. Budgets still enforce from the Redis counters.                                                                                               |
| Crashed worker mid-batch | Another worker reclaims its pending entries after `usage.claim_idle_ms` (XAUTOCLAIM). Inserts are idempotent.                                                                                                |
