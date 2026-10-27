import { z } from 'zod';

/**
 * Gateway configuration schema (YAML → interpolation → zod).
 *
 * Numeric fields use `z.coerce` so values can come from `${ENV}` interpolation. Sections owned by
 * later subsystems (redis, database, limits, budgets, usage) are parsed and validated here but not
 * enforced by the core.
 */

const port = z.coerce.number().int().min(0).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonNegInt = z.coerce.number().int().min(0);
const ms = z.coerce.number().int().min(1);

/** Optional string where an empty string (e.g. unset `${VAR:-}`) means "not set". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

export const reasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'none',
]);

export const pricingSchema = z.object({
  /** USD per 1M input tokens. */
  input: z.coerce.number().min(0).default(0),
  /** USD per 1M output tokens (reasoning tokens are billed as output). */
  output: z.coerce.number().min(0).default(0),
  /** USD per 1M cached input tokens (defaults to `input`). */
  cached_input: z.coerce.number().min(0).optional(),
  /** USD per 1M cache-write tokens (defaults to `input`). */
  cache_write: z.coerce.number().min(0).optional(),
  /** Flat USD fee per request (e.g. rerank searches). */
  per_request: z.coerce.number().min(0).optional(),
});
export type Pricing = z.infer<typeof pricingSchema>;

const providerCommon = {
  enabled: z.boolean().default(true),
  /** Maximum concurrent upstream requests for this provider (0 = unlimited). */
  max_concurrency: nonNegInt.default(0),
  /** How long a request may wait for a concurrency slot before failing with `upstream_busy`. */
  queue_timeout_ms: ms.default(30_000),
  /** Per-attempt upstream timeout. */
  timeout_ms: ms.default(120_000),
  /** Extra headers sent upstream. */
  headers: z.record(z.string(), z.string()).default({}),
};

export const opencodeProviderSchema = z.object({
  type: z.literal('opencode'),
  ...providerCommon,
  base_url: z.url().default('http://127.0.0.1:4096'),
  username: z.string().default('opencode'),
  password: optionalString,
  /** opencode agent used for every session (should have all built-in tools disabled). */
  agent: z.string().default('gateway'),
  /** opencode providerID for upstream models. */
  upstream_provider: z.string().default('github-copilot'),
  session_title: z.string().default('switchyard'),
  /** `events`: true streaming via opencode's /event SSE; `synthetic`: await then chunk. */
  streaming: z.enum(['events', 'synthetic']).default('events'),
  /** Max repair round-trips for emulated tool calls / JSON mode. */
  repair_attempts: nonNegInt.max(3).default(1),
  /** Models that accept temperature/top_p (others have these params dropped). */
  temperature_models: z.array(z.string()).default([]),
});

export const openaiCompatibleProviderSchema = z.object({
  type: z.literal('openai-compatible'),
  ...providerCommon,
  base_url: z.url(),
  api_key: optionalString,
  /** Whether the upstream supports native `tools` (llama.cpp with --jinja does). */
  supports_tools: z.boolean().default(true),
  /** Whether the upstream supports `stream_options.include_usage`. */
  supports_stream_usage: z.boolean().default(true),
});

export const openaiProviderSchema = z.object({
  type: z.literal('openai'),
  ...providerCommon,
  base_url: z.url().default('https://api.openai.com/v1'),
  api_key: optionalString,
  organization: optionalString,
  project: optionalString,
  /** Disable this provider automatically when `api_key` is empty. */
  enabled_if_key: z.boolean().default(false),
});

export const anthropicProviderSchema = z.object({
  type: z.literal('anthropic'),
  ...providerCommon,
  base_url: z.url().default('https://api.anthropic.com'),
  api_key: optionalString,
  anthropic_version: z.string().default('2023-06-01'),
  /** `max_tokens` is mandatory for Anthropic; used when neither request nor route sets one. */
  default_max_tokens: positiveInt.default(4096),
  /** How `response_format: json_schema` is implemented. */
  json_mode: z.enum(['tool', 'prompt']).default('tool'),
  enabled_if_key: z.boolean().default(false),
});

export const mockFaultSchema = z.object({
  /** Fixed added latency per request. */
  latency_ms: nonNegInt.default(0),
  /** Probability (0..1) of failing with `status`. */
  fail_rate: z.coerce.number().min(0).max(1).default(0),
  /** HTTP status used for injected failures (always fails when set and fail_rate is 0). */
  status: z.coerce.number().int().min(400).max(599).optional(),
  retry_after_s: nonNegInt.optional(),
  /** Fail a stream after emitting N content chunks. */
  stream_fail_after: nonNegInt.optional(),
});
export type MockFault = z.infer<typeof mockFaultSchema>;

export const mockProviderSchema = z.object({
  type: z.literal('mock'),
  ...providerCommon,
  /** Honor `x-mock-*` request headers for fault injection (never enable in production). */
  allow_header_faults: z.boolean().default(false),
  fixed_text: z.string().default('This is a fixed response from the Switchyard mock provider.'),
  embedding_dim: positiveInt.max(8192).default(256),
  /** Minimum lexical overlap for mock-extractive to answer instead of NO_ANSWER. */
  extractive_threshold: z.coerce.number().min(0).max(1).default(0.2),
  /** Scripted tool-call responses for `mock-tools`, keyed by script id. */
  scripts: z.record(z.string(), z.array(z.unknown())).default({}),
  /** Faults applied to every request of this provider. */
  faults: mockFaultSchema.optional(),
});

export const providerSchema = z.discriminatedUnion('type', [
  opencodeProviderSchema,
  openaiCompatibleProviderSchema,
  openaiProviderSchema,
  anthropicProviderSchema,
  mockProviderSchema,
]);
export type ProviderConfig = z.infer<typeof providerSchema>;
export type OpencodeProviderConfig = z.infer<typeof opencodeProviderSchema>;
export type OpenAICompatibleProviderConfig = z.infer<typeof openaiCompatibleProviderSchema>;
export type OpenAIProviderConfig = z.infer<typeof openaiProviderSchema>;
export type AnthropicProviderConfig = z.infer<typeof anthropicProviderSchema>;
export type MockProviderConfig = z.infer<typeof mockProviderSchema>;

export const modelSchema = z.object({
  provider: z.string().min(1),
  /** Upstream model id. */
  model: z.string().min(1),
  kind: z.enum(['chat', 'embedding', 'rerank']).default('chat'),
  /** Per-model base URL override (llama.cpp serves one model per port). */
  base_url: z.url().optional(),
  /** Embedding templates selected by the request's `input_type`; `{text}` is replaced. */
  input_templates: z
    .object({ query: z.string().optional(), document: z.string().optional() })
    .optional(),
  pricing: pricingSchema.optional(),
  /** Per-attempt timeout override. */
  timeout_ms: ms.optional(),
  /** Context window, used for pre-flight estimates only. */
  context_window: positiveInt.optional(),
  /** Request body defaults merged under the client request (OpenAI-family upstreams). */
  params: z.record(z.string(), z.unknown()).default({}),
  /** Provider specific options (e.g. mock faults). */
  options: z.record(z.string(), z.unknown()).default({}),
  description: z.string().optional(),
});
export type ModelConfig = z.infer<typeof modelSchema>;

export const retrySchema = z.object({
  /** Total attempts per target (1 = no retry). */
  attempts: positiveInt.max(10).default(2),
  backoff_ms: nonNegInt.default(250),
  max_backoff_ms: nonNegInt.default(4000),
  /** Upper bound for honoring upstream Retry-After. */
  max_retry_after_ms: nonNegInt.default(20_000),
});
export type RetryConfig = z.infer<typeof retrySchema>;

export const breakerSchema = z.object({
  enabled: z.boolean().default(true),
  window_s: positiveInt.default(30),
  min_requests: positiveInt.default(10),
  failure_rate: z.coerce.number().min(0).max(1).default(0.5),
  consecutive_failures: positiveInt.default(5),
  cooldown_s: z.coerce.number().positive().default(30),
  max_cooldown_s: z.coerce.number().positive().default(300),
});
export type BreakerConfig = z.infer<typeof breakerSchema>;

const routeTargetSchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    weight: z.coerce.number().positive().default(1),
    timeout_ms: ms.optional(),
  }),
]);

export const routeCacheSchema = z.object({
  exact: z.object({ ttl_s: positiveInt, enabled: z.boolean().default(true) }).optional(),
  semantic: z
    .object({
      enabled: z.boolean().default(false),
      embed_route: z.string().optional(),
      min_similarity: z.coerce.number().min(0).max(1).default(0.95),
      ttl_s: positiveInt.optional(),
    })
    .optional(),
  shared: z.boolean().default(false),
});

export const routeSchema = z.object({
  description: z.string().optional(),
  targets: z.array(routeTargetSchema).min(1),
  strategy: z.enum(['fallback', 'weighted', 'least-latency']).default('fallback'),
  retry: retrySchema.optional(),
  /** Total deadline for the whole request across retries and fallbacks. */
  timeout_ms: ms.optional(),
  cache: routeCacheSchema.optional(),
  defaults: z
    .object({
      reasoning_effort: reasoningEffortSchema.nullable().optional(),
      max_tokens: positiveInt.optional(),
      temperature: z.coerce.number().min(0).max(2).optional(),
    })
    .prefault({}),
  /** Hide from GET /v1/models (still callable). */
  hidden: z.boolean().default(false),
});
export type RouteConfig = z.infer<typeof routeSchema>;

export const staticKeySchema = z.object({
  key: optionalString,
  team: z.string().min(1),
  name: z.string().default('static'),
  /** Route names this key may call; omitted = all routes. */
  allowed_routes: z.array(z.string()).optional(),
  /** Allow calling `models:` entries directly by name (not only routes). */
  allow_direct_models: z.boolean().default(false),
  rpm: positiveInt.optional(),
  tpm: positiveInt.optional(),
});

export const configSchema = z.object({
  server: z
    .object({
      port: port.default(8787),
      host: z.string().default('0.0.0.0'),
      request_timeout_ms: ms.default(300_000),
      body_limit_mb: z.coerce.number().positive().default(10),
      shutdown_grace_ms: ms.default(15_000),
    })
    .prefault({}),
  redis: z.object({ url: optionalString, key_prefix: z.string().default('sy:') }).optional(),
  database: z.object({ url: optionalString }).optional(),
  auth: z
    .object({
      admin_token: optionalString,
      static_keys: z.array(staticKeySchema).default([]),
    })
    .prefault({}),
  /** Path to the pricing table (relative to the config file). */
  pricing_file: z.string().optional(),
  breaker: breakerSchema.prefault({}),
  retry: retrySchema.prefault({}),
  providers: z.record(z.string(), providerSchema),
  models: z.record(z.string(), modelSchema),
  routes: z.record(z.string(), routeSchema),
  limits: z
    .object({
      defaults: z
        .object({
          key: z.object({ rpm: positiveInt.optional(), tpm: positiveInt.optional() }).optional(),
          team: z.object({ rpm: positiveInt.optional(), tpm: positiveInt.optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
  budgets: z
    .object({
      enforcement: z.enum(['hard', 'soft', 'off']).default('hard'),
      soft_threshold: z.coerce.number().min(0).max(1).default(0.8),
      alert_webhook: z.string().nullable().optional(),
    })
    .optional(),
  usage: z
    .object({
      stream: z.string().default('sy:usage'),
      batch_size: positiveInt.default(500),
      flush_interval_ms: ms.default(1000),
      retention_days: positiveInt.default(400),
      in_process_writer: z.boolean().default(false),
    })
    .optional(),
  observability: z
    .object({
      log_level: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info'),
      log_bodies: z.boolean().default(false),
      metrics: z.boolean().default(true),
      otel: z
        .object({ enabled: z.boolean().default(false), endpoint: z.string().nullable().optional() })
        .optional(),
    })
    .prefault({}),
});

export type GatewayConfigInput = z.input<typeof configSchema>;
export type GatewayConfig = z.infer<typeof configSchema>;
