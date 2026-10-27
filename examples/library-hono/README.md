# Library: Switchyard inside a Hono app

[`server.ts`](server.ts) embeds the gateway with `createGateway()` and mounts it with
`app.route('/llm', gateway.app)` next to the app's own routes. A custom `UsageSink` aggregates
cost per `x-sy-user`, exposed at `GET /usage/by-user`. The config is inline and uses the
in-process mock, so nothing else has to run.

The same file serves with `@hono/node-server` on Node, `Bun.serve` on Bun and `Deno.serve` on
Deno (`USE_NODE_SERVER=1` forces `@hono/node-server` everywhere).

```bash
(cd ../../packages/gateway && pnpm pack --pack-destination ../../examples/.pack)   # run-all.sh does this
npm install
node server.ts       # http://127.0.0.1:8788 — also: bun server.ts, deno run -A server.ts
curl localhost:8788/llm/v1/chat/completions -H 'authorization: Bearer sk-sy-example-library' \
  -H 'content-type: application/json' -H 'x-sy-user: alice' \
  -d '{"model":"chat","messages":[{"role":"user","content":"hello"}]}'
curl localhost:8788/usage/by-user
```

On Bun, prefer `Bun.serve`: with `@hono/node-server` on Bun, a client that disconnects before
the first byte is not detected (see [Runtime support](../../README.md#runtime-support)).

Once `switchyard-gateway` is published, replace the `file:` dependency with `"0.1.0"`.

What `run-all.sh` checks:

```text
library-hono listening on http://127.0.0.1:18702 (@hono/node-server)
✔ app route: GET / → "my service, with an LLM gateway under /llm"
✔ mounted gateway: POST /llm/v1/chat/completions → "hello from the embedded gateway" cost=$0.0000048
✔ models: ["chat","embed"]
✔ custom UsageSink: GET /usage/by-user → {"alice":{"requests":1,"cost_usd":0.0000048,"tags":["feature:demo"]}}
✔ auth: no key → 401
library-hono: all checks passed
```
