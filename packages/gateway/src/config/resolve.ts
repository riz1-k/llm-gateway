import type {
  BreakerConfig,
  GatewayConfig,
  ModelConfig,
  Pricing,
  ProviderConfig,
  RetryConfig,
  RouteConfig,
} from './schema.js';
import type { OperationKind, ReasoningEffort } from '../core/types.js';

/** A concrete upstream model ("target") with everything adapters need. */
export interface ResolvedModel {
  name: string;
  providerName: string;
  provider: ProviderConfig;
  upstreamModel: string;
  kind: OperationKind;
  baseUrl: string | undefined;
  inputTemplates: { query?: string | undefined; document?: string | undefined } | undefined;
  pricing: Pricing | undefined;
  timeoutMs: number;
  params: Record<string, unknown>;
  options: Record<string, unknown>;
  enabled: boolean;
  disabledReason: string | undefined;
  config: ModelConfig;
}

export interface ResolvedRouteTarget {
  model: string;
  weight: number;
  timeoutMs: number | undefined;
}

export interface ResolvedRoute {
  name: string;
  kind: OperationKind;
  description: string | undefined;
  targets: ResolvedRouteTarget[];
  strategy: RouteConfig['strategy'];
  retry: RetryConfig;
  timeoutMs: number;
  cache: RouteConfig['cache'];
  defaults: {
    reasoning_effort?: ReasoningEffort | null | undefined;
    max_tokens?: number | undefined;
    temperature?: number | undefined;
  };
  hidden: boolean;
  /** True for synthetic routes that expose a model directly (allow_direct_models keys). */
  direct: boolean;
}

export interface ResolvedConfig {
  raw: GatewayConfig;
  sourcePath: string | undefined;
  providers: Record<
    string,
    ProviderConfig & { effectiveEnabled: boolean; disabledReason?: string }
  >;
  models: Record<string, ResolvedModel>;
  routes: Record<string, ResolvedRoute>;
  breaker: BreakerConfig;
  pricing: Record<string, Pricing>;
  warnings: string[];
}

function providerEnabled(p: ProviderConfig): { enabled: boolean; reason?: string } {
  if (!p.enabled) return { enabled: false, reason: 'disabled in config' };
  if ((p.type === 'openai' || p.type === 'anthropic') && p.enabled_if_key && !p.api_key) {
    return { enabled: false, reason: 'no api_key configured (enabled_if_key)' };
  }
  return { enabled: true };
}

/** Builds a single-target route used when a key may call `models:` entries directly. */
export function directRoute(model: ResolvedModel, config: ResolvedConfig): ResolvedRoute {
  return {
    name: model.name,
    kind: model.kind,
    description: `Direct access to ${model.providerName}/${model.upstreamModel}`,
    targets: [{ model: model.name, weight: 1, timeoutMs: undefined }],
    strategy: 'fallback',
    retry: config.raw.retry,
    timeoutMs: config.raw.server.request_timeout_ms,
    cache: undefined,
    defaults: {},
    hidden: true,
    direct: true,
  };
}

/** Cross-reference validation + normalization. Returns errors instead of throwing. */
export function resolveConfig(
  config: GatewayConfig,
  pricingTable: Record<string, Pricing>,
): { resolved: ResolvedConfig; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const providers: ResolvedConfig['providers'] = {};
  for (const [name, p] of Object.entries(config.providers)) {
    const state = providerEnabled(p);
    providers[name] = {
      ...p,
      effectiveEnabled: state.enabled,
      ...(state.reason ? { disabledReason: state.reason } : {}),
    };
    if (p.type === 'opencode' && !p.password) {
      warnings.push(`providers.${name}: no password configured for the opencode bridge`);
    }
  }

  const models: Record<string, ResolvedModel> = {};
  for (const [name, m] of Object.entries(config.models)) {
    const provider = providers[m.provider];
    if (!provider) {
      errors.push(
        `models.${name}.provider: unknown provider "${m.provider}" (known: ${Object.keys(providers).join(', ') || 'none'})`,
      );
      continue;
    }
    if (m.input_templates) {
      for (const [k, tpl] of Object.entries(m.input_templates)) {
        if (tpl !== undefined && !tpl.includes('{text}')) {
          errors.push(
            `models.${name}.input_templates.${k}: template must contain the {text} placeholder`,
          );
        }
      }
      if (m.kind !== 'embedding')
        warnings.push(`models.${name}: input_templates only apply to embedding models`);
    }
    if (provider.type === 'opencode' && m.kind !== 'chat') {
      errors.push(`models.${name}: the opencode provider only supports chat models`);
    }
    if (provider.type === 'anthropic' && m.kind !== 'chat') {
      errors.push(`models.${name}: the anthropic provider only supports chat models`);
    }
    if (provider.type === 'openai' && m.kind === 'rerank') {
      errors.push(`models.${name}: the openai provider does not support rerank`);
    }
    const pricing = m.pricing ?? pricingTable[name] ?? pricingTable[m.model];
    models[name] = {
      name,
      providerName: m.provider,
      provider,
      upstreamModel: m.model,
      kind: m.kind,
      baseUrl: m.base_url,
      inputTemplates: m.input_templates,
      pricing,
      timeoutMs: m.timeout_ms ?? provider.timeout_ms,
      params: m.params,
      options: m.options,
      enabled: provider.effectiveEnabled,
      disabledReason: provider.effectiveEnabled
        ? undefined
        : `provider ${m.provider}: ${provider.disabledReason ?? 'disabled'}`,
      config: m,
    };
  }

  const routes: Record<string, ResolvedRoute> = {};
  for (const [name, r] of Object.entries(config.routes)) {
    if (models[name] && config.models[name]) {
      // Allowed, but direct model access will be shadowed by the route.
      warnings.push(`routes.${name}: shadows the model of the same name for direct access`);
    }
    const targets: ResolvedRouteTarget[] = r.targets.map((t) =>
      typeof t === 'string'
        ? { model: t, weight: 1, timeoutMs: undefined }
        : { model: t.model, weight: t.weight, timeoutMs: t.timeout_ms },
    );
    const kinds = new Set<OperationKind>();
    targets.forEach((t, i) => {
      const m = models[t.model];
      if (!m) {
        if (!config.models[t.model])
          errors.push(`routes.${name}.targets[${i}]: unknown model "${t.model}"`);
        return;
      }
      kinds.add(m.kind);
    });
    if (kinds.size > 1)
      errors.push(`routes.${name}: targets mix model kinds (${[...kinds].join(', ')})`);
    const seen = new Set<string>();
    for (const t of targets) {
      if (seen.has(t.model)) errors.push(`routes.${name}: duplicate target "${t.model}"`);
      seen.add(t.model);
    }
    if (
      r.cache?.semantic?.enabled &&
      r.cache.semantic.embed_route &&
      !config.routes[r.cache.semantic.embed_route]
    ) {
      errors.push(
        `routes.${name}.cache.semantic.embed_route: unknown route "${r.cache.semantic.embed_route}"`,
      );
    }
    if (targets.every((t) => models[t.model] && !models[t.model]!.enabled)) {
      warnings.push(
        `routes.${name}: every target is disabled; requests will fail with upstream_unavailable`,
      );
    }
    routes[name] = {
      name,
      kind: [...kinds][0] ?? 'chat',
      description: r.description,
      targets,
      strategy: r.strategy,
      retry: r.retry ?? config.retry,
      timeoutMs: r.timeout_ms ?? config.server.request_timeout_ms,
      cache: r.cache,
      defaults: r.defaults,
      hidden: r.hidden,
      direct: false,
    };
  }

  const seenKeys = new Set<string>();
  config.auth.static_keys.forEach((k, i) => {
    if (!k.key) {
      warnings.push(`auth.static_keys[${i}] (${k.name}): key is empty, skipped`);
      return;
    }
    if (seenKeys.has(k.key)) errors.push(`auth.static_keys[${i}]: duplicate key`);
    seenKeys.add(k.key);
    if (k.key.length < 12)
      errors.push(`auth.static_keys[${i}]: key must be at least 12 characters`);
    for (const route of k.allowed_routes ?? []) {
      if (!config.routes[route] && !config.models[route]) {
        errors.push(`auth.static_keys[${i}].allowed_routes: unknown route "${route}"`);
      }
    }
  });
  if (config.auth.admin_token && seenKeys.has(config.auth.admin_token)) {
    errors.push('auth.admin_token must differ from every static key');
  }

  return {
    resolved: {
      raw: config,
      sourcePath: undefined,
      providers,
      models,
      routes,
      breaker: config.breaker,
      pricing: pricingTable,
      warnings,
    },
    errors,
  };
}
