/**
 * Generates `config.schema.json` (JSON Schema 2020-12) from the zod config schema.
 *
 *   pnpm --filter switchyard-gateway schema         # write config.schema.json
 *   pnpm --filter switchyard-gateway schema:check   # exit 1 when the committed file is stale
 *
 * Differences from a plain `z.toJSONSchema()`:
 * - input shape (`io: 'input'`): fields with defaults are optional, as you write them in YAML;
 * - numbers, booleans, enums and formatted strings also accept a `${VAR}` string, because
 *   environment interpolation happens before validation;
 * - objects with fixed properties reject unknown keys, so editors flag typos (the runtime ignores
 *   unknown keys);
 * - `maximum: 9007199254740991` (the implicit safe-integer bound of `.int()`) is dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configSchema } from '../src/config/schema.js';

type Node = Record<string, unknown>;

export const SCHEMA_PATH = fileURLToPath(new URL('../config.schema.json', import.meta.url));
export const SCHEMA_ID = 'https://unpkg.com/switchyard-gateway/config.schema.json';
const INTERPOLATED_DEF = {
  description:
    'A value taken from the environment: `${VAR}`, `${VAR:-default}` or `${VAR-default}`.',
  type: 'string',
  pattern: '\\$\\{[A-Za-z_][A-Za-z0-9_]*(:?-[^}]*)?\\}',
};
const INTERPOLATED = { $ref: '#/$defs/interpolated' };
const ANNOTATIONS = ['description', 'default', 'title', 'examples', 'deprecated'];

function transform(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(transform);
  if (!node || typeof node !== 'object') return node;
  const out: Node = {};
  for (const [k, v] of Object.entries(node as Node)) {
    if (k === 'maximum' && v === Number.MAX_SAFE_INTEGER) continue;
    out[k] = transform(v);
  }
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined)
    out.additionalProperties = false;
  const scalar =
    out.type === 'number' ||
    out.type === 'integer' ||
    out.type === 'boolean' ||
    (out.type === 'string' && (typeof out.format === 'string' || Array.isArray(out.enum)));
  if (scalar) {
    const annotations: Node = {};
    const value: Node = {};
    for (const [k, v] of Object.entries(out))
      (ANNOTATIONS.includes(k) ? annotations : value)[k] = v;
    return { ...annotations, anyOf: [value, INTERPOLATED] };
  }
  return out;
}

export function buildConfigSchema(): Node {
  const raw = z.toJSONSchema(configSchema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Node;
  const { $schema, $defs, ...rest } = raw;
  return {
    $schema,
    $id: SCHEMA_ID,
    title: 'Switchyard gateway configuration (gateway.yaml)',
    description:
      'Configuration of the Switchyard LLM gateway. `${VAR}` and `${VAR:-default}` are replaced ' +
      'from the environment before validation. Reference: docs/CONFIG.md.',
    ...(transform(rest) as Node),
    $defs: { ...(transform($defs ?? {}) as Node), interpolated: INTERPOLATED_DEF },
  };
}

export const renderConfigSchema = (): string => `${JSON.stringify(buildConfigSchema(), null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = renderConfigSchema();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(SCHEMA_PATH, 'utf8');
    } catch {
      /* missing → stale */
    }
    if (current !== next) {
      console.error('✖ config.schema.json is stale: run `pnpm --filter switchyard-gateway schema`');
      process.exit(1);
    }
    console.log('✔ config.schema.json is up to date');
  } else {
    writeFileSync(SCHEMA_PATH, next);
    console.log(`wrote ${SCHEMA_PATH}`);
  }
}
