# Switchyard

[![CI](https://github.com/riz1-k/llm-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/riz1-k/llm-gateway/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/switchyard-gateway)](https://www.npmjs.com/package/switchyard-gateway)
[![image](https://img.shields.io/badge/ghcr.io-riz1--k%2Fswitchyard-blue)](https://github.com/riz1-k/llm-gateway/pkgs/container/switchyard)
[![node](https://img.shields.io/node/v/switchyard-gateway)](packages/gateway/package.json)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**An OpenAI-compatible LLM gateway in TypeScript: one endpoint for every model, with fallback,
caching, rate limits, budgets and per-team cost tracking. It also makes backends that can't do
tool calling or JSON mode behave like OpenAI.**

Apps talk plain OpenAI (official SDKs, LangChain, curl) to _virtual models_ such as `chat`.
Switchyard routes each call across providers with ordered fallback, retries and circuit
breakers, and prices every request. Add Redis and Postgres and it becomes a small multi-tenant
platform: teams and virtual keys, RPM/TPM limits, USD budgets, exact and semantic caching, a
usage ledger, an admin API and Grafana dashboards. It runs as a CLI and server, as a container,
on Kubernetes (Helm), or embedded in your own app as a [Hono](https://hono.dev) handler.

```bash
npx switchyard-gateway init && npx switchyard-gateway serve   # offline demo, no API keys needed
```

## Features

- **Drop-in OpenAI API:** `/v1/chat/completions` (streaming, tools, `response_format`,
  `stream_options.include_usage`), `/v1/embeddings`, `/v1/rerank` (Cohere/Jina shape) and
  `/v1/models`, with OpenAI-style errors. Verified with the official `openai` SDKs for Node and
  Python.
- **Providers:**
  - OpenAI and Anthropic, natively (the Messages API is translated, including streaming tool use);
  - any OpenAI-compatible server (llama.cpp, vLLM, Ollama, Groq, OpenRouter, …);
  - an [opencode](https://opencode.ai) bridge to GitHub Copilot models, with **emulated tool
    calling and JSON mode**;
  - a deterministic, fault-injectable mock;
  - your own adapter (`type: custom`).
- **Routing and resilience:**
  - virtual models with `fallback`, `weighted` or `least-latency` strategies;
  - retries with backoff and jitter that honour `Retry-After`;
  - per-attempt timeouts and route deadlines;
  - circuit breakers shared across replicas, and per-provider concurrency limits;
  - fallback during streaming, up to the first byte.
- **Caching:** an exact cache (per team, gzip, streamed replay) and an opt-in semantic cache on
  Redis 8 vector sets. Embeddings are cached per input item.
- **Limits and budgets:** sliding-window RPM/TPM per key and team in one atomic Lua call; daily
  and monthly USD budgets per team with soft alerts and hard 402 blocks.
- **Cost tracking:** every request is priced. The cost is in `x-sy-cost-usd` and in
  `usage.cost`, including the final streamed chunk. Usage events flow Redis Stream → worker →
  partitioned Postgres tables with daily rollups.
- **Operations:**
  - Prometheus metrics, Grafana dashboards and alert rules with runbooks;
  - `/healthz` and `/readyz`;
  - hot config reload and graceful shutdown;
  - a distroless image, a Helm chart and Terraform for kind.
- **Developer experience:**
  - `switchyard init` writes a starter config;
  - a JSON Schema gives editor completion for `gateway.yaml`;
  - the whole public API carries TSDoc;
  - an in-process `fetch` handler for zero-network tests.

## Quickstart

> **First release pending.** `switchyard-gateway` is not on npm yet: the release workflow is ready and waits for
> the one-time npm setup in [docs/RELEASING.md](docs/RELEASING.md). Until then, run it from source
> (`git clone https://github.com/riz1-k/llm-gateway && cd llm-gateway && pnpm install && pnpm build`, then
> `node packages/gateway/dist/cli.js` wherever this page says `npx switchyard-gateway`), or use the container
> image `ghcr.io/riz1-k/switchyard:edge`, built from `main`.

### npx

```bash
npx switchyard-gateway init     # writes gateway.yaml (mock provider) + .env.example
npx switchyard-gateway serve    # → http://localhost:8787/v1
```

```bash
curl localhost:8787/v1/chat/completions \
  -H 'authorization: Bearer sk-sy-local-change-me' -H 'content-type: application/json' \
  -d '{"model":"chat","messages":[{"role":"user","content":"hello"}]}'
```

```ts
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:8787/v1', apiKey: 'sk-sy-local-change-me' });
const res = await client.chat.completions.create({
  model: 'chat', // a Switchyard route
  messages: [{ role: 'user', content: 'hello' }],
});
console.log(res.choices[0].message.content, res.usage); // usage.cost = USD for this request
```

Install it globally with `npm i -g switchyard-gateway` to get the `switchyard` command
(Node.js 22.12 or later). Then replace the mock in `gateway.yaml` with real providers (see
[Configuration](#configuration)).

### Docker

```bash
docker run --rm -p 8787:8787 -e OPENAI_API_KEY \
  -v "$PWD/gateway.yaml:/etc/switchyard/gateway.yaml:ro" ghcr.io/riz1-k/switchyard:edge
```

`:edge` tracks `main`; versioned tags (`:0.1.0`, `:0.1`, `:latest`) are published by the release workflow.

The full local stack (gateway, worker, Redis, Postgres, Prometheus, Grafana and the mock) starts
with `make compose-up && make compose-demo`. Grafana is then on `:3301`.

### Helm

```bash
git clone https://github.com/riz1-k/llm-gateway && cd llm-gateway
helm install switchyard deploy/helm/switchyard -n switchyard --create-namespace -f my-values.yaml \
  --set image.tag=edge   # until the first release publishes the appVersion tag (0.1.0)
```

`my-values.yaml` holds your `gateway.yaml` under `config:` and points to your Redis 8 and
Postgres. The chart runs the API and the worker, a migration hook, an HPA, a PDB and a
ServiceMonitor. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), which also covers Terraform and kind.

### As a library

```ts
import { serve } from '@hono/node-server';
import { createGateway, loadConfig } from 'switchyard-gateway';

const gateway = createGateway({ config: loadConfig('gateway.yaml') });
serve({ fetch: gateway.fetch, port: 8787 }); // or app.route('/llm', gateway.app) in your Hono app
```

Custom providers, replaceable services (keys, limits, cache, usage sink) and in-process testing
with the OpenAI SDK are covered in [docs/LIBRARY.md](docs/LIBRARY.md).

## How it works

```mermaid
flowchart LR
  C["OpenAI SDK / LangChain / curl"] -->|"Bearer sk-sy-…"| A
  subgraph SY["Switchyard"]
    A["auth<br/>(static / DB keys)"] --> V["validate +<br/>resolve route"] --> E["estimate<br/>tokens + cost"]
    E --> L["rate limits<br/>(Lua, key + team)"] --> B["budget<br/>pre-flight"] --> K{"cache<br/>exact / semantic"}
    K -->|hit| R["response<br/>(+ streamed replay)"]
    K -->|miss| D["router: strategy →<br/>breaker → semaphore →<br/>attempt + retry → fallback"]
    D --> ACC["account: cost · TPM/budget<br/>reconcile · cache write"] --> R
    ACC -.->|XADD| U[("Redis Stream")]
  end
  D --> P1[(OpenAI)] & P2[(Anthropic)] & P3[("llama.cpp / vLLM / …")] & P4[("opencode → Copilot")] & P5[(custom)]
  U -.-> W["worker"] -.-> PG[("Postgres<br/>usage ledger")]
```

Each step is a small module behind an interface (`KeyStore`, `RateLimiter`, `BudgetGuard`,
`CacheStore`, `UsageSink`, `BreakerStore`). Without Redis and Postgres they are in-memory or
no-ops; with them they are shared across replicas. The full request lifecycle, failure behaviour
and data layout are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the design decisions in
[docs/adr/](docs/adr/README.md).

## Configuration

One YAML file with `${ENV}` / `${ENV:-default}` interpolation, validated at startup and by
`switchyard validate-config`. Add the schema line for completion and typo detection in your
editor:

```yaml
# yaml-language-server: $schema=https://unpkg.com/switchyard-gateway/config.schema.json
auth:
  static_keys: [{ key: '${APP_KEY}', team: my-app }] # or database keys: switchyard keys create
providers:
  openai: { type: openai, api_key: '${OPENAI_API_KEY}' }
  anthropic: { type: anthropic, api_key: '${ANTHROPIC_API_KEY}' }
  local: { type: openai-compatible, base_url: http://127.0.0.1:8081/v1 }
models:
  gpt: { provider: openai, model: gpt-5.6-luna }
  sonnet: { provider: anthropic, model: claude-sonnet-5.5 }
  qwen: { provider: local, model: qwen3.5-2b, pricing: { input: 0, output: 0 } }
  embedder: { provider: openai, model: text-embedding-3-small, kind: embedding }
routes:
  chat: # what clients put in "model"
    targets: [sonnet, gpt, qwen] # tried in order on failure
    retry: { attempts: 2 }
    cache: { exact: { ttl_s: 3600 } }
  embed: { targets: [embedder], cache: { exact: { ttl_s: 2592000 } } }
# optional platform layer
redis: { url: '${REDIS_URL}' } # limits, budgets, shared cache + breakers, usage stream
database: { url: '${DATABASE_URL}' } # DB keys and teams, budgets, usage ledger, admin API
limits: { defaults: { key: { rpm: 600, tpm: 2000000 }, team: { rpm: 1200 } } }
```

- [docs/CONFIG.md](docs/CONFIG.md): every option, generated from the schema.
- [config/gateway.example.yaml](config/gateway.example.yaml): a fully commented example.
- [docs/ADMIN.md](docs/ADMIN.md): teams, keys, budgets and the admin API.

### Providers

| `type`              | Chat + stream    | Tools                 | JSON mode          | Embeddings | Rerank |
| ------------------- | ---------------- | --------------------- | ------------------ | ---------- | ------ |
| `openai`            | ✓                | ✓ native              | ✓ native           | ✓          | –      |
| `anthropic`         | ✓ (translated)   | ✓ (`tool_use`)        | ✓ (tool or prompt) | –          | –      |
| `openai-compatible` | ✓                | ✓ (if the server can) | passthrough        | ✓          | ✓      |
| `opencode`          | ✓ (`/event` SSE) | ✓ **emulated**        | ✓ **emulated**     | –          | –      |
| `mock`              | ✓                | ✓ scripted            | –                  | ✓          | ✓      |
| `custom`            | your adapter     |                       |                    |            |        |

**opencode emulation:** the opencode server API has no `tools` or `response_format`. Switchyard
works around this:

- it renders the conversation into a transcript and describes the tools in the system prompt;
- it parses `<tool_call>` blocks with a tolerant scanner and validates names and arguments with
  ajv against your JSON Schemas;
- it asks for one repair when the output is invalid;
- it streams text deltas until a tool call starts.

Clients get standard `tool_calls` and validated JSON. See
[ADR 0002](docs/adr/0002-opencode-emulation.md) and
[docs/opencode-bridge.md](docs/opencode-bridge.md).

### Routing

A route lists targets and a strategy: `fallback` (in order), `weighted` (smooth weighted
round-robin) or `least-latency` (latency EWMA with ε-exploration). Retryable failures (429, 5xx,
timeouts, network) are retried on the same target with exponential backoff and full jitter, then
fall back to the next target. Client errors return immediately. Breakers open on a failure rate
or consecutive failures, cool down exponentially and probe half-open. Every response says where
it went: `x-sy-route`, `x-sy-provider`, `x-sy-model` and `x-sy-fallbacks`.

### Caching

- **Exact:** for deterministic requests (temperature 0 or unset, `n ≤ 1`). The key is a
  canonical hash of every response-affecting field, namespaced per team unless the route sets
  `shared: true`. Streaming requests get the cached response as a synthesized stream.
- **Semantic** (opt-in per route): embeds the last user message through one of your embedding
  routes and searches a Redis 8 vector set scoped by the exact system prompt and conversation
  ([ADR 0005](docs/adr/0005-semantic-cache-redis-vector-sets.md)).
- **Controls:** `x-sy-cache: bypass | refresh` per request. Hits report `x-sy-cache: hit`,
  `usage.cost: 0` and the saved cost.

### Limits and budgets

- **Rate limits:** sliding windows for RPM and TPM at key and team scope, checked
  all-or-nothing in one Lua call. TPM reserves the estimate and is reconciled to real usage.
  Rejections return OpenAI-style `x-ratelimit-*` headers and 429
  ([ADR 0003](docs/adr/0003-lua-sliding-window-limits.md)).
- **Budgets:** daily and monthly USD limits per team. A pre-flight upper-bound check returns 402
  `budget_exceeded`. Soft-threshold alerts fire once per period, optionally to a webhook. Redis
  counters are reconciled from Postgres
  ([ADR 0006](docs/adr/0006-budgets-preflight-reconciliation.md)).

```bash
switchyard teams create search --monthly-budget 50 --rpm 600
switchyard keys create --team search --name prod --routes chat,embed   # prints sk-sy-… once
switchyard usage --team search --group-by model
```

### Cost

Prices come from [`config/pricing.json`](config/pricing.json) (USD per 1M input, cached-input
and output tokens) or a per-model `pricing:` block. Every request is priced from the upstream's
usage report, falling back to an estimate. The cost appears in three places:

- the `x-sy-cost-usd` header;
- `usage.cost` and `usage.sy_cache` in response bodies and in the final streamed chunk (with
  `stream_options.include_usage`);
- the usage ledger, with cache savings tracked separately.

See [docs/API.md](docs/API.md#cost-in-the-response-body-usagecost).

### Observability

Prometheus metrics cover requests, latency, TTFT, tokens, cost, cache results, rate-limit and
budget rejections, fallbacks, retries, breaker states, provider concurrency and usage-stream lag
([docs/METRICS.md](docs/METRICS.md)). Three provisioned Grafana dashboards and alert rules with
runbooks are included ([docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)).

| Overview                                                       | Cost & budgets                                         | Providers & reliability                                          |
| -------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| ![Overview](observability/screenshots/switchyard-overview.png) | ![Cost](observability/screenshots/switchyard-cost.png) | ![Providers](observability/screenshots/switchyard-providers.png) |

These come from the compose demo. The same dashboards from the dev gateway, with per-team cost of
real DocsQA, OpsAgent and eval traffic (2026-10-27):
[Cost & budgets](observability/screenshots/dev-switchyard-cost.png) ·
[Overview](observability/screenshots/dev-switchyard-overview.png) ·
[Providers](observability/screenshots/dev-switchyard-providers.png)
([how to read them](docs/OBSERVABILITY.md#from-the-dev-gateway-real-traffic-2026-10-27)).

## Deployment

| Target         | How                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Single process | `switchyard serve` (`usage.in_process_writer: true` when using Postgres)                                                             |
| Docker         | `ghcr.io/riz1-k/switchyard`: distroless, non-root, multi-arch, about 65 MB compressed; one image for `serve`, `worker` and `migrate` |
| Compose        | `deploy/docker/docker-compose.yml`: the full stack with dashboards                                                                   |
| Kubernetes     | `deploy/helm/switchyard`, plus Terraform modules and a kind environment in `deploy/terraform`                                        |

Details in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Production hardening is in
[SECURITY.md](SECURITY.md).

## Benchmarks

Measured with k6 against a mock upstream that answers instantly, so the numbers are the
gateway's own cost. The gateway is pinned to **one core** of a laptop CPU (i5-1135G7), with the
load generator on another. Each latency run is 200 req/s. Overhead is gateway p50 minus direct
p50. Full method, raw data and caveats are in [bench/RESULTS.md](bench/RESULTS.md).

<!-- BENCH:START -->

| Scenario (p50, 200 req/s)               | Direct mock | Gateway, platform off | Gateway, platform on |
| --------------------------------------- | ----------: | --------------------: | -------------------: |
| Chat, cache miss                        |     0.34 ms |    2.60 ms (+2.26 ms) |   3.76 ms (+3.41 ms) |
| Streaming, time to first byte           |     0.35 ms |    4.44 ms (+4.08 ms) |   3.57 ms (+3.21 ms) |
| Exact-cache hit (vs a full direct call) |     0.34 ms |    0.83 ms (+0.48 ms) |   2.06 ms (+1.72 ms) |
| Embeddings (2 inputs)                   |     0.30 ms |    2.84 ms (+2.55 ms) |   4.72 ms (+4.42 ms) |
| Max throughput, miss (one core)         | 4,198 req/s |           1,243 req/s |            651 req/s |
| Max throughput, hit (one core)          |           – |           3,630 req/s |          2,017 req/s |

"Platform on" adds Postgres virtual keys, Redis rate limits, budgets, the Redis cache and the
usage stream, all checked on every request. The SPEC targets are under 3 ms p50 overhead on a
miss and under 1 ms on a hit. They are met with the platform off and missed with it on (about
3.2–3.4 ms and 1.1–1.7 ms across runs). The numbers come from a shared, busy laptop: the
streaming row's off/on inversion is noise, and RESULTS.md has the profile, an A/B of the fixes
and the caveats.

<!-- BENCH:END -->

## Dogfooding

The two other projects of the portfolio, [DocsQA](https://github.com/riz1-k/docsqa) and
[OpsAgent](https://github.com/riz1-k/opsagent), send every model call through a Switchyard
instance on the development machine, and so do their eval runners (team `evals`). Its usage
ledger, from the first recorded request to the last, 2026-10-27 11:02–21:22 IST
(`GET /admin/usage?group_by=team&from=2026-10-01&to=2026-10-27`; fallbacks from `usage_events`):

| Team                          |  Requests | Tokens (prompt / completion) |  Cost (USD) | Cache hits        | Fallbacks |
| ----------------------------- | --------: | ---------------------------: | ----------: | ----------------- | --------: |
| `evals`                       |     1,225 |             921,313 / 53,198 |     $1.0209 | 680 (55.5%)       |         0 |
| `docsqa`                      |     1,108 |             843,452 / 14,694 |     $0.4864 | 704 (63.5%)       |         0 |
| `opsagent`                    |       294 |           1,395,851 / 55,452 |     $0.7465 | 2 (0.7%)          |         0 |
| scratch teams (failure tests) |        31 |                   2,976 / 75 |     $0.0015 | 3                 |         0 |
| **Total**                     | **2,658** |      **3,163,592 / 123,419** | **$2.2552** | **1,389 (52.3%)** |     **0** |

- **Cost is shadow cost.** Copilot (via opencode) is flat-rate; its 333 requests are priced at
  list-price equivalents: $1.4682 spent, plus $0.1989 saved by exact-cache hits. The rest is
  the deterministic mock model used for quota-free runs, which carries a demo price ($0.7871).
  The local llama.cpp embeddings and rerank and OpsAgent's scripted model are free.
- **Caching pays off where requests repeat:** 1,342 of 1,531 embedding requests were cache hits
  (repeated questions and eval reruns), and re-running evals replays Copilot answers from the exact
  cache. Agent turns rarely repeat, hence OpsAgent's 0.7%.
- **No request fell back** to a second target. Of the 21 errors, 19 are the 402/429
  failure-mode tests on scratch teams; the other two are a client disconnect (499) and a 502 from
  OpsAgent's scripted model while it was not running (the route's smoke test).

The queries and raw outputs are in [docs/STATUS.md](docs/STATUS.md#cross-project-o).

## How it compares

Switchyard is small and focused. Pick it when you want a self-hosted TypeScript gateway that you
can read end to end, embed as a library, and run with Redis and Postgres. Pick the others when
you need their breadth. This is our best understanding as of October 2026; check each project's
docs, and corrections are welcome.

|                                              | Switchyard                                             | [LiteLLM](https://github.com/BerriAI/litellm) | [Portkey Gateway](https://github.com/Portkey-AI/gateway) | [Helicone](https://github.com/Helicone/helicone) |
| -------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Language                                     | TypeScript (Hono)                                      | Python                                        | TypeScript (Hono)                                        | TypeScript platform; Rust AI gateway             |
| Focus                                        | Self-hosted gateway + cost/budget platform             | Broadest provider coverage, proxy + SDK       | Routing gateway; governance in the hosted platform       | Observability first, plus a gateway              |
| Providers                                    | OpenAI, Anthropic, OpenAI-compatible, opencode, custom | 100+                                          | 200+                                                     | Many, through its gateway                        |
| Fallback / retries                           | ✓                                                      | ✓                                             | ✓                                                        | ✓                                                |
| Virtual keys, budgets                        | ✓ (Postgres)                                           | ✓                                             | Mostly in the hosted product                             | Partial                                          |
| Caching                                      | Exact + semantic (Redis 8)                             | Exact + semantic (several backends)           | Simple + semantic                                        | ✓                                                |
| Tool / JSON emulation for text-only backends | ✓                                                      | –                                             | –                                                        | –                                                |
| Embeddable as a library                      | ✓ (Fetch handler)                                      | Python SDK                                    | ✓                                                        | –                                                |
| UI                                           | Grafana dashboards, CLI, admin API (no web UI)         | Admin UI                                      | Hosted UI                                                | Full web UI                                      |
| Guardrails, prompt management                | –                                                      | ✓                                             | ✓                                                        | Prompts ✓                                        |
| Maturity                                     | New (0.x), one maintainer                              | Mature, large community                       | Mature                                                   | Mature                                           |

## Roadmap

- OpenTelemetry traces (`gen_ai.*` conventions). The config keys exist and are marked reserved.
- Atomic budget reservations, to remove the concurrent-overshoot bound (SR-14), and per-key
  concurrency limits.
- Scoped admin tokens and RBAC, with per-token audit attribution.
- More native providers (Gemini, Bedrock), and hedged requests.
- Redis Cluster support (hash-tagged keys).
- Accounting for semantic-cache embedding calls.

Known gaps are tracked in [docs/STATUS.md](docs/STATUS.md#known-gaps).

## Documentation

| Doc                                                | What                                                           |
| -------------------------------------------------- | -------------------------------------------------------------- |
| [docs/CONFIG.md](docs/CONFIG.md)                   | Configuration reference (generated from the schema)            |
| [docs/API.md](docs/API.md)                         | HTTP API: endpoints, headers, `usage.cost`, errors             |
| [docs/LIBRARY.md](docs/LIBRARY.md)                 | Embedding, custom providers, services, testing                 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)       | Request lifecycle, components, failure behaviour               |
| [docs/adr/](docs/adr/README.md)                    | Architecture decision records                                  |
| [docs/ADMIN.md](docs/ADMIN.md)                     | Teams, keys, limits, budgets, cache, usage pipeline, admin API |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)           | Image, Compose, Helm, Terraform, sizing, upgrades              |
| [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)     | Dashboards, alerts, runbooks                                   |
| [docs/METRICS.md](docs/METRICS.md)                 | Metric reference and queries                                   |
| [docs/opencode-bridge.md](docs/opencode-bridge.md) | The Copilot bridge and its emulation protocols                 |
| [docs/RELEASING.md](docs/RELEASING.md)             | Release process and one-time setup                             |
| [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) | Threat model, findings and residual risks                      |
| [bench/RESULTS.md](bench/RESULTS.md)               | Benchmark method and results                                   |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup
(`pnpm install && pnpm test`, with Redis and Postgres for the platform tests), changesets and
conventions. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Part of a three-project portfolio

Switchyard, DocsQA and OpsAgent are built to work together: both applications send every model call through the
gateway, which puts every provider behind one metered, budgeted, observable API. In this setup that is GitHub
Copilot through a local opencode bridge plus local llama.cpp models; OpenAI and Anthropic are drop-in alternatives.

```mermaid
flowchart LR
  DQ["DocsQA<br/>permission-aware RAG"] -- "team docsqa" --> SY
  OA["OpsAgent<br/>LangGraph agent + MCP, approved refunds"] -- "team opsagent" --> SY
  EV["Eval runners<br/>(both apps)"] -- "team evals" --> SY
  SY["Switchyard<br/>LLM gateway: routes, fallbacks, cache,<br/>rate limits, budgets, per-team cost"]
  SY --> CP["GitHub Copilot via opencode<br/>(Claude Sonnet / Haiku, GPT)"]
  SY --> LC["llama.cpp<br/>embeddings + rerank"]
  SY --> OAI["OpenAI"]
  SY --> ANT["Anthropic"]
  SY -- "/metrics" --> PR["Prometheus"] --> GF["Grafana<br/>Overview · Cost & Budgets · Providers"]
  SY -- "usage ledger (Postgres)" --> GF
  OA -. "traces" .-> LF["Langfuse"]
```

- **[Switchyard](https://github.com/riz1-k/llm-gateway)**: the TypeScript LLM gateway. One OpenAI-compatible API
  with routing and fallbacks, exact and semantic caching, rate limits, budgets and per-team cost.
- **[DocsQA](https://github.com/riz1-k/docsqa)**: permission-aware RAG over technical docs (Postgres row-level
  security, hybrid retrieval, verified citations, an eval suite with gates).
- **[OpsAgent](https://github.com/riz1-k/opsagent)**: a LangGraph operations agent with an MCP server, where every
  refund needs a human approval and a signed, single-use token.

How they connect:

- **Teams, keys, budgets.** Each app has a virtual key bound to its team (`docsqa`, `opsagent`; eval runs use
  `evals`), each team a monthly hard budget ($50 / $50 / $100). `llm-gateway/scripts/seed-portfolio.sh` creates
  them through the admin API and writes the DB-backed keys into each app's gitignored `.env`.
- **Route names only.** The apps ask for virtual models (`docsqa-chat`, `docsqa-embed`, `opsagent-chat`, …); which
  provider serves them, and the fallback order, is gateway config.
- **Attribution.** Requests carry `x-sy-user` (the end user or operator) and `x-sy-tags`
  (`app:docsqa,feature:answer`, `app:opsagent,node:agent`, `eval,case:q017`), stored with every usage event.
- **Per-team cost.** The gateway prices every call (Copilot at shadow list prices, since it is flat-rate), returns it
  in `usage.cost` (also on streams, which the apps show per answer and per agent run) and exports it per team to
  Prometheus and Grafana
  ([Cost & Budgets from the dev gateway](https://github.com/riz1-k/llm-gateway/blob/main/observability/screenshots/dev-switchyard-cost.png),
  real traffic, 2026-10-27). A spent budget or a rate limit reaches the apps as 402 / 429, which they turn into clear
  messages.

## License

[MIT](LICENSE) © riz1-k
