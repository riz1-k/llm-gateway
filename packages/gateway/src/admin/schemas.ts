import { z } from 'zod';
import { GROUP_BY } from '../usage/reports.js';

/** Request bodies of the admin API (also used by the CLI in local mode). */

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'slug: lowercase letters, digits, "-" or "_" (max 63)');

const limit = z.number().int().positive().max(1_000_000_000).nullable().optional();
const usd = z.number().min(0).max(1e9);

export const budgetInputSchema = z.object({
  limit_usd: usd,
  soft_threshold: z.number().gt(0).max(1).default(0.8),
  action: z.enum(['block', 'alert']).default('block'),
  webhook_url: z.url().nullable().optional(),
});
export type BudgetInput = z.infer<typeof budgetInputSchema>;

/** `null` removes the budget for that period; omitted leaves it unchanged. */
export const budgetsInputSchema = z
  .object({
    daily: budgetInputSchema.nullable().optional(),
    monthly: budgetInputSchema.nullable().optional(),
  })
  .strict();
export type BudgetsInput = z.infer<typeof budgetsInputSchema>;

export const createTeamSchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    rpm_limit: limit,
    tpm_limit: limit,
    budgets: budgetsInputSchema.optional(),
  })
  .strict();
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    rpm_limit: limit,
    tpm_limit: limit,
  })
  .strict();
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export const createKeySchema = z
  .object({
    name: z.string().trim().min(1).max(200).default('default'),
    allowed_routes: z.array(z.string().min(1)).max(500).nullable().optional(),
    rpm_limit: limit,
    tpm_limit: limit,
    expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
    expires_in_days: z.number().positive().max(3650).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CreateKeyInput = z.infer<typeof createKeySchema>;

export const rotateKeySchema = z
  .object({
    /** Keep the old key valid for this many seconds (default: revoke immediately). */
    grace_s: z
      .number()
      .int()
      .min(0)
      .max(30 * 86_400)
      .default(0),
  })
  .strict();
export type RotateKeyInput = z.infer<typeof rotateKeySchema>;

export const usageQuerySchema = z.object({
  team: z.string().optional(),
  route: z.string().optional(),
  model: z.string().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  group_by: z.enum(GROUP_BY).default('day'),
});

export const purgeSchema = z
  .object({ route: z.string().min(1).optional(), team: slugSchema.optional() })
  .strict();
export type PurgeInput = z.infer<typeof purgeSchema>;
