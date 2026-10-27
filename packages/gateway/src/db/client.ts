import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

export interface Database {
  /** Raw postgres.js client (hot-path SQL, DDL). */
  readonly sql: postgres.Sql;
  /** Typed drizzle query builder over the same pool. */
  readonly db: Db;
  /** Schema objects are created in / resolved from (first entry of search_path). */
  readonly schemaName: string;
  ping(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  max?: number;
  /**
   * Schema for all objects (default `public`). Tests use one schema per file for isolation;
   * `public` stays on the search_path for extension types.
   */
  schema?: string;
  /** Application name visible in pg_stat_activity. */
  applicationName?: string;
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function createDatabase(url: string, opts: DatabaseOptions = {}): Database {
  const schemaName = opts.schema ?? 'public';
  if (!SAFE_IDENT.test(schemaName)) throw new Error(`invalid schema name: ${schemaName}`);
  const sql = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: {
      application_name: opts.applicationName ?? 'switchyard',
      search_path: schemaName === 'public' ? 'public' : `${schemaName},public`,
      TimeZone: 'UTC',
    },
  });
  const db = drizzle(sql, { schema });
  return {
    sql,
    db,
    schemaName,
    async ping(timeoutMs = 2000) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          sql`select 1`,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
          }),
        ]);
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
