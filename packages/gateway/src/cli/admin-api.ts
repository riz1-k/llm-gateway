import { userInfo } from 'node:os';
import type { z } from 'zod';
import {
  budgetsInputSchema,
  createKeySchema,
  createTeamSchema,
  purgeSchema,
  rotateKeySchema,
  type PurgeInput,
} from '../admin/schemas.js';
import type {
  AdminService,
  BudgetView,
  CreatedKey,
  KeyView,
  TeamBudgetReport,
  TeamView,
} from '../admin/service.js';
import type { ResolvedConfig } from '../config/resolve.js';
import { GatewayError } from '../core/errors.js';
import type { GroupBy, UsageReport } from '../usage/reports.js';

type In<S extends z.ZodType> = z.input<S>;

export interface UsageArgs {
  team?: string | undefined;
  route?: string | undefined;
  model?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  groupBy: GroupBy;
}

/** What the CLI needs from the admin API; implemented in-process and over HTTP. */
export interface AdminApi {
  readonly mode: 'local' | 'http';
  routes(): Promise<string[]>;
  createTeam(input: In<typeof createTeamSchema>): Promise<TeamView>;
  listTeams(): Promise<TeamView[]>;
  getTeam(idOrSlug: string): Promise<TeamView | null>;
  deleteTeam(idOrSlug: string): Promise<TeamView>;
  createKey(team: string, input: In<typeof createKeySchema>): Promise<CreatedKey>;
  listKeys(team: string, includeRevoked: boolean): Promise<KeyView[]>;
  revokeKey(id: string): Promise<KeyView>;
  rotateKey(
    id: string,
    input: In<typeof rotateKeySchema>,
  ): Promise<CreatedKey & { previous: KeyView }>;
  setBudgets(team: string, input: In<typeof budgetsInputSchema>): Promise<BudgetView[]>;
  budgetStatus(team: string): Promise<TeamBudgetReport>;
  usage(q: UsageArgs): Promise<UsageReport>;
  purgeCache(input: PurgeInput): Promise<{ deleted: number }>;
  close(): Promise<void>;
}

function validate<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new GatewayError(
      400,
      'invalid_request',
      `${issue?.path.join('.') || 'input'}: ${issue?.message}`,
    );
  }
  return r.data;
}

const cliActor = (): string => {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    return 'cli';
  }
};

/** In-process: talks to Postgres/Redis directly through the AdminService. */
export class LocalAdminApi implements AdminApi {
  readonly mode = 'local' as const;
  private readonly actor = cliActor();
  constructor(
    private readonly svc: AdminService,
    private readonly config: ResolvedConfig,
    private readonly onClose: () => Promise<void>,
  ) {}
  async routes() {
    return Object.keys(this.config.routes);
  }
  createTeam(input: In<typeof createTeamSchema>) {
    return this.svc.createTeam(this.actor, validate(createTeamSchema, input));
  }
  listTeams() {
    return this.svc.listTeams();
  }
  async getTeam(id: string) {
    try {
      return await this.svc.getTeam(id);
    } catch (err) {
      if (err instanceof GatewayError && err.status === 404) return null;
      throw err;
    }
  }
  deleteTeam(id: string) {
    return this.svc.deleteTeam(this.actor, id);
  }
  createKey(team: string, input: In<typeof createKeySchema>) {
    return this.svc.createKey(this.actor, team, validate(createKeySchema, input));
  }
  listKeys(team: string, includeRevoked: boolean) {
    return this.svc.listKeys(team, { includeRevoked });
  }
  revokeKey(id: string) {
    return this.svc.revokeKey(this.actor, id);
  }
  rotateKey(id: string, input: In<typeof rotateKeySchema>) {
    return this.svc.rotateKey(this.actor, id, validate(rotateKeySchema, input));
  }
  setBudgets(team: string, input: In<typeof budgetsInputSchema>) {
    return this.svc.setBudgets(this.actor, team, validate(budgetsInputSchema, input));
  }
  budgetStatus(team: string) {
    return this.svc.budgetStatus(team);
  }
  usage(q: UsageArgs) {
    return this.svc.usage(q);
  }
  purgeCache(input: PurgeInput) {
    return this.svc.purgeCache(this.actor, validate(purgeSchema, input));
  }
  close() {
    return this.onClose();
  }
}

/** Remote: calls a running gateway's admin API with the admin token. */
export class HttpAdminApi implements AdminApi {
  readonly mode = 'http' as const;
  private readonly actor = cliActor().replace(/^cli:/, 'cli-');
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/admin${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-sy-actor': this.actor,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const e = (json as { error?: { message?: string; code?: string } } | undefined)?.error;
      throw new GatewayError(
        res.status,
        (e?.code as never) ?? 'internal_error',
        e?.message ?? `HTTP ${res.status}`,
      );
    }
    return json as T;
  }

  async routes() {
    const cfg = await this.call<{ routes?: Record<string, unknown> }>('GET', '/config');
    return Object.keys(cfg.routes ?? {});
  }
  createTeam(input: In<typeof createTeamSchema>) {
    return this.call<TeamView>('POST', '/teams', input);
  }
  async listTeams() {
    return (await this.call<{ data: TeamView[] }>('GET', '/teams')).data;
  }
  async getTeam(id: string) {
    try {
      return await this.call<TeamView>('GET', `/teams/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof GatewayError && err.status === 404) return null;
      throw err;
    }
  }
  deleteTeam(id: string) {
    return this.call<TeamView>('DELETE', `/teams/${encodeURIComponent(id)}`);
  }
  createKey(team: string, input: In<typeof createKeySchema>) {
    return this.call<CreatedKey>('POST', `/teams/${encodeURIComponent(team)}/keys`, input);
  }
  async listKeys(team: string, includeRevoked: boolean) {
    return (
      await this.call<{ data: KeyView[] }>(
        'GET',
        `/teams/${encodeURIComponent(team)}/keys${includeRevoked ? '?include_revoked=true' : ''}`,
      )
    ).data;
  }
  revokeKey(id: string) {
    return this.call<KeyView>('POST', `/keys/${encodeURIComponent(id)}/revoke`);
  }
  rotateKey(id: string, input: In<typeof rotateKeySchema>) {
    return this.call<CreatedKey & { previous: KeyView }>(
      'POST',
      `/keys/${encodeURIComponent(id)}/rotate`,
      input,
    );
  }
  async setBudgets(team: string, input: In<typeof budgetsInputSchema>) {
    return (
      await this.call<{ data: BudgetView[] }>(
        'PUT',
        `/teams/${encodeURIComponent(team)}/budgets`,
        input,
      )
    ).data;
  }
  budgetStatus(team: string) {
    return this.call<TeamBudgetReport>('GET', `/teams/${encodeURIComponent(team)}/budget`);
  }
  usage(q: UsageArgs) {
    const params = new URLSearchParams({ group_by: q.groupBy });
    for (const k of ['team', 'route', 'model', 'from', 'to'] as const) {
      const v = q[k];
      if (v) params.set(k, v);
    }
    return this.call<UsageReport>('GET', `/usage?${params.toString()}`);
  }
  purgeCache(input: PurgeInput) {
    return this.call<{ deleted: number }>('POST', '/cache/purge', input);
  }
  async close() {}
}
