import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Starter files written by `switchyard init`. */
export interface InitResult {
  dir: string;
  written: string[];
  skipped: string[];
}

export const starterConfig = (
  version: string,
): string => `# yaml-language-server: $schema=https://unpkg.com/switchyard-gateway@${version}/config.schema.json
#
# Switchyard starter config, written by \`switchyard init\`.
# Reference: https://github.com/riz1-k/llm-gateway/blob/main/docs/CONFIG.md
# \${VAR} and \${VAR:-default} are read from the environment (\`switchyard serve\` loads ./.env).

server:
  port: \${PORT:-8787}

auth:
  # Admin API (/admin/*) is disabled until you set a long random token.
  admin_token: \${SWITCHYARD_ADMIN_TOKEN:-}
  static_keys:
    - key: \${SWITCHYARD_API_KEY:-sk-sy-local-change-me}
      team: local
      name: local

providers:
  # Deterministic built-in mock: no network, no API key. Swap in a real provider below.
  mock: { type: mock }
  # openai: { type: openai, api_key: \${OPENAI_API_KEY:-}, enabled_if_key: true }
  # anthropic: { type: anthropic, api_key: \${ANTHROPIC_API_KEY:-}, enabled_if_key: true }
  # ollama: { type: openai-compatible, base_url: http://127.0.0.1:11434/v1 }

models:
  # Concrete upstream models. Pricing is USD per 1M tokens (the mock gets a shadow price so
  # cost tracking is visible).
  mock-chat: { provider: mock, model: mock-echo, pricing: { input: 0.15, output: 0.6 } }
  mock-embed: { provider: mock, model: mock-embed, kind: embedding }
  # gpt-mini: { provider: openai, model: gpt-5-mini, pricing: { input: 0.25, output: 2.0 } }

routes:
  # Virtual models: clients send these names as \`model\`.
  chat:
    targets: [mock-chat] # fallback order, e.g. [gpt-mini, mock-chat]
    retry: { attempts: 2 }
    cache: { exact: { ttl_s: 3600 } }
  embed:
    targets: [mock-embed]
    cache: { exact: { ttl_s: 86400 } }

# Optional platform layer: shared rate limits, budgets, caches, usage ledger, admin API.
# redis: { url: \${REDIS_URL} }          # Redis 8+
# database: { url: \${DATABASE_URL} }    # Postgres; run \`switchyard migrate\` once
# limits:
#   defaults: { key: { rpm: 600, tpm: 2000000 } }
`;

export const starterEnv = `# Copy to .env (keep it out of git). \`switchyard serve\` loads ./.env automatically.
PORT=8787
# Clients authenticate with: Authorization: Bearer <SWITCHYARD_API_KEY>
SWITCHYARD_API_KEY=sk-sy-local-change-me
# Enables the admin API; use a long random value (e.g. openssl rand -hex 32).
SWITCHYARD_ADMIN_TOKEN=
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# REDIS_URL=redis://localhost:6379/0
# DATABASE_URL=postgres://user:password@localhost:5432/switchyard
`;

/** Writes `gateway.yaml` and `.env.example` into `dir` (existing files are kept unless `force`). */
export function writeStarterFiles(dir: string, version: string, force = false): InitResult {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  const files: [string, string][] = [
    ['gateway.yaml', starterConfig(version)],
    ['.env.example', starterEnv],
  ];
  const result: InitResult = { dir: target, written: [], skipped: [] };
  for (const [name, content] of files) {
    const path = join(target, name);
    if (existsSync(path) && !force) {
      result.skipped.push(relative(process.cwd(), path) || name);
      continue;
    }
    writeFileSync(path, content, { mode: 0o644 });
    result.written.push(relative(process.cwd(), path) || name);
  }
  return result;
}
