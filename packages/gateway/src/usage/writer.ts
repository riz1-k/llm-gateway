import type { UsageEvent } from '../core/services.js';
import type { Database } from '../db/client.js';

/**
 * Writes a batch of usage events and updates the daily rollup in ONE statement:
 *
 *   input (jsonb_to_recordset) → INSERT usage_events ON CONFLICT DO NOTHING RETURNING *
 *     → aggregate only the rows actually inserted → UPSERT usage_daily (+=)
 *
 * Re-delivered events (worker crash after commit but before XACK) hit the (ts, request_id)
 * primary key, are not returned by RETURNING and therefore never counted twice in the rollup.
 */
export async function writeUsageBatch(
  database: Database,
  events: UsageEvent[],
): Promise<{ inserted: number; duplicates: number }> {
  if (events.length === 0) return { inserted: 0, duplicates: 0 };
  const seen = new Set<string>();
  const rows = [];
  for (const e of events) {
    const id = `${e.ts}|${e.request_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      ts: e.ts,
      request_id: e.request_id,
      team_id: e.team_id,
      team: e.team,
      key_id: e.key_id,
      route: e.route,
      kind: e.kind,
      provider: e.provider,
      model: e.model,
      status: e.status,
      error_code: e.error_code,
      cache: e.cache,
      stream: e.stream,
      prompt_tokens: clampInt(e.prompt_tokens),
      cached_tokens: clampInt(e.cached_tokens),
      completion_tokens: clampInt(e.completion_tokens),
      reasoning_tokens: clampInt(e.reasoning_tokens),
      cost_usd: e.cost_usd,
      saved_usd: e.saved_usd,
      latency_ms: clampInt(e.latency_ms),
      ttft_ms: e.ttft_ms === null ? null : clampInt(e.ttft_ms),
      attempts: Math.min(32_767, e.attempts),
      fallbacks: Math.min(32_767, e.fallbacks),
      end_user: e.end_user,
      tags: e.tags,
    });
  }
  const { sql } = database;
  const res = await sql<{ inserted: number }[]>`
    with input as (
      select * from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(
        ts timestamptz, request_id text, team_id text, team text, key_id text, route text,
        kind text, provider text, model text, status smallint, error_code text, cache text,
        stream boolean, prompt_tokens int, cached_tokens int, completion_tokens int,
        reasoning_tokens int, cost_usd numeric, saved_usd numeric, latency_ms int, ttft_ms int,
        attempts smallint, fallbacks smallint, end_user text, tags text[])
    ), ins as (
      insert into usage_events (
        ts, request_id, team_id, team, key_id, route, kind, provider, model, status, error_code,
        cache, stream, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens,
        cost_usd, saved_usd, latency_ms, ttft_ms, attempts, fallbacks, end_user, tags)
      select ts, request_id, team_id, team, key_id, route, kind, provider, model, status,
        error_code, cache, stream, prompt_tokens, cached_tokens, completion_tokens,
        reasoning_tokens, cost_usd, saved_usd, latency_ms, ttft_ms, attempts, fallbacks,
        end_user, coalesce(tags, '{}')
      from input
      on conflict (ts, request_id) do nothing
      returning *
    ), agg as (
      select (ts at time zone 'UTC')::date as day, team, route,
        coalesce(provider, '') as provider, coalesce(model, '') as model,
        count(*) as requests,
        count(*) filter (where status >= 400) as errors,
        count(*) filter (where cache in ('hit', 'semantic-hit')) as cache_hits,
        sum(prompt_tokens) as prompt_tokens, sum(cached_tokens) as cached_tokens,
        sum(completion_tokens) as completion_tokens, sum(reasoning_tokens) as reasoning_tokens,
        sum(cost_usd) as cost_usd, sum(saved_usd) as saved_usd, sum(latency_ms) as latency_ms_sum
      from ins
      group by 1, 2, 3, 4, 5
    ), up as (
      insert into usage_daily as d (
        day, team, route, provider, model, requests, errors, cache_hits, prompt_tokens,
        cached_tokens, completion_tokens, reasoning_tokens, cost_usd, saved_usd, latency_ms_sum)
      select * from agg
      on conflict (day, team, route, provider, model) do update set
        requests = d.requests + excluded.requests,
        errors = d.errors + excluded.errors,
        cache_hits = d.cache_hits + excluded.cache_hits,
        prompt_tokens = d.prompt_tokens + excluded.prompt_tokens,
        cached_tokens = d.cached_tokens + excluded.cached_tokens,
        completion_tokens = d.completion_tokens + excluded.completion_tokens,
        reasoning_tokens = d.reasoning_tokens + excluded.reasoning_tokens,
        cost_usd = d.cost_usd + excluded.cost_usd,
        saved_usd = d.saved_usd + excluded.saved_usd,
        latency_ms_sum = d.latency_ms_sum + excluded.latency_ms_sum
      returning 1
    )
    select (select count(*) from ins)::int as inserted, (select count(*) from up)::int as groups`;
  const inserted = res[0]?.inserted ?? 0;
  return { inserted, duplicates: events.length - inserted };
}

const clampInt = (n: number): number => Math.max(0, Math.min(2_147_483_647, Math.round(n || 0)));

/** Months (first day, `YYYY-MM-01`) touched by a batch. */
export function monthsOf(events: UsageEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) out.add(`${e.ts.slice(0, 7)}-01`);
  return [...out];
}

/** Creates the monthly partition for each month (idempotent; see sy_ensure_usage_partition). */
export async function ensurePartitions(database: Database, months: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const m of months) {
    const r = await database.sql<
      { name: string }[]
    >`select sy_ensure_usage_partition(${m}::date) as name`;
    if (r[0]) names.push(r[0].name);
  }
  return names;
}

/** Drops monthly partitions that ended more than `retentionDays` ago. Returns dropped names. */
export async function dropExpiredPartitions(
  database: Database,
  retentionDays: number,
  now: Date = new Date(),
): Promise<string[]> {
  const { sql } = database;
  const parts = await sql<{ name: string }[]>`
    select c.relname as name
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = p.relnamespace
    where p.relname = 'usage_events' and n.nspname = ${database.schemaName}`;
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const dropped: string[] = [];
  for (const { name } of parts) {
    const m = /^usage_events_y(\d{4})m(\d{2})$/.exec(name);
    if (!m) continue;
    const end = Date.UTC(Number(m[1]), Number(m[2]), 1); // first day of the following month
    if (end < cutoff) {
      await sql`drop table if exists ${sql(name)}`;
      dropped.push(name);
    }
  }
  return dropped;
}
