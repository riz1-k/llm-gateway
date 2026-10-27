# Examples

Runnable clients for Switchyard, one folder per SDK. Each one runs against the bundled mock
provider, checks its own output and prints `<name>: all checks passed`. No API key or real
provider is needed.

| Example                               | Client                                            | Shows                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [openai-node](openai-node/)           | `openai` 7.45.1 (TypeScript)                      | chat, streaming with the final `usage.cost` chunk, embeddings with `input_type`, tools, `json_schema`, `x-sy-*` headers, typed errors     |
| [openai-python](openai-python/)       | `openai` 3.40.0 (Python)                          | chat, streaming cost, embeddings with `input_type`, tools, headers via `with_raw_response`, typed errors                                  |
| [vercel-ai-sdk](vercel-ai-sdk/)       | `ai` 7.0.154 + `@ai-sdk/openai-compatible` 3.0.79 | `generateText`, `streamText`, a tool call with `execute`, `embedMany`, cost through a `metadataExtractor`                                 |
| [langchain-python](langchain-python/) | `langchain-openai` 1.7.3 (the OpsAgent setup)     | `ChatOpenAI(base_url=…)`, streaming usage, `bind_tools` round trip, response headers, `OpenAIEmbeddings`                                  |
| [langchain-js](langchain-js/)         | `@langchain/openai` 1.7.1                         | `configuration.baseURL`, `bindTools` round trip, `withStructuredOutput` (json_schema)                                                     |
| [curl](curl/)                         | curl + jq                                         | `/v1/rerank`, `x-sy-cache: bypass \| refresh`, `x-sy-user` / `x-sy-tags`, the error envelope (401/404/400, and 402/429 with the platform) |
| [library-hono](library-hono/)         | `switchyard-gateway` as a library, Hono 4.13.14   | `createGateway` mounted under `/llm` next to app routes, a custom `UsageSink` for per-user cost, Node / Bun / Deno servers                |

## Run them all

```bash
pnpm install && pnpm build          # from the repository root
examples/run-all.sh                 # platform off: no Redis, no Postgres
examples/run-all.sh --platform      # + local Redis db 1 and Postgres llmgateway_test: budget 402, rate limit 429
examples/run-all.sh --runtime bun   # gateway, mock provider and TypeScript examples on Bun (or: deno)
examples/run-all.sh --only curl,openai-node
```

`run-all.sh`:

1. installs each example's dependencies into its own folder (`npm ci`; Python examples run with
   `uv run --script` in an ephemeral environment). Nothing is added to the root pnpm workspace;
2. packs the gateway from this checkout (`pnpm pack`) for the library example, as `npm i` would;
3. starts `switchyard mock-provider` and `switchyard serve --config config/gateway.examples.yaml`
   on free ports in 18700–18799 (`EXAMPLES_PORTS` changes the range);
4. runs every example, checks for its success line and checks that the attribution headers
   reached the usage events;
5. stops everything it started and exits non-zero on any failure.

Requirements: Node.js ≥ 22.18 (the TypeScript examples run as plain `.ts` through Node's type
stripping), npm, curl, jq and [uv](https://docs.astral.sh/uv/). `--runtime bun|deno` needs that
runtime. `--platform` needs `redis-cli`, Redis (db ≥ 1, set `EXAMPLES_REDIS_URL`) and Postgres
(`EXAMPLES_DATABASE_URL`, default `postgres://dev:dev@127.0.0.1:5432/llmgateway_test`); the
gateway's migrations are applied to that database, Redis keys use a random prefix that is deleted
afterwards, and the two throwaway teams are soft-deleted.

## Run one by hand

```bash
node packages/gateway/dist/cli.js mock-provider                                   # :8790
node packages/gateway/dist/cli.js serve --config examples/config/gateway.examples.yaml   # :8787
cd examples/openai-node && npm ci && node index.ts
```

The examples read `SWITCHYARD_BASE_URL` (default `http://127.0.0.1:8787/v1`) and
`SWITCHYARD_API_KEY` (default `sk-sy-examples-local`, the key in the examples config).

## The mock routes

[`config/gateway.examples.yaml`](config/gateway.examples.yaml) routes everything to the mock:

| Route        | Behavior                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `chat`       | echoes the last user message (exact cache on)                                                                       |
| `tools`      | calls the first tool with arguments synthesized from its JSON Schema, then summarizes the tool results              |
| `structured` | always answers `{"city":"Paris",…}`: shows the `json_schema` request and parsing; the mock does not enforce schemas |
| `embed`      | deterministic 256-d embeddings, with `query:` / `passage:` input templates                                          |
| `rerank`     | deterministic lexical rerank                                                                                        |

Point the same code at a real gateway by changing the base URL, the key and the route names.
