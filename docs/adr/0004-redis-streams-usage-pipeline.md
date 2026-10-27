# ADR 0004: Usage events through a Redis Stream into Postgres

- **Status:** Accepted
- **Date:** 2026-07

## Context

Every request produces a usage event: team, key, route, provider, model, tokens, cost, cache
result, latency, TTFT, attempts and tags. The events feed cost reports, budget reconciliation and
dashboards. Writing to Postgres on the request path would add latency and make Postgres an
availability dependency for serving traffic. Losing events silently would make the ledger wrong.

## Decision

- **Emit:** the request path calls `UsageSink.emit()`, which never blocks or throws. The Redis
  sink queues events in memory and writes them on the next tick with pipelined
  `XADD <stream> MAXLEN ~ n`. While Redis is down it keeps up to `usage.buffer_max` events,
  drops the oldest beyond that (`sy_usage_events_dropped_total`) and retries with backoff.
- **Write:** a worker (`switchyard worker`, or in-process with `usage.in_process_writer: true`)
  reads with `XREADGROUP` in batches. It bulk-inserts into `usage_events`, which is
  range-partitioned by month (partitions are created ahead and dropped after
  `retention_days`), upserts the `usage_daily` rollups and then acknowledges with `XACK`.
- **Recovery:** inserts are idempotent on `(ts, request_id)`, so redelivery is safe. Entries
  left pending by a crashed consumer are reclaimed with `XAUTOCLAIM`. Entries that keep failing
  are dead-lettered.
- **Monitoring:** stream lag and pending counts are exported as metrics, and budget
  reconciliation uses them to know when the pipeline is drained (ADR 0006).

## Consequences

- The request path pays one in-memory push. Pipelining amortizes the `XADD`s, as the "platform
  on" numbers in [bench/RESULTS.md](../../bench/RESULTS.md) show.
- Postgres can be slow or down without affecting serving (database keys are cached). Events wait
  in the stream, which `MAXLEN` bounds (about 700 B per entry).
- Delivery is at least once, made exact by the idempotent insert. Events can still be lost if
  Redis is down for longer than the in-memory buffer covers, or if Redis loses data without
  persistence. Run Redis with AOF if the ledger matters.
- The worker scales horizontally through the consumer group.

## Alternatives considered

- **Direct Postgres insert per request:** simplest, but adds latency and couples availability.
- **Batching in process only:** loses events on crash or deploy, with no cross-replica view.
- **Kafka or NATS:** more durable at scale, but another system to run. Redis is already required
  for limits and caches.
