#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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
import { ConfigError, loadConfig } from './config/load.js';
import { GatewayError } from './core/errors.js';
import { startServer } from './server.js';

const HELP = `switchyard — OpenAI-compatible LLM gateway

Usage:
  switchyard serve --config <file> [--port <n>] [--host <addr>]
  switchyard worker --config <file> [--port <metrics-port>]
  switchyard migrate --config <file> | --database-url <url>
  switchyard validate-config <file>
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

  switchyard --version | --help
`;

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
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${version()}\n`);
    return 0;
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
      const configPath = values.config ?? process.env.SWITCHYARD_CONFIG;
      if (!configPath) throw new Error('serve requires --config <file> (or SWITCHYARD_CONFIG)');
      const port = num(values.port ?? process.env.PORT, 'port');
      await startServer({
        configPath,
        ...(port !== undefined ? { port } : {}),
        ...(values.host ? { host: values.host } : {}),
        handleSignals: true,
      });
      return -1; // keep running
    }
    case 'validate-config': {
      const file = rest[0];
      if (!file) throw new Error('validate-config requires a file path');
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
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
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
    process.exit(1);
  },
);
