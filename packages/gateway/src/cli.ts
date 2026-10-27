#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startMockServer } from '@switchyard/mock-provider';
import {
  cmdBudgets,
  cmdCache,
  cmdKeys,
  cmdMigrate,
  cmdSeedDev,
  cmdTeams,
  cmdUsage,
  cmdWorker,
} from './cli/commands.js';
import { writeStarterFiles } from './cli/init.js';
import { ConfigError, loadConfig } from './config/load.js';
import { GatewayError } from './core/errors.js';
import { startServer } from './server.js';

const HELP = `switchyard — OpenAI-compatible LLM gateway

Usage:
  switchyard init [--dir <path>] [--force]
  switchyard serve [--config <file>] [--port <n>] [--host <addr>]
  switchyard validate-config [<file> | --config <file>]
  switchyard worker [--config <file>] [--port <metrics-port>]
  switchyard migrate [--config <file>] [--database-url <url>]
  switchyard mock-provider [--port 8790] [--host 127.0.0.1] [--latency-ms <n>] [--fail-rate <0..1>] [--fail-status <code>] [--seed <n>]

Admin (local: --config <file> talks to Postgres/Redis directly;
       remote: --url <gateway> --admin-token <token>, or SWITCHYARD_URL / SWITCHYARD_ADMIN_TOKEN):
  switchyard teams create <slug> [--name N] [--monthly-budget USD] [--daily-budget USD] [--rpm N] [--tpm N]
  switchyard teams list | get <slug> | delete <slug>
  switchyard keys create --team <slug> [--name N] [--routes a,b] [--rpm N] [--tpm N] [--expires-in-days D]
  switchyard keys list --team <slug> [--all]
  switchyard keys revoke <key-id>
  switchyard keys rotate <key-id> [--grace-s S]
  switchyard budgets set --team <slug> [--monthly USD|none] [--daily USD|none] [--soft 0.8] [--action block|alert] [--webhook URL]
  switchyard budgets show --team <slug>
  switchyard usage [--team T] [--route R] [--model M] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--group-by day|team|route|model|provider|key]
  switchyard cache purge [--route R] [--team T]
  switchyard seed-dev [--rotate] [--output <env-file>]
  (add --json to admin commands for machine-readable output)

  switchyard --version | --help | <command> --help

The config file defaults to $SWITCHYARD_CONFIG, then ./gateway.yaml. A ./.env file is loaded
first when present (existing environment variables win). Docs: https://github.com/riz1-k/llm-gateway
`;

/** Usage lines of one command, taken from HELP (`switchyard <command> --help`). */
function commandHelp(command: string): string | undefined {
  const lines = HELP.split('\n').filter(
    (l) => l.startsWith(`  switchyard ${command} `) || l === `  switchyard ${command}`,
  );
  if (lines.length === 0) return undefined;
  return `Usage:\n${lines.join('\n')}\n\nRun \`switchyard --help\` for all commands.\n`;
}

/** --config → $SWITCHYARD_CONFIG → ./gateway.yaml (if it exists). */
export function resolveConfigPath(flag: string | undefined): string | undefined {
  if (flag) return flag;
  if (process.env.SWITCHYARD_CONFIG) return process.env.SWITCHYARD_CONFIG;
  return existsSync('gateway.yaml') ? 'gateway.yaml' : undefined;
}

const NO_CONFIG =
  'no config file: pass --config <file>, set SWITCHYARD_CONFIG, or run `switchyard init` to create ./gateway.yaml';

/** Loads ./.env (or --env-file / SWITCHYARD_ENV_FILE) without overriding the real environment. */
function loadEnvFile(argv: string[]): string[] {
  const rest: string[] = [];
  let file: string | undefined = process.env.SWITCHYARD_ENV_FILE;
  let explicit = Boolean(file);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--env-file') {
      file = argv[++i];
      explicit = true;
    } else if (a.startsWith('--env-file=')) {
      file = a.slice('--env-file='.length);
      explicit = true;
    } else rest.push(a);
  }
  const path = resolve(file ?? '.env');
  if (existsSync(path)) {
    // process.loadEnvFile overrides existing variables; keep the real environment authoritative.
    const before = { ...process.env };
    process.loadEnvFile(path);
    for (const [k, v] of Object.entries(before)) process.env[k] = v;
  } else if (explicit) {
    throw new Error(`env file not found: ${path}`);
  }
  return rest;
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = loadEnvFile(argv);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    const help = commandHelp(command);
    if (help) {
      process.stdout.write(help);
      return 0;
    }
  }

  switch (command) {
    case 'serve': {
      const { values } = parseArgs({
        args: rest,
        options: {
          config: { type: 'string', short: 'c' },
          port: { type: 'string', short: 'p' },
          host: { type: 'string' },
        },
      });
      const configPath = resolveConfigPath(values.config);
      if (!configPath) throw new Error(NO_CONFIG);
      const port = num(values.port ?? process.env.PORT, 'port');
      await startServer({
        configPath,
        ...(port !== undefined ? { port } : {}),
        ...(values.host ? { host: values.host } : {}),
        handleSignals: true,
      });
      return -1; // keep running
    }
    case 'init': {
      const { values } = parseArgs({
        args: rest,
        options: { dir: { type: 'string', short: 'd' }, force: { type: 'boolean', short: 'f' } },
      });
      const r = writeStarterFiles(values.dir ?? '.', version(), values.force === true);
      for (const f of r.written) process.stdout.write(`✔ wrote ${f}\n`);
      for (const f of r.skipped)
        process.stdout.write(`• kept existing ${f} (use --force to overwrite)\n`);
      const cd = values.dir ? `cd ${values.dir} && ` : '';
      process.stdout.write(
        [
          '',
          'Next:',
          `  ${cd}npx switchyard-gateway serve            # http://localhost:8787/v1`,
          '  curl localhost:8787/v1/chat/completions \\',
          "    -H 'authorization: Bearer sk-sy-local-change-me' -H 'content-type: application/json' \\",
          '    -d \'{"model":"chat","messages":[{"role":"user","content":"hello"}]}\'',
          '',
          'Copy .env.example to .env and change the key before exposing the gateway.',
          '',
        ].join('\n'),
      );
      return 0;
    }
    case 'validate-config': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { config: { type: 'string', short: 'c' } },
      });
      const file = resolveConfigPath(positionals[0] ?? values.config);
      if (!file) throw new Error(NO_CONFIG);
      const cfg = loadConfig(file);
      const routes = Object.values(cfg.routes);
      process.stdout.write(
        `✔ ${file} is valid: ${Object.keys(cfg.providers).length} providers, ${Object.keys(cfg.models).length} models, ${routes.length} routes\n`,
      );
      for (const r of routes) {
        process.stdout.write(
          `  ${r.name.padEnd(22)} ${r.kind.padEnd(10)} ${r.strategy.padEnd(14)} ${r.targets.map((t) => t.model).join(' → ')}\n`,
        );
      }
      for (const w of cfg.warnings) process.stdout.write(`  ⚠ ${w}\n`);
      return 0;
    }
    case 'mock-provider': {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: 'string', short: 'p' },
          host: { type: 'string' },
          'latency-ms': { type: 'string' },
          'fail-rate': { type: 'string' },
          'fail-status': { type: 'string' },
          seed: { type: 'string' },
        },
      });
      const latencyMs = num(values['latency-ms'], 'latency-ms');
      const failRate = num(values['fail-rate'], 'fail-rate');
      const failStatus = num(values['fail-status'], 'fail-status');
      const seed = num(values.seed, 'seed');
      const server = await startMockServer({
        port: num(values.port, 'port') ?? 8790,
        host: values.host ?? '127.0.0.1',
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(failRate !== undefined ? { failRate } : {}),
        ...(failStatus !== undefined ? { failStatus } : {}),
        ...(seed !== undefined ? { seed } : {}),
      });
      process.stdout.write(`switchyard mock provider listening on ${server.url}\n`);
      const stop = (): void => {
        void server.close().then(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return -1;
    }
    case 'migrate':
      return cmdMigrate(rest);
    case 'worker':
      return cmdWorker(rest);
    case 'teams':
      return cmdTeams(rest);
    case 'keys':
      return cmdKeys(rest);
    case 'budgets':
      return cmdBudgets(rest);
    case 'usage':
      return cmdUsage(rest);
    case 'cache':
      return cmdCache(rest);
    case 'seed-dev':
      return cmdSeedDev(rest);
    default:
      process.stderr.write(`✖ Unknown command "${command}". Run \`switchyard --help\`.\n`);
      return 2;
  }
}

/** Actionable follow-up for common failures (bad flags, unreachable Redis/Postgres). */
function errorHint(err: unknown, command: string | undefined): string | undefined {
  const e = err as { code?: string; address?: string; port?: number; errors?: unknown[] };
  const code = e.code ?? (e.errors?.[0] as { code?: string } | undefined)?.code;
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE')
    return `run \`switchyard ${command ?? ''} --help\` for the accepted flags`;
  if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL')
    return `this command takes no positional arguments; see \`switchyard ${command ?? ''} --help\``;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ETIMEDOUT'
  )
    return 'a backing service is unreachable: check that Postgres/Redis are running and that database.url / redis.url (or DATABASE_URL / REDIS_URL) point at them';
  if (code === '28P01') return 'Postgres rejected the credentials in database.url';
  if (code === '3D000') return 'the database in database.url does not exist; create it first';
  if (code === '42P01') return 'tables are missing: run `switchyard migrate` first';
  return undefined;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    if (err instanceof ConfigError) {
      process.stderr.write(`✖ ${err.message}\n`);
      process.exit(1);
    }
    if (err instanceof GatewayError) {
      process.stderr.write(`✖ ${err.message} (${err.code})\n`);
      process.exit(1);
    }
    process.stderr.write(`✖ ${err instanceof Error ? err.message : String(err)}\n`);
    const hint = errorHint(err, process.argv[2]);
    if (hint) process.stderr.write(`  hint: ${hint}\n`);
    process.exit(1);
  },
);
