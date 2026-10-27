# ADR 0003: Rate limits as one atomic Lua sliding-window check

- **Status:** Accepted
- **Date:** 2026-07

## Context

Keys and teams have RPM and TPM limits. A request must pass four limits (key RPM, key TPM, team
RPM, team TPM), with several gateway replicas sharing the counters. TPM is not known up front:
the gateway only has an estimate before the call and the real usage after it. Limits must never
be overshot under concurrency, and the check runs on every request, so it must be a single
round-trip.

## Decision

- **Algorithm:** a sliding-window counter per limit. One Redis hash `{w, c, p}` holds the
  current window index, its count and the previous window's count. The estimate is
  `p × (W − elapsed) / W + c`. Memory is O(1) per limit, and the error versus a true sliding log
  is a few percent.
- **Atomicity:** one `EVALSHA` (`limits/lua.ts`) evaluates every applicable limit first and
  increments the counters only if all of them pass. A rejected request consumes nothing, and N
  concurrent requests cannot overshoot.
- **Clock:** the script uses Redis `TIME` by default, so replicas share one clock. Tests inject
  the time.
- **TPM:** the check reserves the pre-flight estimate (prompt tokens via `js-tiktoken` plus
  `max_tokens` or a route default). After the response, a reconcile script adds
  `actual − estimate` to the window the reservation landed in.
- **Headers:** the reply carries remaining units, reset time and retry-after per limit. The
  gateway returns OpenAI-style `x-ratelimit-*` headers for the tightest scope, plus
  `retry-after` on 429.
- **Precedence:** limits come from the key record, then the team record, then config defaults.

## Consequences

- One round-trip per request for all four limits. The usual Redis concerns apply: a Lua script
  blocks Redis while it runs (microseconds here), and limit keys of one request must live on one
  shard if Redis Cluster is used. Single-node or replicated Redis is the supported setup today.
- Window boundaries are approximate by design. A short burst at a boundary can briefly exceed the
  true per-60-seconds rate by a few percent, never the configured counter.
- Over-reserving TPM, for example from a large `max_tokens` default, can reject requests that
  would have fit. Reconciliation returns the difference afterwards.
- With `redis.fail_open: true`, limits are skipped (and logged) while Redis is down. That is
  documented as SR-15.

## Alternatives considered

- **Fixed windows:** simpler, but allow up to 2× bursts at window edges.
- **Sliding log (sorted sets):** exact, but O(requests) memory and more work per check.
- **Token bucket:** a good fit for RPM, awkward for TPM reservations and reconciliation, and
  harder to express as OpenAI-style "remaining in this window" headers.
- **Separate check and increment calls:** racy across replicas.
