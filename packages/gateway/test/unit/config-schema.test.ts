import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DOCS_PATH, renderConfigDocs } from '../../scripts/config-docs.js';
import { renderConfigSchema, SCHEMA_PATH } from '../../scripts/config-schema.js';
import { starterConfig, writeStarterFiles } from '../../src/cli/init.js';
import { loadConfig, parseConfigText } from '../../src/config/load.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
const repo = new URL('../../../../', import.meta.url);
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
const validate = addFormats(new Ajv2020({ allErrors: true, strict: false })).compile(schema);

const errorsOf = (doc: unknown): string[] =>
  validate(doc)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);

describe('config.schema.json', () => {
  it('is in sync with the zod schema (run `pnpm --filter switchyard-gateway schema`)', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(renderConfigSchema());
  });

  it('docs/CONFIG.md is generated from it (run `pnpm --filter switchyard-gateway schema`)', async () => {
    expect(readFileSync(DOCS_PATH, 'utf8')).toBe(await renderConfigDocs());
  });

  it('documents every property', () => {
    const missing: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      for (const [k, v] of Object.entries((n.properties as Record<string, unknown>) ?? {})) {
        if (k !== 'type' && !(v as Record<string, unknown>).description)
          missing.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
      for (const key of ['additionalProperties', 'items'] as const) walk(n[key], `${path}[*]`);
      for (const key of ['oneOf', 'anyOf'] as const)
        for (const sub of (n[key] as unknown[] | undefined) ?? []) walk(sub, path);
    };
    walk(schema, '');
    expect(missing).toEqual([]);
  });

  const configDir = new URL('config/', repo);
  const yamlFiles = readdirSync(configDir).filter((f) => f.endsWith('.yaml'));

  it.each(yamlFiles)('accepts config/%s as written (before interpolation)', (file) => {
    const text = readFileSync(new URL(file, configDir), 'utf8');
    expect(text.startsWith('# yaml-language-server: $schema=')).toBe(true);
    expect(errorsOf(parseYaml(text))).toEqual([]);
  });

  it('accepts the Helm chart default config', () => {
    const values = parseYaml(
      readFileSync(new URL('deploy/helm/switchyard/values.yaml', repo), 'utf8'),
    ) as { config: unknown };
    expect(errorsOf(values.config)).toEqual([]);
  });

  it('flags typos and wrong types', () => {
    const errors = errorsOf({
      providers: { mock: { type: 'mock' } },
      models: { m: { provider: 'mock', model: 'mock-echo', kindd: 'chat' } },
      routes: { r: { targets: ['m'], strategy: 'random' } },
      server: { port: 'eighty' },
    });
    expect(errors.join('\n')).toMatch(/must NOT have additional properties/);
    expect(errors.join('\n')).toMatch(/strategy must be equal to one of the allowed values/);
    expect(errors.join('\n')).toMatch(/server\/port/);
  });

  it('accepts ${ENV} interpolation in numeric and boolean fields', () => {
    expect(
      errorsOf({
        server: { port: '${PORT:-8787}' },
        redis: { url: '${REDIS_URL}', fail_open: '${FAIL_OPEN-true}' },
        providers: { mock: { type: 'mock' } },
        models: { m: { provider: 'mock', model: 'mock-echo' } },
        routes: { r: { targets: ['m'] } },
      }),
    ).toEqual([]);
  });
});

describe('switchyard init starter files', () => {
  it('produce a valid config that matches the schema', () => {
    const text = starterConfig('9.9.9');
    expect(text).toContain('switchyard-gateway@9.9.9/config.schema.json');
    expect(errorsOf(parseYaml(text))).toEqual([]);
    const cfg = parseConfigText(text, { env: {} });
    expect(Object.keys(cfg.routes).sort()).toEqual(['chat', 'embed']);
    expect(cfg.raw.auth.static_keys[0]?.key).toBe('sk-sy-local-change-me');
  });

  it('never overwrite existing files without force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-init-'));
    expect(writeStarterFiles(dir, '1.0.0').written).toHaveLength(2);
    const again = writeStarterFiles(dir, '1.0.0');
    expect(again.written).toEqual([]);
    expect(again.skipped).toHaveLength(2);
    expect(writeStarterFiles(dir, '1.0.0', true).written).toHaveLength(2);
    expect(loadConfig(join(dir, 'gateway.yaml'), { env: {} }).routes.chat).toBeDefined();
  });
});
