#!/usr/bin/env node
// Generates the provisioned Switchyard dashboards (observability/grafana/dashboards/*.json).
//
//   node observability/grafana/generate-dashboards.mjs          # write
//   node observability/grafana/generate-dashboards.mjs --check  # CI: fail if the JSON is stale
//
// Dashboards-as-code without extra tooling: plain functions emit Grafana's classic dashboard JSON
// (schemaVersion 42, Grafana 13). Metric names/labels follow docs/METRICS.md; Postgres panels read
// the `usage_daily` / `usage_events` / `teams` / `budgets` / `api_keys` tables.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'dashboards');
const SCHEMA_VERSION = 42;

const PROM = { type: 'prometheus', uid: '${datasource}' };
const PG = { type: 'grafana-postgresql-datasource', uid: '${pgds}' };

// Label filters shared by the PromQL below.
const R = 'route=~"$route"';
const T = 'team=~"$team"';
const RT = `${T}, ${R}`;
// SQL filters (multi-value variables rendered as quoted lists).
const SQL_TEAM = 'team IN (${team:sqlstring})';
const SQL_ROUTE = 'route IN (${route:sqlstring})';

const COLORS = { green: 'green', yellow: '#EAB839', orange: 'orange', red: 'red', blue: 'blue' };

// ── layout ───────────────────────────────────────────────────────────────────────────────────
class Layout {
  constructor() {
    this.panels = [];
    this.y = 0;
    this.x = 0;
    this.rowH = 0;
    this.id = 1;
  }
  /** Adds a panel of width w (of 24) and height h, wrapping to a new line when needed. */
  add(panel, w, h) {
    if (this.x + w > 24) this.newline();
    panel.id = this.id++;
    panel.gridPos = { h, w, x: this.x, y: this.y };
    this.panels.push(panel);
    this.x += w;
    this.rowH = Math.max(this.rowH, h);
    return this;
  }
  newline() {
    this.y += this.rowH;
    this.x = 0;
    this.rowH = 0;
  }
  row(title) {
    this.newline();
    this.panels.push({
      type: 'row',
      id: this.id++,
      title,
      collapsed: false,
      panels: [],
      gridPos: { h: 1, w: 24, x: 0, y: this.y },
    });
    this.y += 1;
    return this;
  }
}

// ── targets ──────────────────────────────────────────────────────────────────────────────────
const prom = (expr, legendFormat = '__auto', extra = {}) => ({
  datasource: PROM,
  editorMode: 'code',
  expr,
  legendFormat,
  range: true,
  ...extra,
});
const sql = (rawSql, format = 'table') => ({
  datasource: PG,
  editorMode: 'code',
  format,
  rawQuery: true,
  rawSql: rawSql.trim().replace(/\n\s+/g, '\n  '),
});
const withRefIds = (targets) =>
  targets.map((t, i) => ({ ...t, refId: String.fromCharCode(65 + i) }));

// ── panels ───────────────────────────────────────────────────────────────────────────────────
const thresholds = (steps) => ({
  mode: 'absolute',
  steps: steps.map(([value, color]) => ({ color, value })),
});

function timeseries(title, targets, opts = {}) {
  const {
    unit = 'short',
    description,
    stack = false,
    fill = 10,
    min,
    max,
    decimals,
    bars = false,
    points = false,
    overrides = [],
    legendCalcs = [],
    ds = PROM,
    extra = {},
  } = opts;
  return {
    type: 'timeseries',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    targets: withRefIds(targets),
    fieldConfig: {
      defaults: {
        unit,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(decimals !== undefined ? { decimals } : {}),
        color: { mode: 'palette-classic' },
        custom: {
          drawStyle: bars ? 'bars' : 'line',
          lineWidth: 1,
          fillOpacity: bars ? 80 : fill,
          gradientMode: 'opacity',
          showPoints: points ? 'always' : 'never',
          pointSize: 5,
          spanNulls: false,
          stacking: { mode: stack ? 'normal' : 'none', group: 'A' },
          axisSoftMin: 0,
          lineInterpolation: 'smooth',
        },
        thresholds: thresholds([[null, COLORS.green]]),
      },
      overrides,
    },
    options: {
      legend: {
        displayMode: legendCalcs.length ? 'table' : 'list',
        placement: 'bottom',
        showLegend: true,
        calcs: legendCalcs,
      },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
    ...extra,
  };
}

function stat(title, targets, opts = {}) {
  const {
    unit = 'short',
    description,
    steps = [[null, COLORS.green]],
    decimals,
    graph = true,
    noValue = '0',
    ds = PROM,
    mappings = [],
    extra = {},
  } = opts;
  return {
    type: 'stat',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    targets: withRefIds(targets),
    fieldConfig: {
      defaults: {
        unit,
        noValue,
        ...(decimals !== undefined ? { decimals } : {}),
        color: { mode: 'thresholds' },
        thresholds: thresholds(steps),
        mappings,
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      colorMode: 'value',
      graphMode: graph ? 'area' : 'none',
      justifyMode: 'auto',
      textMode: 'auto',
      orientation: 'auto',
      wideLayout: true,
      showPercentChange: false,
    },
    ...extra,
  };
}

function gauge(title, targets, opts = {}) {
  const { description, unit = 'percentunit', min = 0, max = 1, steps } = opts;
  return {
    type: 'gauge',
    title,
    ...(description ? { description } : {}),
    datasource: PROM,
    targets: withRefIds(targets),
    fieldConfig: {
      defaults: {
        unit,
        min,
        max,
        decimals: 1,
        color: { mode: 'thresholds' },
        thresholds: thresholds(steps),
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      showThresholdLabels: false,
      showThresholdMarkers: true,
      orientation: 'auto',
      minVizHeight: 75,
      minVizWidth: 75,
      sizing: 'auto',
    },
  };
}

function table(title, targets, opts = {}) {
  const { description, overrides = [], sortBy = [], ds = PG, transformations = [] } = opts;
  return {
    type: 'table',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    targets: withRefIds(targets),
    fieldConfig: {
      defaults: {
        custom: { align: 'auto', cellOptions: { type: 'auto' }, inspect: false },
        thresholds: thresholds([[null, COLORS.green]]),
      },
      overrides,
    },
    options: { showHeader: true, cellHeight: 'sm', sortBy, footer: { show: false } },
    transformations,
  };
}

function barGauge(title, targets, opts = {}) {
  const { description, unit = 'currencyUSD', steps = [[null, COLORS.blue]], ds = PG } = opts;
  return {
    type: 'bargauge',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    targets: withRefIds(targets),
    fieldConfig: {
      defaults: {
        unit,
        min: 0,
        color: { mode: 'thresholds' },
        thresholds: thresholds(steps),
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
      orientation: 'horizontal',
      displayMode: 'gradient',
      valueMode: 'color',
      namePlacement: 'left',
      showUnfilled: true,
      sizing: 'auto',
      minVizHeight: 16,
      minVizWidth: 8,
      maxVizHeight: 300,
    },
  };
}

function stateTimeline(title, targets, opts = {}) {
  const { description, mappings } = opts;
  return {
    type: 'state-timeline',
    title,
    ...(description ? { description } : {}),
    datasource: PROM,
    targets: withRefIds(targets),
    fieldConfig: {
      defaults: {
        // States come from the value mappings (with colors); thresholds would turn the
        // values into "< 1 / 1+ / 2+" ranges instead.
        color: { mode: 'fixed', fixedColor: 'text' },
        thresholds: thresholds([[null, COLORS.green]]),
        mappings,
        custom: { fillOpacity: 80, lineWidth: 0 },
      },
      overrides: [],
    },
    options: {
      mergeValues: true,
      showValue: 'auto',
      alignValue: 'left',
      rowHeight: 0.85,
      legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
      tooltip: { mode: 'single', sort: 'none' },
    },
  };
}

// ── templating ───────────────────────────────────────────────────────────────────────────────
const dsVar = (name, label, type) => ({
  name,
  label,
  type: 'datasource',
  query: type,
  current: {},
  hide: 0,
  refresh: 1,
  regex: '',
  includeAll: false,
  multi: false,
  options: [],
});
const promVar = (name, label, query, description) => ({
  name,
  label,
  description,
  type: 'query',
  datasource: PROM,
  query: { qryType: 1, query, refId: 'PrometheusVariableQueryEditor-VariableQuery' },
  definition: query,
  refresh: 2,
  sort: 1,
  includeAll: true,
  multi: true,
  current: { selected: true, text: ['All'], value: ['$__all'] },
  options: [],
  hide: 0,
  regex: '',
});
const teamVar = {
  name: 'team',
  label: 'Team',
  description: 'Teams from Postgres (authoritative; includes teams without recent traffic).',
  type: 'query',
  datasource: PG,
  query: 'SELECT slug FROM teams WHERE deleted_at IS NULL ORDER BY slug',
  definition: 'SELECT slug FROM teams WHERE deleted_at IS NULL ORDER BY slug',
  refresh: 2,
  sort: 1,
  includeAll: true,
  multi: true,
  current: { selected: true, text: ['All'], value: ['$__all'] },
  options: [],
  hide: 0,
  regex: '',
};
const routeVar = promVar(
  'route',
  'Route',
  'label_values(sy_requests_total, route)',
  'Virtual models (routes) seen by Prometheus.',
);
const providerVar = promVar(
  'provider',
  'Provider',
  'label_values(sy_upstream_duration_seconds_count, provider)',
  'Upstream providers (config keys).',
);

function dashboard({ uid, title, description, tags, panels, variables }) {
  return {
    annotations: {
      list: [
        {
          builtIn: 1,
          datasource: { type: 'grafana', uid: '-- Grafana --' },
          enable: true,
          hide: true,
          iconColor: 'rgba(0, 211, 255, 1)',
          name: 'Annotations & Alerts',
          type: 'dashboard',
        },
      ],
    },
    description,
    editable: true,
    fiscalYearStartMonth: 0,
    graphTooltip: 1,
    links: [
      {
        asDropdown: true,
        icon: 'external link',
        includeVars: true,
        keepTime: true,
        tags: ['switchyard'],
        targetBlank: false,
        title: 'Switchyard',
        type: 'dashboards',
      },
    ],
    panels,
    refresh: '30s',
    schemaVersion: SCHEMA_VERSION,
    tags: ['switchyard', ...tags],
    templating: { list: variables },
    time: { from: 'now-1h', to: 'now' },
    timepicker: {},
    timezone: 'browser',
    title,
    uid,
    version: 1,
    weekStart: '',
  };
}

const STATUS_COLORS = [
  { matcher: { id: 'byRegexp', options: '^2..$' }, color: 'green' },
  { matcher: { id: 'byRegexp', options: '^4(0[0-9]|1[0-9]|2[0-8]|[3-9][0-9])$' }, color: 'yellow' },
  { matcher: { id: 'byName', options: '429' }, color: 'orange' },
  { matcher: { id: 'byName', options: '402' }, color: 'purple' },
  { matcher: { id: 'byRegexp', options: '^5..$' }, color: 'red' },
].map(({ matcher, color }) => ({
  matcher,
  properties: [{ id: 'color', value: { fixedColor: color, mode: 'fixed' } }],
}));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Switchyard — Overview
// ═════════════════════════════════════════════════════════════════════════════════════════════
function overview() {
  const l = new Layout();
  const rate = (m, f = R) => `sum(rate(${m}{${f}}[$__rate_interval]))`;
  l.add(
    stat('Requests / s', [prom(rate('sy_requests_total'), 'RPS')], {
      unit: 'reqps',
      decimals: 2,
      description: 'All routed API requests incl. gateway rejections (429/402).',
    }),
    4,
    4,
  )
    .add(
      stat(
        'Error rate (5xx)',
        [
          prom(
            `${rate('sy_requests_total', `${R}, status=~"5.."`)} / clamp_min(${rate('sy_requests_total')}, 1e-9)`,
            '5xx',
          ),
        ],
        {
          unit: 'percentunit',
          decimals: 2,
          steps: [
            [null, COLORS.green],
            [0.01, COLORS.orange],
            [0.05, COLORS.red],
          ],
          description: 'Share of requests answered with a 5xx after retries and fallbacks.',
        },
      ),
      4,
      4,
    )
    .add(
      stat(
        'p95 latency',
        [
          prom(
            `histogram_quantile(0.95, sum by (le) (rate(sy_request_duration_seconds_bucket{${R}}[$__rate_interval])))`,
            'p95',
          ),
        ],
        {
          unit: 's',
          decimals: 2,
          noValue: '-',
          steps: [
            [null, COLORS.green],
            [5, COLORS.orange],
            [15, COLORS.red],
          ],
        },
      ),
      4,
      4,
    )
    .add(
      stat(
        'Cache hit ratio',
        [
          prom(
            `sum(rate(sy_cache_requests_total{${R}, result="hit"}[$__rate_interval])) / clamp_min(sum(rate(sy_cache_requests_total{${R}, result=~"hit|miss"}[$__rate_interval])), 1e-9)`,
            'hit ratio',
          ),
        ],
        {
          unit: 'percentunit',
          decimals: 1,
          noValue: '-',
          steps: [[null, COLORS.blue]],
          description: 'Exact + semantic cache hits / lookups (bypassed requests excluded).',
        },
      ),
      4,
      4,
    )
    .add(
      stat('Tokens / s', [prom(rate('sy_tokens_total'), 'tokens/s')], {
        unit: 'short',
        decimals: 1,
        steps: [[null, COLORS.blue]],
        description: 'Upstream tokens (prompt + completion + cached + reasoning).',
      }),
      4,
      4,
    )
    .add(
      stat('In-flight upstream', [prom('sum(sy_inflight_requests)', 'in-flight')], {
        unit: 'short',
        steps: [[null, COLORS.blue]],
        description: 'Upstream calls holding a provider concurrency slot right now.',
      }),
      4,
      4,
    );

  l.row('Traffic');
  l.add(
    timeseries(
      'Requests / s by route',
      [prom(`sum by (route) (rate(sy_requests_total{${R}}[$__rate_interval]))`, '{{route}}')],
      { unit: 'reqps', stack: true, legendCalcs: ['mean', 'max'] },
    ),
    12,
    8,
  ).add(
    timeseries(
      'Responses / s by status code',
      [prom(`sum by (status) (rate(sy_requests_total{${R}}[$__rate_interval]))`, '{{status}}')],
      {
        unit: 'reqps',
        stack: true,
        overrides: STATUS_COLORS,
        description:
          '402 = budget exceeded, 429 = gateway rate limit, 5xx = upstream failures after fallbacks.',
      },
    ),
    12,
    8,
  );

  l.row('Latency');
  l.add(
    timeseries(
      'Gateway latency p50 / p95 / p99',
      [0.5, 0.95, 0.99].map((q) =>
        prom(
          `histogram_quantile(${q}, sum by (le) (rate(sy_request_duration_seconds_bucket{${R}}[$__rate_interval])))`,
          `p${Math.round(q * 100)}`,
        ),
      ),
      { unit: 's', description: 'End-to-end inside the gateway (streams: until the last chunk).' },
    ),
    12,
    8,
  ).add(
    timeseries(
      'p95 latency by route',
      [
        prom(
          `histogram_quantile(0.95, sum by (le, route) (rate(sy_request_duration_seconds_bucket{${R}}[$__rate_interval])))`,
          '{{route}}',
        ),
      ],
      { unit: 's', legendCalcs: ['mean', 'max'] },
    ),
    12,
    8,
  );
  l.add(
    timeseries(
      'Time to first token p95 (streaming)',
      [
        prom(
          `histogram_quantile(0.95, sum by (le, route) (rate(sy_ttft_seconds_bucket{${R}}[$__rate_interval])))`,
          '{{route}}',
        ),
      ],
      { unit: 's' },
    ),
    12,
    7,
  ).add(
    timeseries(
      'Error rate by status code',
      [
        prom(
          `sum by (status) (rate(sy_requests_total{${R}, status!~"2.."}[$__rate_interval])) / ignoring(status) group_left clamp_min(sum(rate(sy_requests_total{${R}}[$__rate_interval])), 1e-9)`,
          '{{status}}',
        ),
      ],
      { unit: 'percentunit', stack: true, overrides: STATUS_COLORS },
    ),
    12,
    7,
  );

  l.row('Cache, tokens & limits');
  l.add(
    timeseries(
      'Cache hit ratio by route',
      [
        prom(
          `sum by (route) (rate(sy_cache_requests_total{${R}, result="hit"}[$__rate_interval])) / clamp_min(sum by (route) (rate(sy_cache_requests_total{${R}, result=~"hit|miss"}[$__rate_interval])), 1e-9)`,
          '{{route}}',
        ),
      ],
      { unit: 'percentunit', min: 0, max: 1 },
    ),
    8,
    8,
  )
    .add(
      timeseries(
        'Tokens / s by type',
        [prom(`sum by (type) (rate(sy_tokens_total{${RT}}[$__rate_interval]))`, '{{type}}')],
        { unit: 'short', stack: true },
      ),
      8,
      8,
    )
    .add(
      timeseries(
        'Gateway rejections / s',
        [
          prom(
            'sum by (scope, limit) (rate(sy_ratelimit_rejections_total[$__rate_interval]))',
            '429 {{scope}} {{limit}}',
          ),
          prom(
            `sum by (team) (rate(sy_budget_rejections_total{${T}}[$__rate_interval]))`,
            '402 {{team}}',
          ),
        ],
        {
          unit: 'reqps',
          stack: true,
          description: 'Rate-limit (429) and budget (402) rejections.',
        },
      ),
      8,
      8,
    );

  l.row('Processes');
  l.add(
    timeseries(
      'In-flight upstream requests by provider',
      [prom('sum by (provider) (sy_inflight_requests)', '{{provider}}')],
      { unit: 'short' },
    ),
    8,
    7,
  )
    .add(
      timeseries(
        'Resident memory',
        [prom('process_resident_memory_bytes{job=~".*switchyard.*"}', '{{job}} {{instance}}')],
        { unit: 'bytes' },
      ),
      8,
      7,
    )
    .add(
      timeseries(
        'CPU',
        [
          prom(
            'rate(process_cpu_seconds_total{job=~".*switchyard.*"}[$__rate_interval])',
            '{{job}} {{instance}}',
          ),
        ],
        { unit: 'percentunit' },
      ),
      8,
      7,
    );

  return dashboard({
    uid: 'switchyard-overview',
    title: 'Switchyard — Overview',
    description: 'Traffic, latency, errors, cache and token throughput of the Switchyard gateway.',
    tags: ['overview'],
    panels: l.panels,
    variables: [
      dsVar('datasource', 'Prometheus', 'prometheus'),
      dsVar('pgds', 'Postgres', 'grafana-postgresql-datasource'),
      teamVar,
      routeVar,
    ],
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Switchyard — Cost & Budgets
// ═════════════════════════════════════════════════════════════════════════════════════════════
// Start of the current UTC month as timestamptz (usage_events.ts) and as date (usage_daily.day).
const MONTH_START = "date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'";
const MONTH_START_DATE = "date_trunc('month', now() AT TIME ZONE 'utc')::date";

function cost() {
  const l = new Layout();
  const usd = (title, targets, opts = {}) =>
    stat(title, targets, {
      unit: 'currencyUSD',
      decimals: 4,
      steps: [[null, COLORS.blue]],
      ...opts,
    });

  l.add(
    usd(
      'Spend (time range)',
      [prom(`sum(increase(sy_cost_usd_total{${RT}}[$__range]))`, 'spend')],
      { description: 'Prometheus counters (approximate; reset on restart).' },
    ),
    4,
    4,
  )
    .add(
      usd(
        'Cache savings (time range)',
        [prom(`sum(increase(sy_cache_saved_usd_total{${RT}}[$__range]))`, 'saved')],
        { steps: [[null, COLORS.green]] },
      ),
      4,
      4,
    )
    .add(
      usd(
        'Month-to-date spend',
        [
          sql(
            `SELECT coalesce(sum(cost_usd), 0)::float8 AS "MTD"
             FROM usage_daily
             WHERE day >= ${MONTH_START_DATE} AND ${SQL_TEAM}`,
          ),
        ],
        { ds: PG, graph: false, description: 'Postgres rollups (authoritative).' },
      ),
      4,
      4,
    )
    .add(
      usd(
        'Projected month spend',
        [
          sql(
            `SELECT (coalesce(sum(cost_usd), 0)
                / greatest(extract(epoch FROM now() - ${MONTH_START})
                           / extract(epoch FROM (${MONTH_START} + interval '1 month') - ${MONTH_START}), 0.01))::float8 AS "Projected"
             FROM usage_daily
             WHERE day >= ${MONTH_START_DATE} AND ${SQL_TEAM}`,
          ),
        ],
        {
          ds: PG,
          graph: false,
          steps: [[null, COLORS.orange]],
          description: 'Linear projection of month-to-date spend to the end of the UTC month.',
        },
      ),
      4,
      4,
    )
    .add(
      stat(
        'Budget rejections (time range)',
        [prom(`sum(increase(sy_budget_rejections_total{${T}}[$__range]))`, '402')],
        {
          decimals: 0,
          steps: [
            [null, COLORS.green],
            [1, COLORS.red],
          ],
        },
      ),
      4,
      4,
    )
    .add(
      stat('Highest budget utilization', [prom(`max(sy_budget_utilization_ratio{${T}})`, 'max')], {
        unit: 'percentunit',
        decimals: 1,
        noValue: '-',
        steps: [
          [null, COLORS.green],
          [0.8, COLORS.orange],
          [0.9, COLORS.red],
        ],
      }),
      4,
      4,
    );

  l.row('Spend over time');
  l.add(
    timeseries(
      'Spend rate by team',
      [prom(`sum by (team) (rate(sy_cost_usd_total{${RT}}[$__rate_interval])) * 3600`, '{{team}}')],
      {
        unit: 'currencyUSD',
        stack: true,
        legendCalcs: ['mean', 'max'],
        description: 'USD per hour.',
      },
    ),
    12,
    8,
  ).add(
    timeseries(
      'Cumulative month-to-date spend by team',
      [
        sql(
          `WITH buckets AS (
             SELECT date_bin(make_interval(secs => $__interval_ms / 1000.0), ts, TIMESTAMPTZ '2000-01-01') AS time,
                    team, sum(cost_usd) AS cost
             FROM usage_events
             WHERE ts >= ${MONTH_START} AND ts <= $__timeTo() AND ${SQL_TEAM}
             GROUP BY 1, 2)
           SELECT time, team AS metric,
                  (sum(cost) OVER (PARTITION BY team ORDER BY time))::float8 AS value
           FROM buckets WHERE time >= $__timeFrom() ORDER BY 1`,
          'time_series',
        ),
      ],
      {
        ds: PG,
        unit: 'currencyUSD',
        points: true,
        legendCalcs: ['lastNotNull'],
        description: 'Running total since the start of the UTC month (usage_events).',
      },
    ),
    12,
    8,
  );
  l.add(
    timeseries(
      'Spend rate by route',
      [
        prom(
          `sum by (route) (rate(sy_cost_usd_total{${RT}}[$__rate_interval])) * 3600`,
          '{{route}}',
        ),
      ],
      { unit: 'currencyUSD', stack: true, description: 'USD per hour.' },
    ),
    12,
    8,
  ).add(
    timeseries(
      'Spend rate by provider / model',
      [
        prom(
          `sum by (provider, model) (rate(sy_cost_usd_total{${RT}}[$__rate_interval])) * 3600`,
          '{{provider}} / {{model}}',
        ),
      ],
      { unit: 'currencyUSD', stack: true, description: 'USD per hour.' },
    ),
    12,
    8,
  );
  l.add(
    timeseries(
      'Daily spend by team (30 days)',
      [
        sql(
          `SELECT day::timestamptz AS time, team AS metric, sum(cost_usd)::float8 AS value
           FROM usage_daily
           WHERE day >= $__timeFrom()::date AND day <= $__timeTo()::date
             AND ${SQL_TEAM} AND ${SQL_ROUTE}
           GROUP BY 1, 2 ORDER BY 1`,
          'time_series',
        ),
      ],
      {
        ds: PG,
        unit: 'currencyUSD',
        bars: true,
        stack: true,
        extra: { timeFrom: '30d', hideTimeOverride: false },
      },
    ),
    12,
    8,
  ).add(
    timeseries(
      'Cache savings rate by team',
      [
        prom(
          `sum by (team) (rate(sy_cache_saved_usd_total{${RT}}[$__rate_interval])) * 3600`,
          '{{team}}',
        ),
      ],
      {
        unit: 'currencyUSD',
        stack: true,
        description: 'USD per hour not spent thanks to cache hits.',
      },
    ),
    12,
    8,
  );

  l.row('Budgets');
  l.add(
    gauge(
      'Budget utilization',
      [prom(`max by (team, period) (sy_budget_utilization_ratio{${T}})`, '{{team}} · {{period}}')],
      {
        max: 1,
        steps: [
          [null, COLORS.green],
          [0.8, COLORS.orange],
          [0.9, COLORS.red],
        ],
        description:
          'spent / limit for the current UTC day or month (updated when the team sends traffic).',
      },
    ),
    10,
    8,
  ).add(
    table(
      'Budgets — month / day to date',
      [
        sql(
          `SELECT t.slug AS "Team", b.period::text AS "Period", b.action::text AS "Action",
                  b.limit_usd::float8 AS "Limit",
                  coalesce(s.spent, 0)::float8 AS "Spent",
                  (coalesce(s.spent, 0) / nullif(b.limit_usd, 0))::float8 AS "Utilization",
                  (coalesce(s.spent, 0) / greatest(
                     extract(epoch FROM now() - p.start) / extract(epoch FROM p.finish - p.start), 0.01))::float8 AS "Projected"
           FROM teams t
           JOIN budgets b ON b.team_id = t.id
           CROSS JOIN LATERAL (
             SELECT CASE WHEN b.period::text = 'monthly' THEN ${MONTH_START}
                         ELSE date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc' END AS start) p0
           CROSS JOIN LATERAL (
             SELECT p0.start AS start,
                    p0.start + CASE WHEN b.period::text = 'monthly' THEN interval '1 month' ELSE interval '1 day' END AS finish) p
           LEFT JOIN LATERAL (
             SELECT sum(d.cost_usd) AS spent FROM usage_daily d
             WHERE d.team = t.slug AND d.day >= (p.start AT TIME ZONE 'utc')::date) s ON true
           WHERE t.deleted_at IS NULL AND t.slug IN (\${team:sqlstring})
           ORDER BY "Utilization" DESC NULLS LAST`,
        ),
      ],
      {
        description:
          'Postgres: budget definitions vs rollup spend, with a linear end-of-period projection.',
        sortBy: [{ displayName: 'Utilization', desc: true }],
        overrides: [
          ...['Limit', 'Spent', 'Projected'].map((n) => ({
            matcher: { id: 'byName', options: n },
            properties: [
              { id: 'unit', value: 'currencyUSD' },
              { id: 'decimals', value: 4 },
            ],
          })),
          {
            matcher: { id: 'byName', options: 'Utilization' },
            properties: [
              { id: 'unit', value: 'percentunit' },
              { id: 'max', value: 1 },
              { id: 'min', value: 0 },
              { id: 'custom.cellOptions', value: { type: 'gauge', mode: 'gradient' } },
              { id: 'color', value: { mode: 'thresholds' } },
              {
                id: 'thresholds',
                value: thresholds([
                  [null, COLORS.green],
                  [0.8, COLORS.orange],
                  [0.9, COLORS.red],
                ]),
              },
            ],
          },
        ],
      },
    ),
    14,
    8,
  );

  l.row('Attribution');
  l.add(
    table(
      'Top keys by cost (time range)',
      [
        sql(
          `SELECT e.team AS "Team", coalesce(k.name, e.key_id) AS "Key",
                  coalesce(k.key_prefix || '…', '') AS "Prefix",
                  count(*) AS "Requests",
                  count(*) FILTER (WHERE e.status >= 400) AS "Errors",
                  count(*) FILTER (WHERE e.cache IN ('hit', 'semantic-hit')) AS "Cache hits",
                  sum(e.cost_usd)::float8 AS "Cost", sum(e.saved_usd)::float8 AS "Saved"
           FROM usage_events e
           LEFT JOIN api_keys k ON k.id::text = e.key_id
           WHERE $__timeFilter(e.ts) AND e.${SQL_TEAM} AND e.${SQL_ROUTE}
           GROUP BY 1, 2, 3 ORDER BY "Cost" DESC LIMIT 10`,
        ),
      ],
      {
        sortBy: [{ displayName: 'Cost', desc: true }],
        overrides: ['Cost', 'Saved'].map((n) => ({
          matcher: { id: 'byName', options: n },
          properties: [
            { id: 'unit', value: 'currencyUSD' },
            { id: 'decimals', value: 4 },
          ],
        })),
      },
    ),
    12,
    8,
  ).add(
    barGauge(
      'Spend by model (time range)',
      [
        sql(
          `SELECT provider || ' / ' || model AS "Model", sum(cost_usd)::float8 AS "Cost"
           FROM usage_events
           WHERE $__timeFilter(ts) AND ${SQL_TEAM} AND ${SQL_ROUTE} AND model <> ''
           GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
        ),
      ],
      { description: 'Postgres usage_events: spend per serving provider/model.' },
    ),
    12,
    8,
  );
  l.add(
    timeseries(
      'Tokens / s by team',
      [prom(`sum by (team) (rate(sy_tokens_total{${RT}}[$__rate_interval]))`, '{{team}}')],
      { unit: 'short', stack: true },
    ),
    24,
    7,
  );

  return dashboard({
    uid: 'switchyard-cost',
    title: 'Switchyard — Cost & Budgets',
    description:
      'Per-team / route / model spend (Prometheus, live) and authoritative usage + budgets (Postgres).',
    tags: ['cost'],
    panels: l.panels,
    variables: [
      dsVar('datasource', 'Prometheus', 'prometheus'),
      dsVar('pgds', 'Postgres', 'grafana-postgresql-datasource'),
      teamVar,
      routeVar,
    ],
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Switchyard — Providers & Reliability
// ═════════════════════════════════════════════════════════════════════════════════════════════
function providers() {
  const l = new Layout();
  const P = 'provider=~"$provider"';
  l.add(
    stat(
      'Upstream error ratio',
      [
        prom(
          `sum(rate(sy_upstream_duration_seconds_count{${P}, outcome="error"}[$__rate_interval])) / clamp_min(sum(rate(sy_upstream_duration_seconds_count{${P}}[$__rate_interval])), 1e-9)`,
          'errors',
        ),
      ],
      {
        unit: 'percentunit',
        decimals: 1,
        steps: [
          [null, COLORS.green],
          [0.05, COLORS.orange],
          [0.2, COLORS.red],
        ],
        description: 'Failed upstream attempts / all attempts (before retries and fallbacks).',
      },
    ),
    6,
    4,
  )
    .add(
      stat(
        'Fallbacks (time range)',
        [prom(`sum(increase(sy_fallbacks_total{${R}}[$__range]))`, 'fallbacks')],
        { decimals: 0, steps: [[null, COLORS.blue]] },
      ),
      6,
      4,
    )
    .add(
      stat('Retries (time range)', [prom('sum(increase(sy_retries_total[$__range]))', 'retries')], {
        decimals: 0,
        steps: [[null, COLORS.blue]],
      }),
      6,
      4,
    )
    .add(
      stat(
        'Open circuits',
        [prom('count(max by (target) (sy_circuit_state) == 2) or vector(0)', 'open')],
        {
          decimals: 0,
          graph: false,
          steps: [
            [null, COLORS.green],
            [1, COLORS.red],
          ],
        },
      ),
      6,
      4,
    );

  l.row('Upstream latency & errors');
  l.add(
    timeseries(
      'Upstream latency p95 by provider / model',
      [
        prom(
          `histogram_quantile(0.95, sum by (le, provider, model) (rate(sy_upstream_duration_seconds_bucket{${P}, outcome="ok"}[$__rate_interval])))`,
          '{{provider}} / {{model}}',
        ),
      ],
      {
        unit: 's',
        legendCalcs: ['mean', 'max'],
        description: 'Successful attempts: time to response, or to the first chunk for streams.',
      },
    ),
    12,
    8,
  ).add(
    timeseries(
      'Upstream latency p50 by provider / model',
      [
        prom(
          `histogram_quantile(0.5, sum by (le, provider, model) (rate(sy_upstream_duration_seconds_bucket{${P}, outcome="ok"}[$__rate_interval])))`,
          '{{provider}} / {{model}}',
        ),
      ],
      { unit: 's', legendCalcs: ['mean', 'max'] },
    ),
    12,
    8,
  );
  l.add(
    timeseries(
      'Upstream attempts / s by provider and outcome',
      [
        prom(
          `sum by (provider, outcome) (rate(sy_upstream_duration_seconds_count{${P}}[$__rate_interval]))`,
          '{{provider}} {{outcome}}',
        ),
      ],
      {
        unit: 'reqps',
        stack: true,
        overrides: [
          {
            matcher: { id: 'byRegexp', options: '.* error$' },
            properties: [{ id: 'color', value: { fixedColor: 'red', mode: 'shades' } }],
          },
        ],
      },
    ),
    12,
    8,
  ).add(
    timeseries(
      '429 / 5xx responses by provider',
      [
        prom(
          `sum by (provider, status) (rate(sy_requests_total{${R}, status=~"429|5.."}[$__rate_interval]))`,
          '{{provider}} {{status}}',
        ),
        prom(
          'sum by (reason) (rate(sy_retries_total[$__rate_interval]))',
          'upstream retry: {{reason}}',
        ),
      ],
      {
        unit: 'reqps',
        description:
          'Final 429/5xx responses by serving provider ("none" = rejected by the gateway), plus upstream errors absorbed by retries.',
      },
    ),
    12,
    8,
  );

  l.row('Resilience');
  l.add(
    stateTimeline(
      'Circuit breaker state by target',
      [prom('max by (target) (sy_circuit_state)', '{{target}}')],
      {
        description: '0 closed · 1 half-open · 2 open (shared across replicas via Redis).',
        mappings: [
          {
            type: 'value',
            options: {
              0: { text: 'closed', color: 'green', index: 0 },
              1: { text: 'half-open', color: COLORS.yellow, index: 1 },
              2: { text: 'open', color: 'red', index: 2 },
            },
          },
        ],
      },
    ),
    24,
    7,
  );
  l.add(
    timeseries(
      'Fallbacks / s (route: from → to, reason)',
      [
        prom(
          `sum by (route, from, to, reason) (rate(sy_fallbacks_total{${R}}[$__rate_interval]))`,
          '{{route}}: {{from}} → {{to}} ({{reason}})',
        ),
      ],
      { unit: 'reqps', stack: true, legendCalcs: ['sum'] },
    ),
    12,
    8,
  ).add(
    timeseries(
      'Retries / s by target and reason',
      [
        prom(
          'sum by (target, reason) (rate(sy_retries_total[$__rate_interval]))',
          '{{target}} ({{reason}})',
        ),
      ],
      { unit: 'reqps', stack: true, legendCalcs: ['sum'] },
    ),
    12,
    8,
  );

  l.row('Concurrency');
  l.add(
    timeseries(
      'Provider queue wait p95',
      [
        prom(
          `histogram_quantile(0.95, sum by (le, provider) (rate(sy_provider_queue_wait_seconds_bucket{${P}}[$__rate_interval])))`,
          '{{provider}}',
        ),
      ],
      {
        unit: 's',
        description: 'Wait for a provider concurrency slot (providers with max_concurrency).',
      },
    ),
    12,
    7,
  ).add(
    timeseries(
      'In-flight upstream requests',
      [prom(`sum by (provider) (sy_inflight_requests{${P}})`, '{{provider}}')],
      { unit: 'short', stack: true },
    ),
    12,
    7,
  );

  l.row('Usage pipeline (Redis stream → worker → Postgres)');
  l.add(
    timeseries(
      'Usage stream lag / pending',
      [
        prom('max(sy_usage_stream_lag)', 'lag (undelivered)'),
        prom('max(sy_usage_stream_pending)', 'pending (unacked)'),
      ],
      { unit: 'short', description: 'Replica-identical gauges, aggregated with max().' },
    ),
    8,
    7,
  )
    .add(
      timeseries(
        'Worker events / s',
        [
          prom(
            'sum by (result) (rate(sy_usage_worker_events_total[$__rate_interval]))',
            '{{result}}',
          ),
          prom('sum(rate(sy_usage_worker_errors_total[$__rate_interval]))', 'failed batches'),
        ],
        { unit: 'short' },
      ),
      8,
      7,
    )
    .add(
      timeseries(
        'Platform errors / s (fail-open) & dropped events',
        [
          prom(
            'sum by (component) (rate(sy_platform_errors_total[$__rate_interval]))',
            '{{component}}',
          ),
          prom('sum(rate(sy_usage_events_dropped_total[$__rate_interval]))', 'usage dropped'),
        ],
        { unit: 'short' },
      ),
      8,
      7,
    );

  return dashboard({
    uid: 'switchyard-providers',
    title: 'Switchyard — Providers & Reliability',
    description:
      'Upstream latency and errors, fallbacks, retries, circuit breakers, concurrency and the usage pipeline.',
    tags: ['reliability'],
    panels: l.panels,
    variables: [dsVar('datasource', 'Prometheus', 'prometheus'), providerVar, routeVar],
  });
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
const dashboards = {
  'switchyard-overview.json': overview(),
  'switchyard-cost.json': cost(),
  'switchyard-providers.json': providers(),
};

const check = process.argv.includes('--check');
let stale = 0;
for (const [file, dash] of Object.entries(dashboards)) {
  const path = join(OUT, file);
  const json = `${JSON.stringify(dash, null, 2)}\n`;
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== json) {
      process.stderr.write(`stale: ${path}\n`);
      stale++;
    }
  } else {
    writeFileSync(path, json);
    process.stdout.write(`wrote ${path} (${dash.panels.length} panels)\n`);
  }
}
if (stale) {
  process.stderr.write('Dashboards are out of date: run `make dashboards`.\n');
  process.exit(1);
}
