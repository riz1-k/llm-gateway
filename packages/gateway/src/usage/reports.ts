import type { Database } from '../db/client.js';

export const GROUP_BY = ['day', 'team', 'route', 'model', 'provider', 'key'] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export interface UsageQuery {
  team?: string | undefined;
  route?: string | undefined;
  model?: string | undefined;
  /** Inclusive UTC day `YYYY-MM-DD`. */
  from: string;
  /** Inclusive UTC day `YYYY-MM-DD`. */
  to: string;
  groupBy: GroupBy;
}

export interface UsageRow {
  group: string;
  /** Human label (key name/prefix for group_by=key). */
  label?: string;
  requests: number;
  errors: number;
  cache_hits: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  saved_usd: number;
  avg_latency_ms: number;
}

export interface UsageReport {
  query: UsageQuery;
  rows: UsageRow[];
  totals: Omit<UsageRow, 'group' | 'label'>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Group expressions are whitelisted (never interpolated from input). */
const DAILY_GROUP: Record<Exclude<GroupBy, 'key'>, string> = {
  day: "to_char(day, 'YYYY-MM-DD')",
  team: 'team',
  route: 'route',
  model: "nullif(model, '')",
  provider: "nullif(provider, '')",
};

/**
 * Usage report from the daily rollups (or from usage_events for `group_by=key`, which the rollup
 * does not carry; partition pruning keeps that bounded by the date range).
 */
export async function queryUsage(database: Database, q: UsageQuery): Promise<UsageReport> {
  if (!DAY.test(q.from) || !DAY.test(q.to)) throw new Error('from/to must be YYYY-MM-DD');
  const { sql } = database;
  type Raw = Omit<UsageRow, 'avg_latency_ms'> & { latency_ms_sum: number };
  let raw: Raw[];
  if (q.groupBy === 'key') {
    raw = await sql<Raw[]>`
      select e.key_id as group,
        coalesce(max(k.name || ' (' || k.key_prefix || '…)'), e.key_id) as label,
        count(*)::float8 as requests,
        (count(*) filter (where e.status >= 400))::float8 as errors,
        (count(*) filter (where e.cache in ('hit', 'semantic-hit')))::float8 as cache_hits,
        sum(e.prompt_tokens)::float8 as prompt_tokens, sum(e.cached_tokens)::float8 as cached_tokens,
        sum(e.completion_tokens)::float8 as completion_tokens,
        sum(e.reasoning_tokens)::float8 as reasoning_tokens,
        sum(e.cost_usd)::float8 as cost_usd, sum(e.saved_usd)::float8 as saved_usd,
        sum(e.latency_ms)::float8 as latency_ms_sum
      from usage_events e
      left join api_keys k on k.id::text = e.key_id
      where e.ts >= ${q.from}::date and e.ts < (${q.to}::date + 1)
        ${q.team ? sql`and e.team = ${q.team}` : sql``}
        ${q.route ? sql`and e.route = ${q.route}` : sql``}
        ${q.model ? sql`and e.model = ${q.model}` : sql``}
      group by e.key_id
      order by cost_usd desc, requests desc`;
  } else {
    const expr = sql.unsafe(DAILY_GROUP[q.groupBy]);
    const order =
      q.groupBy === 'day' ? sql`order by 1` : sql`order by cost_usd desc, requests desc`;
    raw = await sql<Raw[]>`
      select coalesce(${expr}, '(none)') as group,
        sum(requests)::float8 as requests, sum(errors)::float8 as errors,
        sum(cache_hits)::float8 as cache_hits,
        sum(prompt_tokens)::float8 as prompt_tokens, sum(cached_tokens)::float8 as cached_tokens,
        sum(completion_tokens)::float8 as completion_tokens,
        sum(reasoning_tokens)::float8 as reasoning_tokens,
        sum(cost_usd)::float8 as cost_usd, sum(saved_usd)::float8 as saved_usd,
        sum(latency_ms_sum)::float8 as latency_ms_sum
      from usage_daily
      where day between ${q.from}::date and ${q.to}::date
        ${q.team ? sql`and team = ${q.team}` : sql``}
        ${q.route ? sql`and route = ${q.route}` : sql``}
        ${q.model ? sql`and model = ${q.model}` : sql``}
      group by 1
      ${order}`;
  }
  const rows: UsageRow[] = raw.map((r) => {
    const { latency_ms_sum, ...rest } = r;
    return {
      ...rest,
      group: String(r.group),
      ...(r.label ? { label: r.label } : {}),
      avg_latency_ms: r.requests > 0 ? Math.round(latency_ms_sum / r.requests) : 0,
      cost_usd: round10(r.cost_usd),
      saved_usd: round10(r.saved_usd),
    };
  });
  const sum = (f: keyof Raw) => raw.reduce((a, r) => a + Number(r[f] ?? 0), 0);
  const requests = sum('requests');
  return {
    query: q,
    rows,
    totals: {
      requests,
      errors: sum('errors'),
      cache_hits: sum('cache_hits'),
      prompt_tokens: sum('prompt_tokens'),
      cached_tokens: sum('cached_tokens'),
      completion_tokens: sum('completion_tokens'),
      reasoning_tokens: sum('reasoning_tokens'),
      cost_usd: round10(sum('cost_usd')),
      saved_usd: round10(sum('saved_usd')),
      avg_latency_ms: requests > 0 ? Math.round(sum('latency_ms_sum') / requests) : 0,
    },
  };
}

const round10 = (n: number): number => Math.round(n * 1e10) / 1e10;
