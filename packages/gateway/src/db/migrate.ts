import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client.js';

/**
 * Locates the drizzle migrations folder shipped with the package. The same code runs from
 * `src/db/` (tsx/vitest) and from the bundled `dist/cli.js`, so walk up until `drizzle/` is found.
 */
export function migrationsFolder(): string {
  const env = process.env.SWITCHYARD_MIGRATIONS_DIR;
  if (env) return resolve(env);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('drizzle migrations folder not found (set SWITCHYARD_MIGRATIONS_DIR)');
}

/** Outcome of `runMigrations` (applied vs total migrations). */
export interface MigrationResult {
  applied: number;
  total: number;
  schema: string;
}

/** Cross-process mutex so concurrent `switchyard migrate` runs (e.g. Helm hooks) serialize. */
const LOCK_KEY = 7_340_211_982;

/**
 * Applies pending migrations into `database.schemaName` (search_path decides where objects go;
 * the drizzle bookkeeping table lives in the same schema).
 */
export async function runMigrations(
  database: Database,
  opts: { folder?: string } = {},
): Promise<MigrationResult> {
  const folder = opts.folder ?? migrationsFolder();
  const schema = database.schemaName;
  const lock = await database.sql.reserve();
  try {
    await lock`select pg_advisory_lock(${LOCK_KEY})`;
    if (schema !== 'public')
      await database.sql`create schema if not exists ${database.sql(schema)}`;
    const count = async (): Promise<number> => {
      const rows = await database.sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.tables
        where table_schema = ${schema} and table_name = '__drizzle_migrations'`;
      if (!rows[0]?.n) return 0;
      const applied = await database.sql<{ n: number }[]>`
        select count(*)::int as n from ${database.sql(schema)}.__drizzle_migrations`;
      return applied[0]?.n ?? 0;
    };
    const before = await count();
    await migrate(database.db, {
      migrationsFolder: folder,
      migrationsSchema: schema,
      migrationsTable: '__drizzle_migrations',
    });
    const after = await count();
    return { applied: after - before, total: after, schema };
  } finally {
    await lock`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => undefined);
    lock.release();
  }
}
