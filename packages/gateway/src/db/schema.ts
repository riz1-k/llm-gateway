/**
 * Postgres schema (drizzle). Migrations are generated with drizzle-kit into `drizzle/` and then
 * hand-edited where drizzle-kit has no syntax (usage_events is RANGE-partitioned by month).
 *
 * Conventions
 * - Teams are addressed by an immutable `slug`. Usage tables are keyed by slug (not by the team
 *   uuid) so that usage of static bootstrap keys (`auth.static_keys`, no DB row) and of DB teams
 *   lands in the same rollups, and history survives a team's soft deletion.
 * - Money is `numeric`; JS sees it as `number` (USD amounts here are far below 2^53 precision limits).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const budgetPeriod = pgEnum('budget_period', ['daily', 'monthly']);
export const budgetAction = pgEnum('budget_action', ['block', 'alert']);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    rpmLimit: integer('rpm_limit'),
    tpmLimit: integer('tpm_limit'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    check('teams_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
    check('teams_rpm_positive', sql`${t.rpmLimit} IS NULL OR ${t.rpmLimit} > 0`),
    check('teams_tpm_positive', sql`${t.tpmLimit} IS NULL OR ${t.tpmLimit} > 0`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First 12 chars of the plaintext (e.g. `sk-sy-ab12cd`), safe to display and log. */
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
    /** sha256(plaintext), hex. The plaintext is never stored. */
    keyHash: char('key_hash', { length: 64 }).notNull().unique(),
    /** NULL = every route. */
    allowedRoutes: text('allowed_routes').array(),
    rpmLimit: integer('rpm_limit'),
    tpmLimit: integer('tpm_limit'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: tstz('expires_at'),
    revokedAt: tstz('revoked_at'),
    lastUsedAt: tstz('last_used_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    /** Set on keys created by `rotate`: the key they replace. */
    rotatedFrom: uuid('rotated_from'),
  },
  (t) => [
    index('api_keys_team_idx').on(t.teamId),
    check('api_keys_rpm_positive', sql`${t.rpmLimit} IS NULL OR ${t.rpmLimit} > 0`),
    check('api_keys_tpm_positive', sql`${t.tpmLimit} IS NULL OR ${t.tpmLimit} > 0`),
  ],
);

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    period: budgetPeriod('period').notNull(),
    limitUsd: numeric('limit_usd', { precision: 14, scale: 6, mode: 'number' }).notNull(),
    softThreshold: numeric('soft_threshold', { precision: 4, scale: 3, mode: 'number' })
      .notNull()
      .default(0.8),
    action: budgetAction('action').notNull().default('block'),
    webhookUrl: text('webhook_url'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('budgets_team_period_uq').on(t.teamId, t.period),
    check('budgets_limit_nonneg', sql`${t.limitUsd} >= 0`),
    check('budgets_soft_range', sql`${t.softThreshold} > 0 AND ${t.softThreshold} <= 1`),
  ],
);

/**
 * One row per request. PARTITION BY RANGE (ts), one partition per UTC month
 * (`usage_events_yYYYYmMM`), created ahead by the worker. The primary key includes the partition
 * key, which makes inserts idempotent on (ts, request_id).
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    ts: tstz('ts').notNull(),
    requestId: text('request_id').notNull(),
    teamId: text('team_id').notNull(),
    team: text('team').notNull(),
    keyId: text('key_id').notNull(),
    route: text('route').notNull(),
    kind: text('kind').notNull(),
    provider: text('provider'),
    model: text('model'),
    status: smallint('status').notNull(),
    errorCode: text('error_code'),
    cache: text('cache').notNull(),
    stream: boolean('stream').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    cachedTokens: integer('cached_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    reasoningTokens: integer('reasoning_tokens').notNull(),
    costUsd: numeric('cost_usd', { precision: 18, scale: 10, mode: 'number' }).notNull(),
    savedUsd: numeric('saved_usd', { precision: 18, scale: 10, mode: 'number' }).notNull(),
    latencyMs: integer('latency_ms').notNull(),
    ttftMs: integer('ttft_ms'),
    attempts: smallint('attempts').notNull(),
    fallbacks: smallint('fallbacks').notNull(),
    endUser: text('end_user'),
    tags: text('tags').array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ts, t.requestId] }),
    index('usage_events_team_ts_idx').on(t.team, t.ts),
    index('usage_events_key_ts_idx').on(t.keyId, t.ts),
  ],
);

/** Daily rollup (UTC days), maintained transactionally by the worker together with usage_events. */
export const usageDaily = pgTable(
  'usage_daily',
  {
    day: date('day', { mode: 'string' }).notNull(),
    team: text('team').notNull(),
    route: text('route').notNull(),
    /** '' when no provider was involved (e.g. rejected before dispatch). */
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    errors: bigint('errors', { mode: 'number' }).notNull().default(0),
    cacheHits: bigint('cache_hits', { mode: 'number' }).notNull().default(0),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
    cachedTokens: bigint('cached_tokens', { mode: 'number' }).notNull().default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
    reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10, mode: 'number' }).notNull().default(0),
    savedUsd: numeric('saved_usd', { precision: 20, scale: 10, mode: 'number' })
      .notNull()
      .default(0),
    latencyMsSum: bigint('latency_ms_sum', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.team, t.route, t.provider, t.model] }),
    index('usage_daily_team_day_idx').on(t.team, t.day),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: tstz('at').notNull().defaultNow(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('audit_log_at_idx').on(t.at)],
);

export type TeamRow = typeof teams.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
