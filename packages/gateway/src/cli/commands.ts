import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { parseArgs } from 'node:util';
import { Counter } from 'prom-client';
import { loadConfig } from '../config/load.js';
import type { ResolvedConfig } from '../config/resolve.js';
import { createDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { DbBudgetSource } from '../limits/db-budget-source.js';
import { RedisBudgetGuard } from '../limits/redis-budgets.js';
import { createLogger } from '../observability/logger.js';
import { PromMetrics } from '../observability/metrics.js';
import { createPlatform } from '../platform/index.js';
import { createRedisClient, quitQuietly, RedisKeys } from '../platform/redis.js';
import { serveMetrics } from '../server.js';
import { GROUP_BY, type GroupBy, type UsageReport } from '../usage/reports.js';
import { streamLag } from '../usage/stream.js';
import { UsageWorker } from '../usage/worker.js';
import { HttpAdminApi, LocalAdminApi, type AdminApi } from './admin-api.js';
import { seedDev } from './seed.js';

const out = (s = ''): void => {
  process.stdout.write(`${s}\n`);
};

const configPathOf = (v: string | undefined): string | undefined =>
  v ?? process.env.SWITCHYARD_CONFIG;

function requireConfig(v: string | undefined, cmd: string): ResolvedConfig {
  const path = configPathOf(v);
  if (!path) throw new Error(`${cmd} requires --config <file> (or SWITCHYARD_CONFIG)`);
  return loadConfig(path);
}

/** Simple aligned table. */
export function table(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '(none)';
  const cols = columns ?? Object.keys(rows[0]!);
  const cell = (v: unknown): string =>
    v === null || v === undefined
      ? '-'
      : Array.isArray(v)
        ? v.join(',') || '-'
        : typeof v === 'string'
          ? v
          : v instanceof Date
            ? v.toISOString()
            : (JSON.stringify(v) ?? '-');
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [
    line(cols),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(cols.map((c) => cell(r[c])))),
  ].join('\n');
}

const usd = (n: number): string => (n === 0 ? '0' : n < 0.01 ? n.toFixed(6) : n.toFixed(4));

// ---------------------------------------------------------------------------------------------
// Admin API selection
// ---------------------------------------------------------------------------------------------

const ADMIN_OPTIONS = {
  config: { type: 'string', short: 'c' },
  url: { type: 'string' },
  'admin-token': { type: 'string' },
  json: { type: 'boolean' },
} as const;

/**
 * Local mode (default): `--config` → direct Postgres/Redis access via the AdminService.
 * Remote mode: `--url` (or SWITCHYARD_URL) → a running gateway's admin API with
 * `--admin-token` (or SWITCHYARD_ADMIN_TOKEN).
 */
async function openAdmin(values: {
  config?: string;
  url?: string;
  'admin-token'?: string;
}): Promise<AdminApi> {
  const url = values.url ?? process.env.SWITCHYARD_URL;
  if (url) {
    const token = values['admin-token'] ?? process.env.SWITCHYARD_ADMIN_TOKEN;
    if (!token) throw new Error('--url requires --admin-token (or SWITCHYARD_ADMIN_TOKEN)');
    return new HttpAdminApi(url, token);
  }
  const config = requireConfig(values.config, 'admin commands');
  if (!config.raw.database?.url) throw new Error('database.url is not configured');
  const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'warn' });
  const platform = createPlatform(config, { logger, metrics: false, role: 'admin' });
  return new LocalAdminApi(platform.admin!, config, () => platform.close());
}

async function withAdmin<T>(
  values: { config?: string; url?: string; 'admin-token'?: string },
  fn: (api: AdminApi) => Promise<T>,
): Promise<T> {
  const api = await openAdmin(values);
  try {
    return await fn(api);
  } finally {
    await api.close();
  }
}

const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};

// ---------------------------------------------------------------------------------------------
// migrate / worker
// ---------------------------------------------------------------------------------------------

export async function cmdMigrate(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { config: { type: 'string', short: 'c' }, 'database-url': { type: 'string' } },
  });
  let url = values['database-url'] ?? process.env.DATABASE_URL;
  if (!url) url = requireConfig(values.config, 'migrate').raw.database?.url;
  if (!url)
    throw new Error('migrate requires database.url in the config, --database-url or DATABASE_URL');
  const database = createDatabase(url, { max: 2, applicationName: 'switchyard-migrate' });
  try {
    const r = await runMigrations(database);
    out(`✔ migrations: ${r.applied} applied, ${r.total} total (schema ${r.schema})`);
    return 0;
  } finally {
    await database.close();
  }
}

export async function cmdWorker(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { config: { type: 'string', short: 'c' }, port: { type: 'string', short: 'p' } },
  });
  const config = requireConfig(values.config, 'worker');
  const raw = config.raw;
  if (!raw.redis?.url || !raw.database?.url)
    throw new Error('worker requires redis.url and database.url');
  const logger = createLogger({ level: raw.observability.log_level }).child({
    component: 'worker',
  });
  const usage = raw.usage ?? {
    stream: 'sy:usage',
    batch_size: 500,
    flush_interval_ms: 1000,
    retention_days: 400,
    consumer_group: 'writers',
    claim_idle_ms: 60_000,
    partitions_ahead: 2,
  };
  const database = createDatabase(raw.database.url, {
    max: 4,
    applicationName: 'switchyard-worker',
  });
  const blocking = createRedisClient(raw.redis.url, { name: 'worker', logger });
  const main = createRedisClient(raw.redis.url, {
    name: 'worker-main',
    commandTimeoutMs: 5000,
    logger,
  });
  const keys = new RedisKeys(raw.redis.key_prefix);
  const budgets = new RedisBudgetGuard({
    redis: main,
    keys,
    source: new DbBudgetSource(database, () => raw.budgets?.definitions_ttl_ms ?? 30_000),
    config: () => config,
    logger,
  });

  const port = num(values.port, 'port') ?? raw.metrics.port;
  let prom: PromMetrics | undefined;
  let events: Counter<'result'> | undefined;
  let errors: Counter | undefined;
  if (port !== undefined) {
    prom = new PromMetrics({ defaultMetrics: raw.metrics.default_metrics });
    prom.setSources({ streamLag: () => streamLag(main, usage.stream, usage.consumer_group) });
    events = new Counter({
      name: 'sy_usage_worker_events_total',
      help: 'Usage stream entries processed by this worker (result: inserted|duplicate|dead_lettered).',
      labelNames: ['result'],
      registers: [prom.registry],
    });
    errors = new Counter({
      name: 'sy_usage_worker_errors_total',
      help: 'Failed worker batches (retried with backoff; entries stay pending).',
      registers: [prom.registry],
    });
  }

  const worker = new UsageWorker({
    redis: blocking,
    database,
    stream: usage.stream,
    group: usage.consumer_group,
    batchSize: usage.batch_size,
    blockMs: usage.flush_interval_ms,
    claimIdleMs: usage.claim_idle_ms,
    retentionDays: usage.retention_days,
    partitionsAhead: usage.partitions_ahead,
    logger,
    budgets,
    reconcileIntervalMs: (raw.budgets?.reconcile_interval_s ?? 300) * 1000,
    onBatch: (b) => {
      events?.inc({ result: 'inserted' }, b.inserted);
      events?.inc({ result: 'duplicate' }, b.duplicates);
      events?.inc({ result: 'dead_lettered' }, b.deadLettered);
    },
    onError: () => errors?.inc(),
  });
  await worker.start();
  let server: Server | undefined;
  if (prom && port !== undefined) {
    server = await serveMetrics(prom, port, raw.server.host, raw.metrics.path);
    logger.info({ port }, 'worker metrics listening');
  }
  let stopping = false;
  const stop = (sig: string) => () => {
    if (stopping) return;
    stopping = true;
    logger.info({ sig }, 'worker shutting down');
    void (async () => {
      await worker.stop();
      if (server) await new Promise<void>((r) => server.close(() => r()));
      await Promise.all([quitQuietly(blocking), quitQuietly(main)]);
      await database.close();
      process.exit(0);
    })();
  };
  process.once('SIGTERM', stop('SIGTERM'));
  process.once('SIGINT', stop('SIGINT'));
  return -1;
}

// ---------------------------------------------------------------------------------------------
// teams / keys / budgets
// ---------------------------------------------------------------------------------------------

export async function cmdTeams(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      ...ADMIN_OPTIONS,
      name: { type: 'string' },
      'monthly-budget': { type: 'string' },
      'daily-budget': { type: 'string' },
      rpm: { type: 'string' },
      tpm: { type: 'string' },
    },
  });
  return withAdmin(values, async (api) => {
    switch (sub) {
      case 'create': {
        const slug = positionals[0];
        if (!slug)
          throw new Error(
            'usage: switchyard teams create <slug> [--name] [--monthly-budget USD] [--daily-budget USD] [--rpm N] [--tpm N]',
          );
        const monthly = num(values['monthly-budget'], 'monthly-budget');
        const daily = num(values['daily-budget'], 'daily-budget');
        const rpm = num(values.rpm, 'rpm');
        const tpm = num(values.tpm, 'tpm');
        const team = await api.createTeam({
          slug,
          ...(values.name ? { name: values.name } : {}),
          ...(rpm !== undefined ? { rpm_limit: rpm } : {}),
          ...(tpm !== undefined ? { tpm_limit: tpm } : {}),
          ...(monthly !== undefined || daily !== undefined
            ? {
                budgets: {
                  ...(monthly !== undefined ? { monthly: { limit_usd: monthly } } : {}),
                  ...(daily !== undefined ? { daily: { limit_usd: daily } } : {}),
                },
              }
            : {}),
        });
        if (values.json) out(JSON.stringify(team, null, 2));
        else
          out(
            `✔ team ${team.slug} created (${team.id})${team.budgets.map((b) => ` · ${b.period} $${b.limit_usd}`).join('')}`,
          );
        return 0;
      }
      case 'list': {
        const teams = await api.listTeams();
        if (values.json) out(JSON.stringify(teams, null, 2));
        else
          out(
            table(
              teams.map((t) => ({
                slug: t.slug,
                name: t.name,
                id: t.id,
                keys: t.active_keys,
                daily: t.budgets.find((b) => b.period === 'daily')?.limit_usd ?? null,
                monthly: t.budgets.find((b) => b.period === 'monthly')?.limit_usd ?? null,
                rpm: t.rpm_limit,
                tpm: t.tpm_limit,
              })),
            ),
          );
        return 0;
      }
      case 'get': {
        const t = positionals[0] ? await api.getTeam(positionals[0]) : null;
        if (!t) throw new Error(`team ${positionals[0] ?? '?'} not found`);
        out(JSON.stringify(t, null, 2));
        return 0;
      }
      case 'delete': {
        if (!positionals[0]) throw new Error('usage: switchyard teams delete <slug>');
        const t = await api.deleteTeam(positionals[0]);
        out(`✔ team ${t.slug} deleted (keys revoked)`);
        return 0;
      }
      default:
        throw new Error('usage: switchyard teams create|list|get|delete …');
    }
  });
}

export async function cmdKeys(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      ...ADMIN_OPTIONS,
      team: { type: 'string', short: 't' },
      name: { type: 'string', short: 'n' },
      routes: { type: 'string' },
      rpm: { type: 'string' },
      tpm: { type: 'string' },
      'expires-in-days': { type: 'string' },
      'grace-s': { type: 'string' },
      all: { type: 'boolean' },
    },
  });
  return withAdmin(values, async (api) => {
    switch (sub) {
      case 'create': {
        if (!values.team)
          throw new Error(
            'usage: switchyard keys create --team <slug> [--name] [--routes a,b] [--rpm] [--tpm] [--expires-in-days]',
          );
        const rpm = num(values.rpm, 'rpm');
        const tpm = num(values.tpm, 'tpm');
        const days = num(values['expires-in-days'], 'expires-in-days');
        const created = await api.createKey(values.team, {
          name: values.name ?? 'default',
          ...(values.routes
            ? {
                allowed_routes: values.routes
                  .split(',')
                  .map((r) => r.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(rpm !== undefined ? { rpm_limit: rpm } : {}),
          ...(tpm !== undefined ? { tpm_limit: tpm } : {}),
          ...(days !== undefined ? { expires_in_days: days } : {}),
        });
        if (values.json) out(JSON.stringify(created, null, 2));
        else {
          out(
            `✔ key ${created.record.id} for team ${created.record.team} (${created.record.name})`,
          );
          out(created.key);
          out('  ↑ store it now: the plaintext is shown only once.');
        }
        return 0;
      }
      case 'list': {
        if (!values.team) throw new Error('usage: switchyard keys list --team <slug> [--all]');
        const keys = await api.listKeys(values.team, values.all === true);
        if (values.json) out(JSON.stringify(keys, null, 2));
        else
          out(
            table(
              keys.map((k) => ({
                id: k.id,
                name: k.name,
                key: k.masked,
                status: k.status,
                routes: k.allowed_routes ?? 'all',
                last_used: k.last_used_at,
                created: k.created_at,
              })),
            ),
          );
        return 0;
      }
      case 'revoke': {
        if (!positionals[0]) throw new Error('usage: switchyard keys revoke <key-id>');
        const k = await api.revokeKey(positionals[0]);
        out(`✔ key ${k.id} (${k.masked}) revoked`);
        return 0;
      }
      case 'rotate': {
        if (!positionals[0])
          throw new Error('usage: switchyard keys rotate <key-id> [--grace-s N]');
        const r = await api.rotateKey(positionals[0], {
          grace_s: num(values['grace-s'], 'grace-s') ?? 0,
        });
        if (values.json) out(JSON.stringify(r, null, 2));
        else {
          out(
            `✔ key ${r.previous.id} rotated → ${r.record.id}${r.previous.status === 'active' ? ` (old key valid until ${r.previous.expires_at})` : ''}`,
          );
          out(r.key);
          out('  ↑ store it now: the plaintext is shown only once.');
        }
        return 0;
      }
      default:
        throw new Error('usage: switchyard keys create|list|revoke|rotate …');
    }
  });
}

const budgetArg = (v: string | undefined, name: string, extra: Record<string, unknown>) => {
  if (v === undefined) return undefined;
  if (v === 'none' || v === 'off') return null;
  return { limit_usd: num(v, name)!, ...extra };
};

export async function cmdBudgets(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      ...ADMIN_OPTIONS,
      team: { type: 'string', short: 't' },
      monthly: { type: 'string' },
      daily: { type: 'string' },
      soft: { type: 'string' },
      action: { type: 'string' },
      webhook: { type: 'string' },
    },
  });
  if (!values.team) throw new Error('usage: switchyard budgets set|show --team <slug> …');
  const team = values.team;
  return withAdmin(values, async (api) => {
    if (sub === 'set') {
      const extra: Record<string, unknown> = {};
      const soft = num(values.soft, 'soft');
      if (soft !== undefined) extra.soft_threshold = soft;
      if (values.action) extra.action = values.action;
      if (values.webhook) extra.webhook_url = values.webhook;
      const monthly = budgetArg(values.monthly, 'monthly', extra);
      const daily = budgetArg(values.daily, 'daily', extra);
      if (monthly === undefined && daily === undefined)
        throw new Error('budgets set needs --monthly USD|none and/or --daily USD|none');
      const res = await api.setBudgets(team, {
        ...(monthly !== undefined ? { monthly } : {}),
        ...(daily !== undefined ? { daily } : {}),
      });
      out(
        values.json
          ? JSON.stringify(res, null, 2)
          : table(res as unknown as Record<string, unknown>[]),
      );
      return 0;
    }
    if (sub === 'show') {
      const r = await api.budgetStatus(team);
      if (values.json) out(JSON.stringify(r, null, 2));
      else {
        out(
          `team ${r.team} · spend today $${usd(r.spend.daily)} · this month $${usd(r.spend.monthly)} (as of ${r.as_of})`,
        );
        out(
          table(
            r.budgets.map((b) => ({
              period: `${b.period} ${b.period_key}`,
              limit: `$${b.limit_usd}`,
              spent: `$${usd(b.spent_usd)}`,
              util: `${(b.utilization * 100).toFixed(1)}%`,
              projected: `$${usd(b.projected_usd)}`,
              action: b.action,
              status: b.status,
            })),
          ),
        );
      }
      return 0;
    }
    throw new Error('usage: switchyard budgets set|show --team <slug> …');
  });
}

// ---------------------------------------------------------------------------------------------
// usage / cache / seed-dev
// ---------------------------------------------------------------------------------------------

export function renderUsage(r: UsageReport): string {
  const rows = r.rows.map((x) => ({
    [r.query.groupBy]: x.label ?? x.group,
    requests: x.requests,
    errors: x.errors,
    cache_hits: x.cache_hits,
    prompt_tok: x.prompt_tokens,
    completion_tok: x.completion_tokens,
    cost_usd: usd(x.cost_usd),
    saved_usd: usd(x.saved_usd),
    avg_ms: x.avg_latency_ms,
  }));
  const t = r.totals;
  rows.push({
    [r.query.groupBy]: 'TOTAL',
    requests: t.requests,
    errors: t.errors,
    cache_hits: t.cache_hits,
    prompt_tok: t.prompt_tokens,
    completion_tok: t.completion_tokens,
    cost_usd: usd(t.cost_usd),
    saved_usd: usd(t.saved_usd),
    avg_ms: t.avg_latency_ms,
  });
  const filters = [
    r.query.team && `team=${r.query.team}`,
    r.query.route && `route=${r.query.route}`,
    r.query.model && `model=${r.query.model}`,
  ]
    .filter(Boolean)
    .join(' ');
  return `usage ${r.query.from} → ${r.query.to} by ${r.query.groupBy}${filters ? ` (${filters})` : ''}\n${table(rows)}`;
}

export async function cmdUsage(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      ...ADMIN_OPTIONS,
      team: { type: 'string', short: 't' },
      route: { type: 'string' },
      model: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'group-by': { type: 'string', short: 'g' },
    },
  });
  const groupBy = (values['group-by'] ?? 'day') as GroupBy;
  if (!GROUP_BY.includes(groupBy))
    throw new Error(`--group-by must be one of ${GROUP_BY.join('|')}`);
  return withAdmin(values, async (api) => {
    const r = await api.usage({
      team: values.team,
      route: values.route,
      model: values.model,
      from: values.from,
      to: values.to,
      groupBy,
    });
    out(values.json ? JSON.stringify(r, null, 2) : renderUsage(r));
    return 0;
  });
}

export async function cmdCache(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: { ...ADMIN_OPTIONS, route: { type: 'string' }, team: { type: 'string' } },
  });
  if (sub !== 'purge') throw new Error('usage: switchyard cache purge [--route R] [--team T]');
  return withAdmin(values, async (api) => {
    const r = await api.purgeCache({
      ...(values.route ? { route: values.route } : {}),
      ...(values.team ? { team: values.team } : {}),
    });
    out(`✔ purged ${r.deleted} cache entries`);
    return 0;
  });
}

/** Updates/creates `KEY=value` lines in a dotenv file (mode 0600). */
function writeEnvFile(path: string, entries: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  for (const [k, v] of Object.entries(entries)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else
      lines.splice(
        lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length,
        0,
        `${k}=${v}`,
      );
  }
  writeFileSync(path, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function cmdSeedDev(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      ...ADMIN_OPTIONS,
      rotate: { type: 'boolean' },
      output: { type: 'string', short: 'o' },
    },
  });
  return withAdmin(values, async (api) => {
    const res = await seedDev(api, { rotate: values.rotate === true });
    if (values.json) {
      out(JSON.stringify(res, null, 2));
    } else {
      out(
        table(
          res.map((r) => ({
            team: r.team,
            team_status: r.teamCreated ? 'created' : 'exists',
            monthly_budget: `$${r.monthlyBudgetUsd}`,
            key: `${r.keyPrefix}…`,
            key_status: r.keyStatus,
          })),
        ),
      );
      const fresh = res.filter((r) => r.key);
      if (fresh.length > 0) {
        out('\n# New keys (shown once):');
        for (const r of fresh) out(`${r.envVar}=${r.key}`);
      } else {
        out(
          '\nAll seed keys already exist; plaintexts are not retrievable. Use --rotate to issue new ones.',
        );
      }
    }
    const fresh = Object.fromEntries(res.filter((r) => r.key).map((r) => [r.envVar, r.key!]));
    if (values.output && Object.keys(fresh).length > 0) {
      writeEnvFile(values.output, fresh);
      out(`✔ wrote ${Object.keys(fresh).length} key(s) to ${values.output} (mode 600)`);
    }
    return 0;
  });
}
