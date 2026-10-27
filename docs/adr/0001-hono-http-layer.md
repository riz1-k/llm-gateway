# ADR 0001: Hono as the HTTP layer, with a Fetch-API core

- **Status:** Accepted
- **Date:** 2026-06

## Context

Switchyard ships as a CLI/server and as a library. Library users want to mount the gateway in
an existing app, in a test or in a serverless function, without adopting our server. The hot
path is mostly I/O: authenticate, check limits, call one upstream, stream bytes back. Per-request
overhead matters (the target is under 3 ms p50 over a direct upstream call; see
[bench/RESULTS.md](../../bench/RESULTS.md)). Streaming (SSE) has to work everywhere, including
client disconnects that must abort the upstream call.

## Decision

- The gateway is a [Hono](https://hono.dev) app. `createGateway()` returns `{ app, fetch, close }`,
  where `fetch` is a standard `(Request) => Promise<Response>`.
- Node hosting goes through `@hono/node-server`, in `startServer()` and the CLI. Nothing below
  the HTTP layer imports Node's `http` module.
- Streaming responses are `ReadableStream`s built from async iterables. The request's
  `AbortSignal` is threaded through the pipeline into every upstream `fetch`.
- Request validation uses zod at the edge. The pipeline (`core/pipeline.ts`) only sees typed,
  canonical requests.

## Consequences

- Embedding is one line: `serve({ fetch: gateway.fetch })`, `app.route('/llm', gateway.app)`, or
  calling `gateway.fetch(new Request(...))` directly in tests. The contract tests run the
  official `openai` SDK against `gateway.fetch` without opening a socket.
- The core uses only Fetch-API types, so other runtimes are possible. Bun and Deno are untested,
  and the platform layer (ioredis, postgres.js) still needs Node-compatible TCP.
- Hono's router and middleware cost microseconds. The measured gateway overhead is dominated by
  JSON parsing, token estimation and the upstream hop (see the benchmarks).
- We depend on `@hono/node-server`'s Request/Response bridging for Node. Body limits and
  disconnect handling are tested at that layer.

## Alternatives considered

- **Fastify:** fast and mature, but tied to Node's `http` objects. Embedding in non-Fastify apps
  and fetch-style testing would need adapters.
- **Express:** slower, callback-style streaming, no built-in typing of the request lifecycle.
- **Plain `node:http`:** least overhead, but we would rebuild routing, middleware and the Fetch
  bridge ourselves.
