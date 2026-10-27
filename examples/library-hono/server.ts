// Switchyard embedded in your own Hono app: the gateway is mounted under /llm next to the app's
// routes, and a custom UsageSink feeds a per-user cost endpoint. The same file runs on Node
// (>= 22.18, via @hono/node-server), Bun (Bun.serve) and Deno (Deno.serve).
import { Hono } from 'hono';
import {
  createGateway,
  parseConfigText,
  type UsageEvent,
  type UsageSink,
} from 'switchyard-gateway';

// A mock-only config: the built-in in-process mock needs no upstream server and no API key.
const config = parseConfigText(
  `
auth:
  static_keys: [{ key: '\${APP_GATEWAY_KEY:-sk-sy-example-library}', team: my-app }]
providers:
  mock: { type: mock }
models:
  echo: { provider: mock, model: mock-echo, pricing: { input: 0.15, output: 0.6 } }
  embedder: { provider: mock, model: mock-embed, kind: embedding }
routes:
  chat: { targets: [echo] }
  embed: { targets: [embedder] }
`,
  { env: { APP_GATEWAY_KEY: process.env.APP_GATEWAY_KEY } },
);

// Usage events carry team, route, tokens, cost, x-sy-user (end_user) and x-sy-tags.
const costByUser = new Map<string, { requests: number; cost_usd: number; tags: string[] }>();
const usage: UsageSink = {
  emit(event: UsageEvent) {
    const user = event.end_user ?? 'anonymous';
    const row = costByUser.get(user) ?? { requests: 0, cost_usd: 0, tags: [] };
    row.requests += 1;
    row.cost_usd += event.cost_usd;
    row.tags = [...new Set([...row.tags, ...event.tags])];
    costByUser.set(user, row);
  },
};

const gateway = createGateway({ config, services: { usage } });

const app = new Hono();
app.get('/', (c) => c.text('my service, with an LLM gateway under /llm\n'));
app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/usage/by-user', (c) => c.json(Object.fromEntries(costByUser)));
app.route('/llm', gateway.app); // → /llm/v1/chat/completions, /llm/v1/models, /llm/healthz, …

const port = Number(process.env.PORT ?? 8788);
const runtime = globalThis as unknown as {
  Bun?: { serve(options: { port: number; hostname: string; fetch: typeof app.fetch }): unknown };
  Deno?: {
    serve(
      options: { port: number; hostname: string; onListen(): void },
      fetch: typeof app.fetch,
    ): unknown;
  };
};
if (runtime.Bun && !process.env.USE_NODE_SERVER) {
  runtime.Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch });
} else if (runtime.Deno && !process.env.USE_NODE_SERVER) {
  runtime.Deno.serve({ port, hostname: '127.0.0.1', onListen() {} }, app.fetch);
} else {
  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
}
const server = runtime.Bun ? 'Bun.serve' : runtime.Deno ? 'Deno.serve' : '@hono/node-server';
console.log(
  `library-hono listening on http://127.0.0.1:${port} ` +
    `(${process.env.USE_NODE_SERVER ? '@hono/node-server' : server})`,
);

const shutdown = (): void => {
  void gateway.close().then(() => process.exit(0)); // flushes usage, closes providers
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
