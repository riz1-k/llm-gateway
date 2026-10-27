# Using Switchyard as a library

`switchyard-gateway` is a CLI and also a library. The gateway is a [Hono](https://hono.dev) app
with a standard Fetch-API handler, so you can serve it yourself, mount it inside another app or
call it in-process in tests. Everything below uses only the public entry points:
`switchyard-gateway` and `switchyard-gateway/mock-provider`. Imports from `dist/*` files are not
part of the API.

```bash
npm i switchyard-gateway @hono/node-server   # @hono/node-server only if you serve it on Node yourself
```

The package is ESM-only and requires Node.js 22.12 or later. Types are included.

## Serve it

The shortest path does exactly what `switchyard serve` does. It loads the config, builds the
Redis/Postgres platform when `redis.url` or `database.url` is set, serves HTTP and shuts down
gracefully on SIGTERM:

```ts
import { startServer } from 'switchyard-gateway';

const server = await startServer({ configPath: 'gateway.yaml', port: 8787, handleSignals: true });
console.log(`listening on ${server.url}`);
// later: await server.shutdown('done');
```

For full control over hosting, create the gateway and pass its `fetch` to any Fetch-API server:

```ts
import { serve } from '@hono/node-server';
import { createGateway, loadConfig } from 'switchyard-gateway';

const gateway = createGateway({ config: loadConfig('gateway.yaml') });
const server = serve({ fetch: gateway.fetch, port: 8787 });

process.on('SIGTERM', () => {
  gateway.setDraining(true); // /readyz → 503 so load balancers stop sending traffic
  server.close(async () => {
    await gateway.close(); // flushes usage events, closes providers and the platform
    process.exit(0);
  });
});
```

`createGateway()` without a platform runs fully in memory:

- static keys from `auth.static_keys`;
- an in-process LRU for the exact cache;
- no rate limits, budgets or usage persistence (each usage event is written to the log
  at `info` level);
- in-process circuit breakers.

That is the right mode for tests, single-user tools and edge deployments.

## Mount it inside your Hono app

`gateway.app` is a Hono app. Mount it under a prefix:

```ts
import { Hono } from 'hono';
import { createGateway, loadConfig } from 'switchyard-gateway';

const gateway = createGateway({ config: loadConfig('gateway.yaml') });
const app = new Hono();
app.get('/', (c) => c.text('my service'));
app.route('/llm', gateway.app); // → /llm/v1/chat/completions, /llm/healthz, …
export default app;
```

Other frameworks can forward requests to `gateway.fetch(request)`.

## Call it in-process (tests)

`gateway.fetch` takes a `Request` and returns a `Response` without opening a socket. The
official `openai` SDK accepts a custom `fetch`, so you can test against the real gateway with
zero network:

```ts
import OpenAI from 'openai';
import { createGateway, parseConfigText } from 'switchyard-gateway';

const config = parseConfigText(
  `
auth: { static_keys: [{ key: sk-test, team: test }] }
providers: { mock: { type: mock } }
models: { echo: { provider: mock, model: mock-echo, pricing: { input: 1, output: 2 } } }
routes: { chat: { targets: [echo] } }
`,
  { env: {} },
);
const gateway = createGateway({ config });
const client = new OpenAI({
  baseURL: 'http://gateway.test/v1',
  apiKey: 'sk-test',
  fetch: (url, init) => gateway.fetch(new Request(url, init)),
});

const res = await client.chat.completions.create({
  model: 'chat',
  messages: [{ role: 'user', content: 'hello' }],
});
// res.choices[0].message.content === 'hello'; res.usage.cost is the USD cost
await gateway.close();
```

`loadConfig(path, { env })` and `parseConfigText(text, { env })` take an explicit environment
for `${VAR}` interpolation. Pass `{ env: {} }` to make tests independent of `process.env`.

The `type: mock` provider runs in-process. For an HTTP upstream (to test your own adapters or
an `openai-compatible` provider), start the standalone mock server:

```ts
import { startMockServer } from 'switchyard-gateway/mock-provider';

const mock = await startMockServer({ port: 0, latencyMs: 0 }); // port 0 = any free port
// providers: { up: { type: openai-compatible, base_url: `${mock.url}/v1` } }
await mock.close();
```

The mock serves OpenAI-style chat (streaming included), embeddings, rerank and an
Anthropic-style Messages API. It supports fault injection: latency, failure rate, status codes,
`Retry-After` and mid-stream failures.

## Turn on the platform (Redis and Postgres)

Rate limits, budgets, database keys, the Redis cache, semantic cache, shared breakers and the
usage ledger come from the platform layer. `startServer` builds it automatically. With
`createGateway` you build and start it yourself:

```ts
import { createGateway, createLogger, createPlatform, loadConfig } from 'switchyard-gateway';

const config = loadConfig('gateway.yaml'); // with redis.url and database.url
const logger = createLogger({ level: 'info' });
const platform = createPlatform(config, { logger });
await platform.start(); // pub/sub for key revocation, in-process usage writer if configured
const gateway = createGateway({ config, logger, platform });
// gateway.close() also closes the platform
```

Run the migrations once per database, with `switchyard migrate --config gateway.yaml` or in
code:

```ts
import { createDatabase, runMigrations } from 'switchyard-gateway';

const db = createDatabase(process.env.DATABASE_URL!);
await runMigrations(db);
await db.close();
```

## Custom providers

Any upstream can plug in as a `type: custom` provider. The config declares it, and your code
registers an adapter factory under the provider's `factory` name, which defaults to the provider
name:

```yaml
providers:
  inhouse:
    type: custom
    factory: inhouse-llm # key in adapterFactories (defaults to the provider name)
    base_url: https://llm.internal/v1
    api_key: ${INHOUSE_KEY}
    options: { tenant: research } # free-form, passed to your factory
models:
  inhouse-large: { provider: inhouse, model: large-2, pricing: { input: 1, output: 3 } }
routes:
  chat: { targets: [inhouse-large, openai-mini] } # fallback to a built-in provider works as usual
```

```ts
import {
  createGateway,
  loadConfig,
  makeChunk,
  usageChunk,
  type AdapterFactory,
  type ProviderAdapter,
} from 'switchyard-gateway';

const inhouse: AdapterFactory = (name, config, deps) => {
  if (config.type !== 'custom') throw new Error('expected a custom provider');
  const adapter: ProviderAdapter = {
    type: 'custom',
    name,
    async chat(req, target, ctx) {
      // ctx.signal aborts on client disconnect / timeout; target.upstreamModel === 'large-2'
      const res = await (deps.fetch ?? fetch)(`${config.base_url}/generate`, {
        method: 'POST',
        signal: ctx.signal,
        headers: { authorization: `Bearer ${config.api_key}` },
        body: JSON.stringify({ model: target.upstreamModel, messages: req.messages }),
      });
      const out = (await res.json()) as { text: string; in: number; out: number };
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: target.upstreamModel,
        choices: [
          { index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' },
        ],
        usage: {
          prompt_tokens: out.in,
          completion_tokens: out.out,
          total_tokens: out.in + out.out,
        },
      };
    },
    async *chatStream(req, target, ctx) {
      const full = await adapter.chat(req, target, ctx); // or translate a real upstream stream
      const meta = { id: full.id, created: full.created, model: full.model };
      yield makeChunk(meta, { role: 'assistant', content: full.choices[0]!.message.content });
      yield makeChunk(meta, {}, 'stop');
      yield usageChunk(meta, full.usage!);
    },
  };
  return adapter;
};

const gateway = createGateway({
  config: loadConfig('gateway.yaml'),
  adapterFactories: { 'inhouse-llm': inhouse },
});
```

Adapter contract:

- **Errors:** throw `ProviderError` with `retryable` set correctly, or return failed responses
  as errors. Retries, fallbacks and circuit breakers then work as they do for built-in
  providers.
- **Streaming:** `chatStream` yields OpenAI-shaped chunks. End with a usage chunk
  (`usageChunk`) so cost is exact. Without one, the gateway estimates usage.
- **Helpers:** `ChunkAccumulator`, `responseToChunks` and `makeUsage` help adapters that only
  have one of the two shapes.
- **Optional methods:** `embed` and `rerank` enable `kind: embedding` and `kind: rerank` models.
  `health` feeds `/admin/providers/health`, and `close` releases sockets on reload and shutdown.

The same mechanism replaces a built-in implementation. `adapterFactories: { openai: myFactory }`
is used for every `type: openai` provider.

## Replace services

Each policy and storage concern is an interface in `GatewayServices`. Pass your own
implementations through `createGateway({ services })`. Explicit services take precedence over
the platform's:

| Service       | Interface      | Built-ins                                                                                                   |
| ------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `keys`        | `KeyStore`     | `StaticKeyStore`, `ChainedKeyStore`, database keys (platform)                                               |
| `rateLimiter` | `RateLimiter`  | `NoopRateLimiter`, Redis sliding window (platform)                                                          |
| `budgets`     | `BudgetGuard`  | `NoopBudgetGuard`, Redis counters + Postgres (platform)                                                     |
| `cache`       | `CacheStore`   | `MemoryCacheStore` (default), `NoopCacheStore`, Redis (platform)                                            |
| `usage`       | `UsageSink`    | `LogUsageSink` (default), `NoopUsageSink`, `MemoryUsageSink`, `CompositeUsageSink`, Redis Stream (platform) |
| `breakers`    | `BreakerStore` | `MemoryBreakerStore`, Redis-shared (platform)                                                               |
| `semantic`    | (internal)     | Redis 8 vector sets (platform only)                                                                         |

For example, to send usage events to your own analytics pipeline:

```ts
import { createGateway, loadConfig, type UsageEvent, type UsageSink } from 'switchyard-gateway';

const sink: UsageSink = {
  emit(event: UsageEvent) {
    queueMicrotask(() => analytics.track('llm_request', event)); // must not block or throw
  },
};
const gateway = createGateway({ config: loadConfig('gateway.yaml'), services: { usage: sink } });
```

Keys can come from your own user database:

```ts
import { ChainedKeyStore, StaticKeyStore, hashKey, type KeyStore } from 'switchyard-gateway';

const fromMyDb: KeyStore = {
  async verify(token) {
    const row = await db.apiKeys.findByHash(hashKey(token)); // never store plaintext keys
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      prefix: token.slice(0, 12),
      team: { id: row.teamId, slug: row.teamSlug, name: row.teamName },
      allowedRoutes: row.routes ?? undefined, // undefined = all routes
      allowDirectModels: false,
      rpmLimit: row.rpm ?? undefined,
      tpmLimit: row.tpm ?? undefined,
      source: 'db',
    };
  },
};
const keys = new ChainedKeyStore([new StaticKeyStore(config.raw.auth.static_keys), fromMyDb]);
```

Check the TSDoc in your editor for the exact record shapes, for example `ApiKeyRecord` and
`Team`.

## Observability hooks

- **Logs:** pass `logger` (pino-compatible, `createLogger()` builds one) to route gateway logs
  into your logger.
- **Metrics:** pass `metrics: new PromMetrics()` and expose `metrics.registry` yourself, or use
  the platform's registry. The gateway serves `/metrics` itself when `metrics.enabled` is set.
- **Traces:** see [Tracing](#tracing) below.
- **Usage:** the `x-sy-*` response headers and `usage.cost` / `usage.sy_cache` in response bodies
  carry per-request routing and cost (see the API reference in the [README](../README.md)).

## Tracing

`startServer` (and so `switchyard serve`) calls `startTracing(config, { logger })` and shuts it
down after the drain. With `createGateway`, call it yourself, or bring your own SDK:

```ts
import { createGateway, loadConfig, createLogger, startTracing } from 'switchyard-gateway';

const config = loadConfig('gateway.yaml');
const logger = createLogger();
const tracing = await startTracing(config, { logger }); // no-op unless observability.otel.enabled
const gateway = createGateway({ config, logger });
// at shutdown, after gateway.close():
await tracing.shutdown(); // flushes pending spans
```

The gateway's code depends only on `@opentelemetry/api` (a regular dependency, `^1.9.0`). The
SDK packages are optional dependencies and are imported only by `startTracing` when tracing is
enabled ([ADR 0007](adr/0007-otel-sdk-packaging.md)). They need Node.js 22.15 or later. On older
Node versions, or with `--no-optional`, `startTracing` logs an error and returns an inactive
handle.

**Embedder rule: an existing global provider wins.** If your application registers a global
`TracerProvider` (for example with `@opentelemetry/sdk-node`) before `startServer` or
`startTracing` runs, Switchyard keeps it. Gateway spans go to your provider, under your
sampler, exporter and resource, and `observability.otel` export settings are ignored (a
warning says so). Switchyard then also leaves your context manager, propagator, diag logger and
error handler alone. To get gateway spans nested in your own traces:

- Register your provider, context manager and propagators first. Without a context manager,
  spans are not parented; without the W3C propagator, incoming `traceparent` is ignored and none
  is sent upstream. `NodeSDK.start()` registers all three.
- Keep one copy of `@opentelemetry/api` in the tree (`npm ls @opentelemetry/api`), at 1.9 or
  later. A global registered by one API copy is only visible to copies of the same or an older
  minor version. If the gateway resolves a newer minor than the copy that registered your
  provider, it records nothing.
- When you mount `gateway.app` behind your own HTTP instrumentation, the gateway's SERVER span
  becomes a child of your server span.

You do not need `observability.otel.enabled` for this. The flag only controls whether
Switchyard starts its own SDK.

**Custom adapters:** the attempt span is the active context while your adapter's `chat`,
`chatStream`, `embed` or `rerank` runs (and while the router pulls the first stream chunk).
To propagate it, add the headers in your adapter:

```ts
import { context, propagation } from '@opentelemetry/api';

const headers: Record<string, string> = { authorization: `Bearer ${config.api_key}` };
propagation.inject(context.active(), headers); // adds traceparent (+ tracestate, baggage)
```

The built-in adapters (OpenAI, Anthropic, OpenAI-compatible, the opencode bridge) already do
this.

## Config hot reload

`gateway.reload(config?)` swaps providers, models and routes atomically. In-flight requests
finish on the previous snapshot. Without an argument it calls the `reloadSource` passed to
`createGateway`, which `startServer` wires to re-read the config file (SIGHUP and
`POST /admin/config/reload`).

## Public API

The full list is in [`packages/gateway/src/index.ts`](../packages/gateway/src/index.ts), grouped
as follows. Every export has TSDoc, and CI enforces this with `pnpm check:api-docs`.

- **Gateway and server:** `createGateway`, `startServer`, `Gateway`, `CreateGatewayOptions`,
  `StartServerOptions`, `RunningServer`.
- **Config:** `loadConfig`, `parseConfigText`, `parseConfig`, `ConfigError`, the config types.
  The JSON Schema is at `switchyard-gateway/config.schema.json`.
- **Wire types and errors:** the OpenAI-shaped request, response and chunk types, `Usage` (with
  `cost` / `sy_cache` / `sy_saved_cost`), `GatewayError`, `ProviderError`.
- **Provider extension point:** `ProviderAdapter`, `AdapterFactory`, `AdapterDeps`,
  `ProviderConfig`, `CustomProviderConfig`, `ResolvedModel`, chunk helpers.
- **Services:** the interfaces above, plus the Noop, Memory and Static implementations,
  `hashKey`, `generateApiKey`.
- **Platform:** `createPlatform`, `createDatabase`, `runMigrations`, `migrationsFolder`,
  `UsageWorker`, `AdminService`, `queryUsage`.
- **Observability and cost:** `createLogger`, `PromMetrics`, `noopMetrics`, `startTracing`,
  `TracingHandle`, `StartTracingOptions`, `TRACER_NAME`, `TRACE_ID_HEADER`, `computeCost`,
  `estimateCost`, `formatUsd`.

The API follows semver from 1.0. Before that, minor versions (0.x) may contain breaking changes,
and they are called out in the [changelog](../packages/gateway/CHANGELOG.md).
