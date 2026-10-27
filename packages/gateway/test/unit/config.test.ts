import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { interpolate, InterpolationError } from '../../src/config/interpolate.js';
import { ConfigError, loadConfig, parseConfig, parseConfigText } from '../../src/config/load.js';

const minimal = {
  providers: { mock: { type: 'mock' } },
  models: { echo: { provider: 'mock', model: 'mock-echo' } },
  routes: { chat: { targets: ['echo'] } },
};

describe('interpolate', () => {
  const env = { HOST: 'db.local', EMPTY: '', PORT: '5432' };

  it('replaces ${VAR} and supports defaults', () => {
    expect(
      interpolate(
        {
          a: 'postgres://${HOST}:${PORT}/x',
          b: '${MISSING:-fallback}',
          c: '${EMPTY:-def}',
          d: '${EMPTY-def}',
        },
        env,
      ),
    ).toEqual({
      a: 'postgres://db.local:5432/x',
      b: 'fallback',
      c: 'def',
      d: '',
    });
  });

  it('walks arrays and nested objects, leaving non-strings alone', () => {
    expect(
      interpolate({ list: ['${HOST}', 3, true, null], nested: { deep: '${PORT}' } }, env),
    ).toEqual({
      list: ['db.local', 3, true, null],
      nested: { deep: '5432' },
    });
  });

  it('escapes $${ as a literal', () => {
    expect(interpolate({ tpl: 'keep $${HOST} literal' }, env)).toEqual({
      tpl: 'keep ${HOST} literal',
    });
  });

  it('reports every missing variable with its path', () => {
    try {
      interpolate({ a: '${NOPE}', b: [{ c: 'x ${ALSO_NOPE} y' }] }, env);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InterpolationError);
      expect((err as InterpolationError).issues).toEqual([
        { path: 'a', variable: 'NOPE' },
        { path: 'b[0].c', variable: 'ALSO_NOPE' },
      ]);
    }
  });

  it('allows defaults containing colons and URLs', () => {
    expect(interpolate({ u: '${R:-redis://localhost:6379/0}' }, {})).toEqual({
      u: 'redis://localhost:6379/0',
    });
  });
});

describe('parseConfig', () => {
  it('applies defaults and normalizes routes', () => {
    const cfg = parseConfig(minimal, { pricing: {} });
    expect(cfg.raw.server.port).toBe(8787);
    expect(cfg.routes.chat).toMatchObject({
      kind: 'chat',
      strategy: 'fallback',
      targets: [{ model: 'echo', weight: 1 }],
    });
    expect(cfg.routes.chat!.retry.attempts).toBe(2);
    expect(cfg.models.echo!.enabled).toBe(true);
  });

  it('coerces numbers that came from env interpolation', () => {
    const cfg = parseConfig(
      { ...minimal, server: { port: '${PORT}' } },
      { env: { PORT: '9999' }, pricing: {} },
    );
    expect(cfg.raw.server.port).toBe(9999);
  });

  it('produces helpful errors with paths', () => {
    expect(() =>
      parseConfig({ ...minimal, providers: { mock: { type: 'nope' } } }, { pricing: {} }),
    ).toThrow(/providers\.mock\.type/);
  });

  it('rejects unknown cross references', () => {
    try {
      parseConfig(
        {
          providers: { mock: { type: 'mock' } },
          models: { a: { provider: 'ghost', model: 'x' } },
          routes: { r: { targets: ['a', 'missing'] } },
        },
        { pricing: {} },
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const details = (err as ConfigError).details.join('\n');
      expect(details).toContain('models.a.provider: unknown provider "ghost"');
      expect(details).toContain('routes.r.targets[1]: unknown model "missing"');
    }
  });

  it('rejects routes mixing model kinds and templates without {text}', () => {
    expect(() =>
      parseConfig(
        {
          providers: { mock: { type: 'mock' } },
          models: {
            chat: { provider: 'mock', model: 'mock-echo' },
            emb: {
              provider: 'mock',
              model: 'mock-embed',
              kind: 'embedding',
              input_templates: { query: 'no placeholder' },
            },
          },
          routes: { r: { targets: ['chat', 'emb'] } },
        },
        { pricing: {} },
      ),
    ).toThrow(/mix model kinds[\s\S]*|placeholder/);
  });

  it('disables key-less providers with enabled_if_key and warns', () => {
    const cfg = parseConfig(
      {
        providers: {
          openai: { type: 'openai', api_key: '${OPENAI_API_KEY:-}', enabled_if_key: true },
        },
        models: { gpt: { provider: 'openai', model: 'gpt-x' } },
        routes: { r: { targets: ['gpt'] } },
      },
      { env: {}, pricing: {} },
    );
    expect(cfg.models.gpt!.enabled).toBe(false);
    expect(cfg.warnings.join('\n')).toContain('every target is disabled');
  });

  it('rejects duplicate static keys and short keys', () => {
    expect(() =>
      parseConfig(
        {
          ...minimal,
          auth: {
            static_keys: [
              { key: 'sk-sy-dup-123456', team: 'a' },
              { key: 'sk-sy-dup-123456', team: 'b' },
              { key: 'short', team: 'c' },
            ],
          },
        },
        { pricing: {} },
      ),
    ).toThrow(/duplicate key[\s\S]*at least 12/);
  });

  it('merges pricing from the table by model name or upstream id', () => {
    const cfg = parseConfig(
      {
        ...minimal,
        models: {
          echo: { provider: 'mock', model: 'mock-echo' },
          other: { provider: 'mock', model: 'mock-fixed', pricing: { input: 9, output: 9 } },
        },
      },
      { pricing: { 'mock-echo': { input: 1, output: 2 } } },
    );
    expect(cfg.models.echo!.pricing).toEqual({ input: 1, output: 2 });
    expect(cfg.models.other!.pricing).toMatchObject({ input: 9, output: 9 });
  });

  it('reports YAML syntax errors', () => {
    expect(() => parseConfigText('providers: [unclosed', { pricing: {} })).toThrow(
      /not valid YAML/,
    );
  });
});

describe('shipped configs', () => {
  const configDir = fileURLToPath(new URL('../../../../config/', import.meta.url));
  const env = { OPENCODE_SERVER_PASSWORD: 'x' };

  it('gateway.local.yaml exposes exactly the contract routes', () => {
    const cfg = loadConfig(`${configDir}gateway.local.yaml`, { env });
    const visible = Object.values(cfg.routes)
      .filter((r) => !r.hidden)
      .map((r) => r.name)
      .sort();
    expect(visible).toEqual(
      [
        'docsqa-chat',
        'docsqa-embed',
        'docsqa-fast',
        'docsqa-judge',
        'docsqa-rerank',
        'mock-chat',
        'mock-embed',
        'mock-rerank',
        'mock-tools',
        'opsagent-chat',
        'opsagent-judge',
      ].sort(),
    );
    expect(cfg.routes['docsqa-judge']!.defaults.reasoning_effort).toBe('medium');
    expect(cfg.models['copilot-sonnet']!.pricing).toMatchObject({ input: 2, output: 10 });
  });

  it('gateway.example.yaml validates', () => {
    expect(() => loadConfig(`${configDir}gateway.example.yaml`, { env })).not.toThrow();
  });

  it('pricing.json is valid JSON with a models table', () => {
    const json = JSON.parse(readFileSync(`${configDir}pricing.json`, 'utf8')) as {
      models: Record<string, unknown>;
    };
    expect(Object.keys(json.models).length).toBeGreaterThan(5);
  });
});
