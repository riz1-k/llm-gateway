import type { AdminApi } from './admin-api.js';

export interface SeedTeam {
  slug: string;
  name: string;
  monthlyBudgetUsd: number;
  /** Env var name the consumer project reads its key from. */
  envVar: string;
  /** Route allow-list (filtered to routes that exist); null = all routes. */
  routes: string[] | null;
}

/** Teams of the portfolio (SPEC §17): DocsQA, OpsAgent, evals. Budgets are shadow USD. */
export const DEV_TEAMS: SeedTeam[] = [
  {
    slug: 'docsqa',
    name: 'DocsQA',
    monthlyBudgetUsd: 50,
    envVar: 'DOCSQA_GATEWAY_KEY',
    routes: [
      'docsqa-chat',
      'docsqa-fast',
      'docsqa-judge',
      'docsqa-embed',
      'docsqa-rerank',
      'mock-chat',
      'mock-embed',
      'mock-rerank',
      'mock-tools',
    ],
  },
  {
    slug: 'opsagent',
    name: 'OpsAgent',
    monthlyBudgetUsd: 50,
    envVar: 'OPSAGENT_GATEWAY_KEY',
    routes: [
      'opsagent-chat',
      'opsagent-judge',
      'mock-chat',
      'mock-embed',
      'mock-rerank',
      'mock-tools',
    ],
  },
  {
    slug: 'evals',
    name: 'Evals',
    monthlyBudgetUsd: 100,
    envVar: 'EVALS_GATEWAY_KEY',
    routes: null,
  },
];

export const SEED_KEY_NAME = 'seed-dev';

export interface SeedResult {
  team: string;
  teamCreated: boolean;
  envVar: string;
  /** Plaintext when a key was created/rotated in this run. */
  key: string | null;
  keyPrefix: string;
  keyStatus: 'created' | 'rotated' | 'exists';
  monthlyBudgetUsd: number;
}

/**
 * Idempotent: creates missing teams, upserts their monthly budgets (block at 100 %, alert at
 * 80 %), and creates one `seed-dev` key per team unless an active one exists (`rotate` issues a
 * fresh plaintext for existing keys — plaintexts are never retrievable afterwards).
 */
export async function seedDev(
  api: AdminApi,
  opts: { rotate?: boolean } = {},
): Promise<SeedResult[]> {
  const available = new Set(await api.routes());
  const out: SeedResult[] = [];
  for (const t of DEV_TEAMS) {
    const teamCreated = !(await api.getTeam(t.slug));
    if (teamCreated) await api.createTeam({ slug: t.slug, name: t.name });
    await api.setBudgets(t.slug, {
      monthly: { limit_usd: t.monthlyBudgetUsd, soft_threshold: 0.8, action: 'block' },
    });
    const keys = await api.listKeys(t.slug, false);
    const existing = keys.find((k) => k.name === SEED_KEY_NAME && k.status === 'active');
    const routes = t.routes ? t.routes.filter((r) => available.has(r)) : null;
    let key: string | null = null;
    let keyPrefix: string;
    let keyStatus: SeedResult['keyStatus'];
    if (existing && !opts.rotate) {
      keyPrefix = existing.prefix;
      keyStatus = 'exists';
    } else if (existing) {
      const r = await api.rotateKey(existing.id, { grace_s: 0 });
      key = r.key;
      keyPrefix = r.record.prefix;
      keyStatus = 'rotated';
    } else {
      const r = await api.createKey(t.slug, { name: SEED_KEY_NAME, allowed_routes: routes });
      key = r.key;
      keyPrefix = r.record.prefix;
      keyStatus = 'created';
    }
    out.push({
      team: t.slug,
      teamCreated,
      envVar: t.envVar,
      key,
      keyPrefix,
      keyStatus,
      monthlyBudgetUsd: t.monthlyBudgetUsd,
    });
  }
  return out;
}
