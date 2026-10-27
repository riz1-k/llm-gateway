import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { interpolate, InterpolationError } from './interpolate.js';
import { configSchema, pricingSchema, type GatewayConfig, type Pricing } from './schema.js';
import { resolveConfig, type ResolvedConfig } from './resolve.js';

/** Invalid or unreadable configuration. `details` lists one `path: message` entry per problem. */
export class ConfigError extends Error {
  readonly details: string[];
  /** The first line of the message, without the details. */
  readonly summary: string;
  constructor(message: string, details: string[] = []) {
    super(
      details.length > 0 ? `${message}\n${details.map((d) => `  - ${d}`).join('\n')}` : message,
    );
    this.name = 'ConfigError';
    this.details = details;
    this.summary = message;
  }
}

/** Options for `loadConfig` / `parseConfig` / `parseConfigText`. */
export interface LoadOptions {
  env?: Record<string, string | undefined>;
  /** Base directory for relative paths (pricing_file); defaults to the config file's directory. */
  baseDir?: string;
  /** Pre-loaded pricing table (skips reading pricing_file). */
  pricing?: Record<string, Pricing>;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.') || '<root>';
    return `${path}: ${issue.message}`;
  });
}

/** Validates an already-parsed (and not yet interpolated) config object. */
export function parseConfig(raw: unknown, opts: LoadOptions = {}): ResolvedConfig {
  let interpolated: unknown;
  try {
    interpolated = interpolate(raw ?? {}, opts.env ?? process.env);
  } catch (err) {
    if (err instanceof InterpolationError) {
      throw new ConfigError(
        'Invalid configuration',
        err.issues.map(
          (i) =>
            `${i.path}: environment variable ${i.variable} is not set (use \${${i.variable}:-default})`,
        ),
      );
    }
    throw err;
  }
  const parsed = configSchema.safeParse(interpolated);
  if (!parsed.success)
    throw new ConfigError('Invalid configuration', formatZodIssues(parsed.error));
  const config: GatewayConfig = parsed.data;

  let pricing = opts.pricing ?? {};
  if (!opts.pricing && config.pricing_file) {
    const file = isAbsolute(config.pricing_file)
      ? config.pricing_file
      : resolve(opts.baseDir ?? process.cwd(), config.pricing_file);
    pricing = loadPricingFile(file);
  }
  const { resolved, errors } = resolveConfig(config, pricing);
  if (errors.length > 0) throw new ConfigError('Invalid configuration', errors);
  return resolved;
}

/** Parses YAML text, then interpolates, validates and resolves it like `loadConfig`. */
export function parseConfigText(text: string, opts: LoadOptions = {}): ResolvedConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: true });
  } catch (err) {
    throw new ConfigError(`Config is not valid YAML: ${(err as Error).message}`);
  }
  return parseConfig(raw, opts);
}

/** Loads, interpolates, validates and resolves a YAML config file. */
export function loadConfig(path: string, opts: LoadOptions = {}): ResolvedConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  let resolved: ResolvedConfig;
  try {
    resolved = parseConfigText(text, { ...opts, baseDir: opts.baseDir ?? dirname(resolve(path)) });
  } catch (err) {
    // Name the file: with several configs around, "Invalid configuration" alone is not actionable.
    if (err instanceof ConfigError) throw new ConfigError(`${path}: ${err.summary}`, err.details);
    throw err;
  }
  resolved.sourcePath = resolve(path);
  return resolved;
}

/**
 * Pricing table format (`config/pricing.json`):
 * `{ "unit": "usd_per_1m_tokens", "models": { "<model name or upstream id>": { input, output, cached_input? } } }`
 */
export function loadPricingFile(file: string): Record<string, Pricing> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read pricing file ${file}: ${(err as Error).message}`);
  }
  const models = (json as { models?: unknown }).models;
  if (!models || typeof models !== 'object')
    throw new ConfigError(`Pricing file ${file} must contain a "models" object`);
  const out: Record<string, Pricing> = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(models)) {
    const p = pricingSchema.safeParse(value);
    if (p.success) out[name] = p.data;
    else errors.push(...formatZodIssues(p.error).map((e) => `pricing.models.${name}.${e}`));
  }
  if (errors.length > 0) throw new ConfigError(`Invalid pricing file ${file}`, errors);
  return out;
}
