# ADR 0006: Budgets: pre-flight check plus reconciliation

- **Status:** Accepted
- **Date:** 2026-07

## Context

Teams have daily and monthly USD budgets, with a soft threshold (alert) and a hard limit
(block, 402). The real cost of a request is only known after the response. The authoritative
ledger is Postgres, fed asynchronously (ADR 0004). Blocking must be fast (one Redis round-trip)
and consistent across replicas.

## Decision

- **Counters:** Redis holds a spend counter per team and period, for example
  `sy:budget:{team}:monthly:{YYYYMM}`. Its TTL runs to the end of the period plus one day.
- **Pre-flight:** before dispatch, the gateway computes an upper-bound cost from the prompt
  estimate and `max_tokens` (times `n`). It rejects with 402 `budget_exceeded` when
  `spent + preflight > limit` and the action is `block`.
- **Record:** after the response, the actual cost is added with `INCRBYFLOAT`. Cache hits cost 0
  and record `saved_usd` instead.
- **Alerts:** crossing the soft threshold or the limit fires one alert per period across all
  replicas (deduplicated with `SET NX`): a structured log, a metric and an optional webhook.
- **Reconciliation:** the worker periodically compares the counters with the Postgres
  `usage_daily` rollups. It raises a counter whenever Postgres is higher, for example after a
  Redis restart lost increments. It lowers a counter only when the usage stream is drained,
  because otherwise Redis legitimately holds spend that has not reached Postgres yet.

## Consequences

- One Redis read on the request path and one increment after it. Budget state survives Redis
  loss through reconciliation.
- **Accepted overshoot (SR-14):** concurrent requests from one team can each pass the pre-flight
  check, and together overshoot by up to in-flight requests × cost per request. Rate limits and
  provider concurrency cap this. An atomic reservation (reserve the pre-flight cost with Lua,
  reconcile to the actual cost, like TPM) is on the roadmap.
- With `redis.fail_open: true`, budgets are not enforced while Redis is down (SR-15).
- Upper-bound estimates can reject a request near the limit that would have fit. Clients can
  lower `max_tokens`.

## Alternatives considered

- **Check Postgres on every request:** authoritative, but slow, and couples serving to the
  database.
- **Post-hoc only (alert, never block):** no protection against runaway spend.
- **Atomic reservation now:** better under concurrency, but changes the accounting model.
  Deferred to keep the first release simple.
