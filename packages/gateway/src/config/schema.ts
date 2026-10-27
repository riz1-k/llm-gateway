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

export const reasoningEffortSchema = z
  .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'])
  .describe('Reasoning effort hint, mapped per provider (dropped where unsupported).');

export const pricingSchema = z
  .object({
    input: z.coerce.number().min(0).default(0).describe('USD per 1M input tokens.'),
    output: z.coerce
      .number()
      .min(0)
      .default(0)
      .describe('USD per 1M output tokens (reasoning tokens are billed as output).'),
    cached_input: z.coerce
      .number()
      .min(0)
      .optional()
      .describe('USD per 1M cached input tokens (defaults to `input`).'),
    cache_write: z.coerce
      .number()
      .min(0)
      .optional()
      .describe('USD per 1M cache-write tokens (defaults to `input`).'),
    per_request: z.coerce
      .number()
      .min(0)
      .optional()
      .describe('Flat USD fee per request (e.g. rerank searches).'),
  })
  .describe('Model pricing (USD per 1M tokens). Overrides the pricing_file entry.');
/** Model pricing in USD per 1M tokens (plus an optional flat per-request fee). */
export type Pricing = z.infer<typeof pricingSchema>;

const providerCommon = {
  enabled: z
    .boolean()
    .default(true)
    .describe('Set false to disable the provider (and its models).'),
  max_concurrency: nonNegInt
    .default(0)
    .describe('Maximum concurrent upstream requests for this provider (0 = unlimited).'),
  queue_timeout_ms: ms
    .default(30_000)
    .describe(
      'How long a request may wait for a concurrency slot before failing with `upstream_busy`.',
    ),
  timeout_ms: ms.default(120_000).describe('Per-attempt upstream timeout.'),
  headers: z.record(z.string(), z.string()).default({}).describe('Extra headers sent upstream.'),
};

export const opencodeProviderSchema = z.object({
  type: z
    .literal('opencode')
    .describe('Bridge to an `opencode serve` instance (e.g. GitHub Copilot models).'),
  ...providerCommon,
  base_url: z.url().default('http://127.0.0.1:4096').describe('opencode server URL.'),
  username: z.string().default('opencode').describe('Basic-auth user of the opencode server.'),
  password: optionalString.describe('Basic-auth password (`OPENCODE_SERVER_PASSWORD`).'),
  agent: z
    .string()
    .default('gateway')
    .describe('opencode agent used for every session (should have all built-in tools disabled).'),
  upstream_provider: z
    .string()
    .default('github-copilot')
    .describe('opencode providerID for upstream models.'),
  session_title: z
    .string()
    .default('switchyard')
    .describe('Title prefix of the (always deleted) per-request sessions.'),
  streaming: z
    .enum(['events', 'synthetic'])
    .default('events')
    .describe("`events`: true streaming via opencode's /event SSE; `synthetic`: await then chunk."),
  repair_attempts: nonNegInt
    .max(3)
    .default(1)
    .describe('Max repair round-trips for emulated tool calls / JSON mode.'),
  temperature_models: z
    .array(z.string())
    .default([])
    .describe('Models that accept temperature/top_p (others have these params dropped).'),
});

export const openaiCompatibleProviderSchema = z.object({
  type: z
    .literal('openai-compatible')
    .describe('Any OpenAI-compatible server: llama.cpp, vLLM, Ollama, Groq, OpenRouter, …'),
  ...providerCommon,
  base_url: z.url().describe('API base URL including `/v1` (models may override it).'),
  api_key: optionalString.describe('Bearer token, if the server needs one.'),
  supports_tools: z
    .boolean()
    .default(true)
    .describe('Whether the upstream supports native `tools` (llama.cpp with --jinja does).'),
  supports_stream_usage: z
    .boolean()
    .default(true)
    .describe('Whether the upstream supports `stream_options.include_usage`.'),
});

export const openaiProviderSchema = z.object({
  type: z.literal('openai').describe('OpenAI API (native passthrough).'),
  ...providerCommon,
  base_url: z.url().default('https://api.openai.com/v1').describe('API base URL.'),
  api_key: optionalString.describe('OpenAI API key (`OPENAI_API_KEY`).'),
  organization: optionalString.describe('`OpenAI-Organization` header.'),
  project: optionalString.describe('`OpenAI-Project` header.'),
  enabled_if_key: z
    .boolean()
    .default(false)
    .describe('Disable this provider automatically when `api_key` is empty.'),
});

export const anthropicProviderSchema = z.object({
  type: z
    .literal('anthropic')
    .describe('Anthropic Messages API (translated from/to OpenAI shape).'),
  ...providerCommon,
  base_url: z.url().default('https://api.anthropic.com').describe('API base URL.'),
  api_key: optionalString.describe('Anthropic API key (`ANTHROPIC_API_KEY`).'),
  anthropic_version: z.string().default('2023-06-01').describe('`anthropic-version` header.'),
  default_max_tokens: positiveInt
    .default(4096)
    .describe(
      '`max_tokens` is mandatory for Anthropic; used when neither request nor route sets one.',
    ),
  json_mode: z
    .enum(['tool', 'prompt'])
    .default('tool')
    .describe('How `response_format: json_schema` is implemented.'),
  enabled_if_key: z
    .boolean()
    .default(false)
    .describe('Disable this provider automatically when `api_key` is empty.'),
});

export const mockFaultSchema = z.object({
  latency_ms: nonNegInt.default(0).describe('Fixed added latency per request.'),
  fail_rate: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Probability (0..1) of failing with `status`.'),
  status: z.coerce
    .number()
    .int()
    .min(400)
    .max(599)
    .optional()
    .describe('HTTP status used for injected failures (always fails when set and fail_rate is 0).'),
  retry_after_s: nonNegInt
    .optional()
    .describe('`Retry-After` (seconds) sent with injected failures.'),
  stream_fail_after: nonNegInt
    .optional()
    .describe('Fail a stream after emitting N content chunks.'),
});
export type MockFault = z.infer<typeof mockFaultSchema>;

export const mockProviderSchema = z.object({
  type: z.literal('mock').describe('Deterministic in-process mock (tests, demos, benchmarks).'),
  ...providerCommon,
  allow_header_faults: z
    .boolean()
    .default(false)
    .describe('Honor `x-mock-*` request headers for fault injection (never enable in production).'),
  fixed_text: z
    .string()
    .default('This is a fixed response from the Switchyard mock provider.')
    .describe('Reply of the `mock-fixed` model.'),
  embedding_dim: positiveInt.max(8192).default(256).describe('Dimension of `mock-embed` vectors.'),
  extractive_threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.2)
    .describe('Minimum lexical overlap for mock-extractive to answer instead of NO_ANSWER.'),
  scripts: z
    .record(z.string(), z.array(z.unknown()))
    .default({})
    .describe('Scripted tool-call responses for `mock-tools`, keyed by script id.'),
  faults: mockFaultSchema.optional().describe('Faults applied to every request of this provider.'),
});

/**
 * A provider implemented by your own adapter (library use only): register an `AdapterFactory`
 * under `factory` (default: the provider's name) via `createGateway({ adapterFactories })`.
 */
export const customProviderSchema = z.object({
  type: z
    .literal('custom')
    .describe('Your own adapter, registered via `createGateway({ adapterFactories })`.'),
  ...providerCommon,
  factory: z
    .string()
    .min(1)
    .optional()
    .describe('Key in `createGateway({ adapterFactories })`; defaults to the provider name.'),
  base_url: z.url().optional().describe('Passed to the factory unchanged.'),
  api_key: optionalString.describe('Passed to the factory unchanged.'),
  options: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('Free-form settings handed to the factory unchanged.'),
});

export const providerSchema = z.discriminatedUnion('type', [
  opencodeProviderSchema,
  openaiCompatibleProviderSchema,
  openaiProviderSchema,
  anthropicProviderSchema,
  mockProviderSchema,
  customProviderSchema,
]);
/** Config of one provider, discriminated by `type`. */
export type ProviderConfig = z.infer<typeof providerSchema>;
export type OpencodeProviderConfig = z.infer<typeof opencodeProviderSchema>;
export type OpenAICompatibleProviderConfig = z.infer<typeof openaiCompatibleProviderSchema>;
export type OpenAIProviderConfig = z.infer<typeof openaiProviderSchema>;
export type AnthropicProviderConfig = z.infer<typeof anthropicProviderSchema>;
export type MockProviderConfig = z.infer<typeof mockProviderSchema>;
/** Config of a `type: custom` provider (served by your own `AdapterFactory`). */
export type CustomProviderConfig = z.infer<typeof customProviderSchema>;

export const modelSchema = z.object({
  provider: z.string().min(1).describe('Name of an entry in `providers`.'),
  model: z.string().min(1).describe('Upstream model id.'),
  kind: z
    .enum(['chat', 'embedding', 'rerank'])
    .default('chat')
    .describe('What the model serves; routes may only mix models of one kind.'),
  base_url: z
    .url()
    .optional()
    .describe('Per-model base URL override (llama.cpp serves one model per port).'),
  input_templates: z
    .object({
      query: z.string().optional().describe('Template for `input_type: query`.'),
      document: z.string().optional().describe('Template for `input_type: document`.'),
    })
    .optional()
    .describe(
      "Embedding templates selected by the request's `input_type`; `{text}` and `{title}` are replaced.",
    ),
  pricing: pricingSchema.optional(),
  timeout_ms: ms.optional().describe('Per-attempt timeout override.'),
  context_window: positiveInt
    .optional()
    .describe('Context window, used for pre-flight estimates only.'),
  params: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('Request body defaults merged under the client request (OpenAI-family upstreams).'),
  options: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('Provider specific options (e.g. mock faults).'),
  description: z.string().optional().describe('Free text (shown nowhere; for humans).'),
});
export type ModelConfig = z.infer<typeof modelSchema>;

export const retrySchema = z.object({
  attempts: positiveInt.max(10).default(2).describe('Total attempts per target (1 = no retry).'),
  backoff_ms: nonNegInt
    .default(250)
    .describe('Base delay of exponential backoff with full jitter.'),
  max_backoff_ms: nonNegInt.default(4000).describe('Cap of the backoff delay.'),
  max_retry_after_ms: nonNegInt
    .default(20_000)
    .describe('Upper bound for honoring upstream Retry-After.'),
});
export type RetryConfig = z.infer<typeof retrySchema>;

export const breakerSchema = z.object({
  enabled: z.boolean().default(true).describe('Enable per-target circuit breakers.'),
  window_s: positiveInt.default(30).describe('Rolling window for the failure rate.'),
  min_requests: positiveInt
    .default(10)
    .describe('Minimum requests in the window before the failure rate can trip the breaker.'),
  failure_rate: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe('Failure rate (0..1) that opens the breaker.'),
  consecutive_failures: positiveInt
    .default(5)
    .describe('Consecutive failures that open the breaker regardless of the rate.'),
  cooldown_s: z.coerce
    .number()
    .positive()
    .default(30)
    .describe('First open period; doubles on every re-trip.'),
  max_cooldown_s: z.coerce.number().positive().default(300).describe('Cap of the open period.'),
});
export type BreakerConfig = z.infer<typeof breakerSchema>;

const routeTargetSchema = z.union([
  z.string().min(1).describe('Model name (entry in `models`).'),
  z.object({
    model: z.string().min(1).describe('Model name (entry in `models`).'),
    weight: z.coerce.number().positive().default(1).describe('Share for `strategy: weighted`.'),
    timeout_ms: ms.optional().describe('Per-attempt timeout for this target.'),
  }),
]);

export const routeCacheSchema = z.object({
  exact: z
    .object({
      ttl_s: positiveInt.describe('Entry lifetime in seconds.'),
      enabled: z.boolean().default(true).describe('Set false to disable without removing the TTL.'),
    })
    .optional()
    .describe('Exact-match cache for deterministic requests (temperature unset/0, n ≤ 1).'),
  semantic: z
    .object({
      enabled: z.boolean().default(false).describe('Turn the semantic cache on for this route.'),
      embed_route: z.string().optional().describe('Embedding route used to embed the prompt.'),
      min_similarity: z.coerce
        .number()
        .min(0)
        .max(1)
        .default(0.95)
        .describe('Cosine similarity needed for a semantic hit.'),
      ttl_s: positiveInt.optional().describe('Entry lifetime (default: the exact TTL).'),
    })
    .optional()
    .describe('Semantic cache on Redis 8 vector sets (needs Redis; requests without tools only).'),
  shared: z
    .boolean()
    .default(false)
    .describe('Share entries across teams (default: namespaced per team).'),
});

export const routeSchema = z.object({
  description: z.string().optional().describe('Shown in `GET /v1/models`.'),
  targets: z
    .array(routeTargetSchema)
    .min(1)
    .describe('Models this route dispatches to (in fallback order for `fallback`).'),
  strategy: z
    .enum(['fallback', 'weighted', 'least-latency'])
    .default('fallback')
    .describe('How targets are ordered per request.'),
  retry: retrySchema.optional().describe('Overrides the top-level `retry` for this route.'),
  timeout_ms: ms
    .optional()
    .describe('Total deadline for the whole request across retries and fallbacks.'),
  cache: routeCacheSchema.optional().describe('Response caching (off unless configured).'),
  defaults: z
    .object({
      reasoning_effort: reasoningEffortSchema
        .nullable()
        .optional()
        .describe('Default `reasoning_effort` (null = none).'),
      max_tokens: positiveInt
        .optional()
        .describe('Default `max_tokens`; also bounds the pre-flight cost estimate.'),
      temperature: z.coerce.number().min(0).max(2).optional().describe('Default `temperature`.'),
    })
    .prefault({})
    .describe('Request parameters applied when the client does not set them.'),
  hidden: z.boolean().default(false).describe('Hide from GET /v1/models (still callable).'),
});
export type RouteConfig = z.infer<typeof routeSchema>;

export const staticKeySchema = z.object({
  key: optionalString.describe(
    'The key, ≥ 12 characters (use `${ENV}`); entries with an empty key are skipped with a warning.',
  ),
  team: z.string().min(1).describe('Team slug the key belongs to.'),
  name: z.string().default('static').describe('Label used in logs and usage reports.'),
  allowed_routes: z
    .array(z.string())
    .optional()
    .describe('Route names this key may call; omitted = all routes.'),
  allow_direct_models: z
    .boolean()
    .default(false)
    .describe('Allow calling `models:` entries directly by name (not only routes).'),
  rpm: positiveInt.optional().describe('Requests per minute for this key.'),
  tpm: positiveInt.optional().describe('Tokens per minute for this key.'),
});

/**
 * zod schema of `gateway.yaml` (after `${ENV}` interpolation). The published `config.schema.json`
 * is generated from it.
 */
export const configSchema = z.object({
  server: z
    .object({
      port: port.default(8787).describe('Listen port (`PORT` env / `--port` override it).'),
      host: z.string().default('0.0.0.0').describe('Bind address.'),
      request_timeout_ms: ms
        .default(300_000)
        .describe('Hard cap for one request, streams included.'),
      body_limit_mb: z.coerce.number().positive().default(10).describe('Max request body size.'),
      shutdown_grace_ms: ms
        .default(15_000)
        .describe('How long SIGTERM waits for in-flight requests to drain.'),
    })
    .prefault({})
    .describe('HTTP server.'),
  redis: z
    .object({
      url: optionalString.describe(
        'Redis 8 URL. Enables shared limits, budgets, caches, breakers and the usage stream.',
      ),
      key_prefix: z.string().default('sy:').describe('Prefix of every Redis key.'),
      fail_open: z
        .boolean()
        .default(true)
        .describe(
          'Admit requests when Redis is unreachable (rate limits / budgets are skipped, logged).',
        ),
      connect_timeout_ms: ms.default(5_000).describe('Connect timeout of the Redis clients.'),
    })
    .optional()
    .describe('Redis (optional; without it everything is in-memory, per process).'),
  database: z
    .object({
      url: optionalString.describe(
        'Postgres URL. Enables database keys/teams/budgets, the usage ledger and the admin API.',
      ),
      pool_max: positiveInt.max(100).default(10).describe('Connection pool size.'),
    })
    .optional()
    .describe('Postgres (optional; required for database keys, budgets and usage reports).'),
  auth: z
    .object({
      admin_token: optionalString.describe(
        'Bearer token of the admin API (`SWITCHYARD_ADMIN_TOKEN`); admin API is off when unset.',
      ),
      static_keys: z
        .array(staticKeySchema)
        .default([])
        .describe('Keys defined in config (bootstrap/dev/CI); database keys are the normal path.'),
      key_cache_ttl_s: positiveInt
        .default(60)
        .describe('TTL of the Redis key-record cache (DB keys). Revocation is pushed via pub/sub.'),
      local_key_cache_ttl_ms: nonNegInt
        .default(5_000)
        .describe('TTL of the per-process key cache in front of Redis.'),
    })
    .prefault({})
    .describe('Client authentication.'),
  pricing_file: z
    .string()
    .optional()
    .describe('Path to the pricing table (relative to the config file).'),
  breaker: breakerSchema.prefault({}).describe('Circuit breaker defaults (per target).'),
  retry: retrySchema.prefault({}).describe('Retry defaults (routes may override).'),
  providers: z
    .record(z.string(), providerSchema)
    .describe('Upstream connections, by name. Discriminated by `type`.'),
  models: z
    .record(z.string(), modelSchema)
    .describe('Concrete upstream models ("targets"), by name.'),
  routes: z
    .record(z.string(), routeSchema)
    .describe('Virtual models exposed to clients: the `model` field of every request.'),
  limits: z
    .object({
      defaults: z
        .object({
          key: z
            .object({
              rpm: positiveInt.optional().describe('Requests per minute.'),
              tpm: positiveInt.optional().describe('Tokens per minute (prompt estimate + output).'),
            })
            .optional()
            .describe('Default per-key limits (key records override).'),
          team: z
            .object({
              rpm: positiveInt.optional().describe('Requests per minute.'),
              tpm: positiveInt.optional().describe('Tokens per minute (prompt estimate + output).'),
            })
            .optional()
            .describe('Default per-team limits (team records override).'),
        })
        .optional()
        .describe('Limits for keys and teams that set none themselves.'),
      window_s: positiveInt
        .default(60)
        .describe('Sliding-window length; RPM/TPM are defined per window (keep at 60).'),
    })
    .optional()
    .describe('Rate limits (need Redis).'),
  budgets: z
    .object({
      enforcement: z
        .enum(['hard', 'soft', 'off'])
        .default('hard')
        .describe('`hard` blocks with 402, `soft` only alerts, `off` disables budgets.'),
      soft_threshold: z.coerce
        .number()
        .min(0)
        .max(1)
        .default(0.8)
        .describe('Utilization that fires the soft alert (budgets may override).'),
      alert_webhook: z
        .string()
        .nullable()
        .optional()
        .describe('URL that receives budget alerts as JSON (one attempt, deduplicated).'),
      reconcile_interval_s: positiveInt
        .default(300)
        .describe('How often the worker reconciles Redis spend counters from Postgres rollups.'),
      definitions_ttl_ms: nonNegInt
        .default(30_000)
        .describe('TTL of the per-process cache of team budget definitions.'),
    })
    .optional()
    .describe('Team budgets (need Redis + Postgres).'),
  usage: z
    .object({
      stream: z.string().default('sy:usage').describe('Redis stream that carries usage events.'),
      batch_size: positiveInt.default(500).describe('Max events per worker insert.'),
      flush_interval_ms: ms.default(1000).describe('Worker poll / flush interval.'),
      retention_days: positiveInt
        .default(400)
        .describe('Monthly usage partitions older than this are dropped.'),
      in_process_writer: z
        .boolean()
        .default(false)
        .describe('Run the usage worker inside the gateway process (single-node setups).'),
      stream_maxlen: positiveInt.default(1_000_000).describe('Approximate MAXLEN for XADD.'),
      buffer_max: positiveInt
        .default(10_000)
        .describe(
          'Events kept in memory while Redis is unavailable; older events are dropped beyond this.',
        ),
      consumer_group: z
        .string()
        .default('writers')
        .describe('Redis consumer group of the workers.'),
      claim_idle_ms: ms
        .default(60_000)
        .describe(
          'Pending entries idle longer than this are reclaimed (XAUTOCLAIM) from dead consumers.',
        ),
      partitions_ahead: nonNegInt
        .max(24)
        .default(2)
        .describe('Monthly partitions created ahead of time.'),
    })
    .optional()
    .describe('Usage pipeline (Redis stream → worker → Postgres).'),
  metrics: z
    .object({
      enabled: z.boolean().default(true).describe('Expose Prometheus metrics.'),
      port: port
        .optional()
        .describe('Serve /metrics on a separate port (e.g. 9464) instead of the API port.'),
      path: z.string().default('/metrics').describe('Metrics endpoint path.'),
      default_metrics: z
        .boolean()
        .default(true)
        .describe("Include prom-client's Node.js process metrics."),
    })
    .prefault({})
    .describe('Prometheus metrics (see docs/METRICS.md).'),
  observability: z
    .object({
      log_level: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info')
        .describe('pino log level.'),
      log_bodies: z
        .boolean()
        .default(false)
        .describe('Reserved: prompt/response body logging is not implemented yet.'),
      metrics: z
        .boolean()
        .default(true)
        .describe('Legacy switch; metrics are on only when this and `metrics.enabled` are true.'),
      otel: z
        .object({
          enabled: z.boolean().default(false).describe('Reserved.'),
          endpoint: z.string().nullable().optional().describe('Reserved.'),
        })
        .optional()
        .describe('Reserved: OpenTelemetry tracing is not implemented yet.'),
    })
    .prefault({})
    .describe('Logging.'),
});

/** Gateway configuration as written (YAML/JSON input shape of `configSchema`). */
export type GatewayConfigInput = z.input<typeof configSchema>;
/** Validated gateway configuration (defaults applied, before cross-reference resolution). */
export type GatewayConfig = z.infer<typeof configSchema>;
