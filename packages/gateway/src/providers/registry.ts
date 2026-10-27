import type { ResolvedConfig } from '../config/resolve.js';
import type { ProviderConfig } from '../config/schema.js';
import type { AdapterDeps, ProviderAdapter } from './base.js';
import { AnthropicAdapter } from './anthropic/index.js';
import { MockAdapter } from './mock.js';
import { OpencodeAdapter } from './opencode/index.js';
import { OpenAIAdapter } from './openai.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

/**
 * Creates the adapter for one configured provider. Register factories with
 * `createGateway({ adapterFactories: { <key>: factory } })`: the key is a built-in provider
 * `type` (to replace that implementation) or the `factory` name of a `type: custom` provider.
 * Called once per config snapshot (again after every reload).
 */
export type AdapterFactory = (
  name: string,
  config: ProviderConfig,
  deps: AdapterDeps,
) => ProviderAdapter;

/** Built-in adapter factories by provider `type`. */
export const builtinFactories: Record<Exclude<ProviderConfig['type'], 'custom'>, AdapterFactory> = {
  opencode: (name, c, deps) =>
    new OpencodeAdapter(name, c as Extract<ProviderConfig, { type: 'opencode' }>, deps),
  'openai-compatible': (name, c, deps) =>
    new OpenAICompatibleAdapter(
      name,
      c as Extract<ProviderConfig, { type: 'openai-compatible' }>,
      deps,
    ),
  openai: (name, c, deps) =>
    new OpenAIAdapter(name, c as Extract<ProviderConfig, { type: 'openai' }>, deps),
  anthropic: (name, c, deps) =>
    new AnthropicAdapter(name, c as Extract<ProviderConfig, { type: 'anthropic' }>, deps),
  mock: (name, c, deps) =>
    new MockAdapter(name, c as Extract<ProviderConfig, { type: 'mock' }>, deps),
};

/** Adapter instances for one config snapshot. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(
    config: ResolvedConfig,
    deps: AdapterDeps,
    factories: Partial<Record<string, AdapterFactory>> = {},
  ) {
    for (const [name, provider] of Object.entries(config.providers)) {
      if (!provider.effectiveEnabled) continue;
      const factory =
        provider.type === 'custom'
          ? factories[provider.factory ?? name]
          : (factories[provider.type] ?? builtinFactories[provider.type]);
      if (!factory) {
        const key = provider.type === 'custom' ? (provider.factory ?? name) : provider.type;
        throw new Error(
          `providers.${name}: no adapter factory registered for "${key}" ` +
            `(pass it in createGateway({ adapterFactories: { "${key}": factory } }))`,
        );
      }
      this.adapters.set(
        name,
        factory(name, provider, { ...deps, logger: deps.logger.child({ provider: name }) }),
      );
    }
  }

  get(name: string): ProviderAdapter | undefined {
    return this.adapters.get(name);
  }

  entries(): [string, ProviderAdapter][] {
    return [...this.adapters.entries()];
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map(async (a) => a.close?.()));
  }
}
