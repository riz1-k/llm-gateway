import { defineConfig } from 'drizzle-kit';

/**
 * `pnpm db:generate` diffs src/db/schema.ts against drizzle/meta and writes a new SQL migration.
 * Generated SQL is reviewed and may be hand-edited (see drizzle/0000_*.sql: usage_events is
 * partitioned, which drizzle-kit cannot express). Migrations are applied with `switchyard migrate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://dev:dev@localhost:5432/llmgateway',
  },
  strict: true,
  verbose: true,
});
