# switchyard-gateway

[![CI](https://github.com/riz1-k/llm-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/riz1-k/llm-gateway/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/switchyard-gateway)](https://www.npmjs.com/package/switchyard-gateway)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/riz1-k/llm-gateway/blob/main/LICENSE)

**Switchyard** is an OpenAI-compatible LLM gateway in TypeScript. Point any OpenAI SDK at it
and get virtual models with ordered fallback, retries and circuit breakers, exact and semantic
caching, RPM/TPM limits, per-team USD budgets and a cost ledger, across OpenAI, Anthropic,
any OpenAI-compatible server (llama.cpp, vLLM, Ollama, …) and an
[opencode](https://opencode.ai) bridge. It runs as a CLI/server or embeds as a
[Hono](https://hono.dev) app.

## 30-second start

```bash
npx switchyard-gateway init     # writes gateway.yaml + .env.example (mock provider, no keys needed)
npx switchyard-gateway serve    # http://localhost:8787/v1
```

```bash
curl localhost:8787/v1/chat/completions \
  -H 'authorization: Bearer sk-sy-local-change-me' -H 'content-type: application/json' \
  -d '{"model":"chat","messages":[{"role":"user","content":"hello"}]}'
```

Any OpenAI client works unchanged:

```ts
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:8787/v1', apiKey: 'sk-sy-local-change-me' });
const res = await client.chat.completions.create({
  model: 'chat', // a Switchyard route, not an upstream model id
  messages: [{ role: 'user', content: 'hello' }],
});
console.log(res.choices[0].message.content, res.usage); // usage.cost = USD for this request
```

Install globally (`npm i -g switchyard-gateway`) to get the `switchyard` command. Requires
Node.js ≥ 22.12.

## As a library

```bash
npm i switchyard-gateway @hono/node-server
```

```ts
import { serve } from '@hono/node-server';
import { createGateway, loadConfig } from 'switchyard-gateway';

const gateway = createGateway({ config: loadConfig('gateway.yaml') });
serve({ fetch: gateway.fetch, port: 8787 }); // or mount gateway.app inside your Hono app
```

Custom upstreams plug in through `type: custom` providers and
`createGateway({ adapterFactories })`; storage and policy (keys, rate limits, budgets, cache,
usage sink) through `createGateway({ services })`. See
[docs/LIBRARY.md](https://github.com/riz1-k/llm-gateway/blob/main/docs/LIBRARY.md).

## What's in the package

| Entry                                   | What                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `switchyard-gateway`                    | `createGateway`, `startServer`, `loadConfig`, types, extension interfaces |
| `switchyard-gateway/mock-provider`      | deterministic, fault-injectable fake OpenAI/Anthropic server              |
| `switchyard-gateway/config.schema.json` | JSON Schema of `gateway.yaml` (editor completion and validation)          |
| `switchyard` CLI                        | `init`, `serve`, `validate-config`, `worker`, `migrate`, admin commands   |

Editor support for configs:

```yaml
# yaml-language-server: $schema=https://unpkg.com/switchyard-gateway/config.schema.json
```

## Documentation

- [README and architecture](https://github.com/riz1-k/llm-gateway#readme)
- [Configuration reference](https://github.com/riz1-k/llm-gateway/blob/main/docs/CONFIG.md)
- [Admin API and CLI](https://github.com/riz1-k/llm-gateway/blob/main/docs/ADMIN.md)
- [Deployment (Docker, Helm, Terraform)](https://github.com/riz1-k/llm-gateway/blob/main/docs/DEPLOYMENT.md)
- [Benchmarks](https://github.com/riz1-k/llm-gateway/blob/main/bench/RESULTS.md)
- [Changelog](https://github.com/riz1-k/llm-gateway/blob/main/packages/gateway/CHANGELOG.md)

MIT © riz1-k
