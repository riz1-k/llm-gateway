# Switchyard metrics

Reference for dashboards and alerts: Prometheus metrics (SPEC §13) plus the Postgres usage tables
used by the "Cost & Budgets" dashboard.

## Scrape endpoints

| Process             | Endpoint                                                       | Notes                                                                                                    |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `switchyard serve`  | `GET /metrics` on the API port                                 | No auth. With `metrics.port: 9464`, it moves to `:9464/metrics`, and the API port no longer serves it.   |
| `switchyard worker` | `GET :<port>/metrics` (`--port` or `metrics.port`), `/healthz` | Only served when a port is set. Exposes the usage-pipeline gauges plus the `sy_usage_worker_*` counters. |

- **Config:** `metrics: { enabled: true, path: /metrics, port?: number, default_metrics: true }`.
  `observability.metrics: false` also disables metrics.
- **Node.js process metrics:** prom-client's defaults (`process_*`, `nodejs_*`) are included when
  `default_metrics` is true. They are unprefixed.
- **Recommended scrape interval:** 15 s.

## Metric reference

Every gateway metric uses the `sy_` prefix. All counters are per process, so aggregate with `sum`.
Gauges marked "replica-identical" report the same value from every replica, so aggregate those with
`max`.

### Traffic and latency

| Metric                           | Type      | Labels                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sy_requests_total`              | counter   | `route, provider, model, status, cache` | One per routed API request, including gateway rejections (429/402/4xx), which have `provider="none", model="none"`. `provider`/`model` are the serving target. `cache` is `hit` / `semantic-hit` / `miss` / `bypass` (`bypass` = cache not used: route without cache, `x-sy-cache: bypass`, or a non-cacheable request). Unauthenticated (401) requests are not counted. |
| `sy_request_duration_seconds`    | histogram | `route, status`                         | End-to-end latency inside the gateway. For streams it runs until the last chunk. Buckets: 5 ms … 300 s.                                                                                                                                                                                                                                                                  |
| `sy_upstream_duration_seconds`   | histogram | `provider, model, outcome`              | One observation per upstream attempt: time to response, or to the first chunk for streams. `outcome` is `ok`/`error`; this label is an addition to SPEC.                                                                                                                                                                                                                 |
| `sy_ttft_seconds`                | histogram | `route`                                 | Time to first meaningful token for successful streaming chat. Cache-hit replays count too, and are near zero.                                                                                                                                                                                                                                                            |
| `sy_inflight_requests`           | gauge     | `provider`                              | Upstream calls currently holding a provider concurrency slot. Sampled at scrape time.                                                                                                                                                                                                                                                                                    |
| `sy_provider_queue_wait_seconds` | histogram | `provider`                              | Wait time for a concurrency slot (`max_concurrency`). Only providers with a semaphore observe it. Buckets: 1 ms … 60 s.                                                                                                                                                                                                                                                  |

### Tokens, cost, cache

| Metric                     | Type    | Labels                         | Meaning                                                                                                                                   |
| -------------------------- | ------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `sy_tokens_total`          | counter | `team, route, model, type`     | Upstream tokens. `type` is `prompt` / `completion` / `cached` / `reasoning`. Cache hits add nothing because no upstream tokens are spent. |
| `sy_cost_usd_total`        | counter | `team, route, provider, model` | USD from the pricing table. Copilot / opencode costs are shadow prices. Only incremented when cost > 0.                                   |
| `sy_cache_saved_usd_total` | counter | `team, route`                  | USD saved by cache hits, equal to the original cost of the cached response.                                                               |
| `sy_cache_requests_total`  | counter | `route, kind, result`          | Cache lookups. `kind` is `exact` / `semantic`; `result` is `hit` / `miss` / `bypass`. Routes without a cache config never report.         |

### Limits and budgets

| Metric                          | Type    | Labels                | Meaning                                                                                                                                                                                                                 |
| ------------------------------- | ------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sy_ratelimit_rejections_total` | counter | `scope, limit`        | 429s from the gateway rate limiter. `scope` is `key`/`team`; `limit` is `rpm`/`tpm`, and names the limit that needs the longest wait. Upstream 429s are not counted here; they become retries or fallbacks.             |
| `sy_budget_rejections_total`    | counter | `team`                | 402 `budget_exceeded` responses.                                                                                                                                                                                        |
| `sy_budget_utilization_ratio`   | gauge   | `team, period`        | spent / limit for the current UTC day or month. Updated whenever a request of that team is admitted (replica-identical, so use `max`). Stale for teams without traffic; for exact values use the admin API or Postgres. |
| `sy_budget_alerts_total`        | counter | `team, period, level` | Budget alerts fired. `level` is `soft` (crossed `soft_threshold`) or `exceeded`. Fires at most once per team, period and level (Redis `SET NX`). Extra metric.                                                          |

### Resilience

| Metric               | Type    | Labels                    | Meaning                                                                                                                                                                                          |
| -------------------- | ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sy_fallbacks_total` | counter | `route, from, to, reason` | Moves from one target to the next within a request. `reason` is the gateway error code that caused it, e.g. `upstream_unavailable`, `upstream_timeout`, `upstream_rate_limited`, `circuit_open`. |
| `sy_retries_total`   | counter | `target, reason`          | Retries of the same target, with the error code of the failed attempt.                                                                                                                           |
| `sy_circuit_state`   | gauge   | `target`                  | `0` closed, `1` half-open, `2` open. Sampled at scrape time from the shared (Redis) breaker store, so replica-identical; use `max`.                                                              |

### Usage pipeline (stream → worker → Postgres)

| Metric                          | Type    | Labels      | Meaning                                                                                                                                           |
| ------------------------------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sy_usage_stream_lag`           | gauge   | -           | Entries in `sy:usage` not yet delivered to the `writers` consumer group (XINFO GROUPS `lag`, or XLEN before the group exists). Replica-identical. |
| `sy_usage_stream_pending`       | gauge   | -           | Delivered but unacknowledged entries, i.e. in flight or held by a crashed worker. Extra metric.                                                   |
| `sy_usage_events_buffered`      | gauge   | -           | Events held in gateway memory while Redis is unavailable. Extra metric.                                                                           |
| `sy_usage_events_dropped_total` | counter | -           | Events dropped because the in-memory buffer (`usage.buffer_max`) overflowed. Alert on any increase. Extra metric.                                 |
| `sy_usage_worker_events_total`  | counter | `result`    | Worker only: `inserted` / `duplicate` (idempotent redelivery) / `dead_lettered` (malformed entries moved to `sy:usage:dead`).                     |
| `sy_usage_worker_errors_total`  | counter | -           | Worker only: failed batches. They are retried with backoff and entries stay pending.                                                              |
| `sy_platform_errors_total`      | counter | `component` | Redis/Postgres errors handled fail-open (`ratelimit`, `budget`, `cache`, `keys`, `usage`, `breaker`). Extra metric.                               |

## PromQL cookbook

```promql
# Overview
sum(rate(sy_requests_total[5m]))                                              # RPS
histogram_quantile(0.95, sum by (le) (rate(sy_request_duration_seconds_bucket[5m])))
sum(rate(sy_requests_total{status=~"5.."}[5m])) / sum(rate(sy_requests_total[5m]))   # error rate
sum(rate(sy_cache_requests_total{result="hit"}[5m]))
  / sum(rate(sy_cache_requests_total{result=~"hit|miss"}[5m]))               # cache hit ratio
sum(rate(sy_tokens_total[5m]))                                                # tokens/s

# Cost & Budgets
sum by (team) (increase(sy_cost_usd_total[1h]))                               # spend per team per hour
sum by (team, route) (increase(sy_cache_saved_usd_total[24h]))                # cache savings
max by (team, period) (sy_budget_utilization_ratio)                           # budget gauges
sum by (team) (increase(sy_budget_rejections_total[1h]))

# Providers & Reliability
histogram_quantile(0.95, sum by (le, provider, model) (rate(sy_upstream_duration_seconds_bucket[5m])))
max by (target) (sy_circuit_state)
sum by (route, from, to, reason) (increase(sy_fallbacks_total[15m]))
sum by (target, reason) (increase(sy_retries_total[15m]))
sum by (scope, limit) (rate(sy_ratelimit_rejections_total[5m]))               # 429s
histogram_quantile(0.95, sum by (le, provider) (rate(sy_provider_queue_wait_seconds_bucket[5m])))
max(sy_usage_stream_lag)
```

Suggested alerts:

- `max(sy_usage_stream_lag) > 10000 for 10m`: the worker is down or slow.
- `increase(sy_usage_events_dropped_total[5m]) > 0`: usage events are being lost.
- `max by (target) (sy_circuit_state) == 2 for 5m`: a target's circuit is stuck open.
- `max by (team, period) (sy_budget_utilization_ratio) > 0.9`: a team is close to its budget.

## Postgres (authoritative usage)

Prometheus counters reset on restart and are approximate. For billing-grade numbers, projected
spend and "top keys", query Postgres. The database is `llmgateway` (schema `public`) and the
tables are created by `switchyard migrate`.

| Table          | Grain                                                   | Columns                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage_daily`  | PK `(day, team, route, provider, model)`, UTC day       | `requests, errors, cache_hits, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, cost_usd numeric, saved_usd numeric, latency_ms_sum`. `team` is the team slug. Rejected requests have `provider = ''` and `model = ''`. |
| `usage_events` | one row per request; range-partitioned by month on `ts` | `ts, request_id, team_id, team, key_id, route, kind, provider, model, status, error_code, cache, stream, *_tokens, cost_usd, saved_usd, latency_ms, ttft_ms, attempts, fallbacks, end_user, tags text[]`                                  |
| `teams`        |                                                         | `id uuid, slug, name, rpm_limit, tpm_limit, created_at, deleted_at`                                                                                                                                                                       |
| `budgets`      | unique `(team_id, period)`                              | `period daily\|monthly, limit_usd, soft_threshold, action block\|alert, webhook_url`                                                                                                                                                      |
| `api_keys`     |                                                         | `id, team_id, name, key_prefix` (e.g. `sk-sy-AbCdEf`; never the full key), `allowed_routes, rpm_limit, tpm_limit, expires_at, revoked_at, last_used_at`                                                                                   |

Example Grafana (Postgres datasource) queries:

```sql
-- Spend by team per day ($__timeFilter on day)
select day::timestamptz as time, team, sum(cost_usd)::float8 as cost
from usage_daily where $__timeFilter(day::timestamptz) group by 1, 2 order by 1;

-- Month-to-date spend vs budget with linear projection
select t.slug, b.limit_usd::float8,
       coalesce(sum(d.cost_usd), 0)::float8 as spent,
       coalesce(sum(d.cost_usd), 0)::float8
         / greatest(extract(epoch from now() - date_trunc('month', now())) / 86400, 1/24.0)
         * extract(day from date_trunc('month', now()) + interval '1 month' - interval '1 day') as projected
from teams t join budgets b on b.team_id = t.id and b.period = 'monthly'
left join usage_daily d on d.team = t.slug and d.day >= date_trunc('month', now() at time zone 'utc')::date
where t.deleted_at is null group by 1, 2;

-- Top keys this month (key_id is the api_keys.id uuid, or "static:<hash16>" for config keys)
select e.key_id, k.name, k.key_prefix, count(*) as requests, sum(e.cost_usd)::float8 as cost
from usage_events e left join api_keys k on k.id::text = e.key_id
where e.ts >= date_trunc('month', now()) group by 1, 2, 3 order by cost desc limit 10;
```

`GET /admin/teams/:id/budget` returns the same utilization and projection numbers from the live
Redis counters.
