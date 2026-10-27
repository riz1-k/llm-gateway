import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { ResolvedConfig } from '../config/resolve.js';
import { GatewayError } from '../core/errors.js';
import {
  budgetsInputSchema,
  createKeySchema,
  createTeamSchema,
  purgeSchema,
  rotateKeySchema,
  updateTeamSchema,
  usageQuerySchema,
} from './schemas.js';
import type { AdminService } from './service.js';

const ACTOR = /^[\w.:@-]{1,64}$/;

/** Audit actor: `api`, or `api:<x-sy-actor>` when the caller identifies itself (CLI, scripts). */
export function actorOf(c: Context): string {
  const a = c.req.header('x-sy-actor');
  return a && ACTOR.test(a) ? `api:${a}` : 'api';
}

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw GatewayError.invalidRequest('Request body must be valid JSON');
    }
  }
  return parse(schema, raw);
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue?.path.join('.') || undefined;
    throw new GatewayError(
      400,
      'invalid_request',
      `${path ? `${path}: ` : ''}${issue?.message ?? 'invalid'}`,
      {
        param: path ?? null,
      },
    );
  }
  return r.data;
}

const SECRET_KEY = /(password|secret|token|api[_-]?key|authorization|cookie|webhook(_url)?)$/i;

/**
 * Config with credentials removed (URLs lose their password; secrets become "[redacted]").
 * Upstream `headers` values are always redacted (they typically carry auth), and webhook URLs
 * too (Slack-style webhooks embed their secret in the path).
 */
export function redactConfig(value: unknown, keyName = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v, keyName));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'key' && typeof v === 'string') out[k] = `${v.slice(0, 12)}…`;
      else if (SECRET_KEY.test(k) && typeof v === 'string' && v) out[k] = '[redacted]';
      else if (k === 'headers' && v && typeof v === 'object' && !Array.isArray(v))
        out[k] = Object.fromEntries(
          Object.keys(v as Record<string, unknown>).map((h) => [h, '[redacted]']),
        );
      else out[k] = redactConfig(v, k);
    }
    return out;
  }
  if (typeof value === 'string' && /url$/i.test(keyName)) {
    try {
      const u = new URL(value);
      if (u.password) u.password = '***';
      return u.toString();
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Platform admin endpoints (SPEC §12), mounted under `/admin` behind the admin-token middleware.
 * `getService` returns undefined when no database is configured → 503.
 */
export function platformAdminRoutes(deps: {
  getService: () => AdminService | undefined;
  config: () => ResolvedConfig;
}): Hono {
  const r = new Hono();
  const svc = (): AdminService => {
    const s = deps.getService();
    if (!s)
      throw new GatewayError(
        503,
        'service_unavailable',
        'Admin data API requires `database.url` to be configured',
      );
    return s;
  };
  const json = (c: Context, v: unknown, status: ContentfulStatusCode = 200) =>
    c.json(v as object, status);

  r.get('/config', (c) => json(c, redactConfig(deps.config().raw)));

  r.post('/teams', async (c) =>
    json(c, await svc().createTeam(actorOf(c), await body(c, createTeamSchema)), 201),
  );
  r.get('/teams', async (c) =>
    json(c, {
      data: await svc().listTeams({ includeDeleted: c.req.query('include_deleted') === 'true' }),
    }),
  );
  r.get('/teams/:id', async (c) => json(c, await svc().getTeam(c.req.param('id'))));
  r.patch('/teams/:id', async (c) =>
    json(c, await svc().updateTeam(actorOf(c), c.req.param('id'), await body(c, updateTeamSchema))),
  );
  r.delete('/teams/:id', async (c) =>
    json(c, await svc().deleteTeam(actorOf(c), c.req.param('id'))),
  );

  r.post('/teams/:id/keys', async (c) =>
    json(
      c,
      await svc().createKey(actorOf(c), c.req.param('id'), await body(c, createKeySchema)),
      201,
    ),
  );
  r.get('/teams/:id/keys', async (c) =>
    json(c, {
      data: await svc().listKeys(c.req.param('id'), {
        includeRevoked: c.req.query('include_revoked') === 'true',
      }),
    }),
  );
  r.post('/keys/:id/revoke', async (c) =>
    json(c, await svc().revokeKey(actorOf(c), c.req.param('id'))),
  );
  r.post('/keys/:id/rotate', async (c) =>
    json(c, await svc().rotateKey(actorOf(c), c.req.param('id'), await body(c, rotateKeySchema))),
  );

  r.put('/teams/:id/budgets', async (c) =>
    json(c, {
      data: await svc().setBudgets(
        actorOf(c),
        c.req.param('id'),
        await body(c, budgetsInputSchema),
      ),
    }),
  );
  r.get('/teams/:id/budget', async (c) => json(c, await svc().budgetStatus(c.req.param('id'))));

  r.get('/usage', async (c) => {
    const q = parse(usageQuerySchema, c.req.query());
    if (q.from && q.to && q.from > q.to)
      throw GatewayError.invalidRequest('`from` must not be after `to`');
    return json(
      c,
      await svc().usage({
        team: q.team,
        route: q.route,
        model: q.model,
        from: q.from,
        to: q.to,
        groupBy: q.group_by,
      }),
    );
  });

  r.post('/cache/purge', async (c) =>
    json(c, await svc().purgeCache(actorOf(c), await body(c, purgeSchema))),
  );
  r.get('/audit', async (c) =>
    json(c, { data: await svc().listAudit(Number(c.req.query('limit') ?? 50) || 50) }),
  );
  return r;
}
