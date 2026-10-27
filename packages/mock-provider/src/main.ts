#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startMockServer } from './server.js';

/** CLI: `tsx src/main.ts [--port 8790] [--host 127.0.0.1] [--latency-ms N] [--fail-rate P] [--fail-status S]`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '8790' },
      host: { type: 'string', default: '127.0.0.1' },
      'latency-ms': { type: 'string' },
      'fail-rate': { type: 'string' },
      'fail-status': { type: 'string' },
      seed: { type: 'string' },
    },
    strict: true,
  });
  const num = (v: string | undefined): number | undefined =>
    v === undefined ? undefined : Number(v);
  const server = await startMockServer({
    port: Number(values.port),
    host: values.host,
    ...(values['latency-ms'] ? { latencyMs: num(values['latency-ms']) } : {}),
    ...(values['fail-rate'] ? { failRate: num(values['fail-rate']) } : {}),
    ...(values['fail-status'] ? { failStatus: num(values['fail-status']) } : {}),
    ...(values.seed ? { seed: num(values.seed) } : {}),
  });
  console.warn(`switchyard mock provider listening on ${server.url}`);
  const shutdown = (): void => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
