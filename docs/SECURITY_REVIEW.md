# Switchyard security and correctness review

_Pre-release review, 2026-10-27, at commit `08d9ce9` plus the working tree. Reviewer: an
independent agent (brief P). Fixes are in the working tree with regression tests and are not
committed yet._

## 1. Scope and method

**In scope:** `packages/gateway` (library, CLI, HTTP API, platform layer) and
`packages/mock-provider`. Deployment assets (`deploy/`, `observability/`, `.github/`,
`config/gateway.compose.yaml`) were read only, because another agent was editing them; findings
there are listed as follow-ups in §6.

**Method:**

1. Map every entry point, then trace untrusted input to its sinks.
2. Confirm each suspicion with a proof script or test before calling it a finding. Proofs ran
   against in-process gateways, a source build on `127.0.0.1:8788`, Redis db 1 and Postgres
   `llmgateway_test`. No real LLM calls were made.
3. Fix every confirmed critical, high or medium issue that has a clear, safe fix, and add a
   regression test for each (`test/unit/security.test.ts`, plus `platform/keys.test.ts` and
   `unit/providers/opencode.test.ts`).

**Entry points reviewed:**

| Surface                  | Entry points                                                                                                               | Auth                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| OpenAI-compatible API    | `POST /v1/chat/completions` (JSON + SSE), `/v1/embeddings`, `/v1/rerank`, `GET /v1/models[/:id]`                           | virtual key (`Authorization: Bearer` or `x-api-key`) |
| Admin API                | `/admin/*` (teams, keys, rotate/revoke, budgets, usage, cache purge, audit, config, reload, providers/health)              | admin token (constant-time compare)                  |
| Ops                      | `/healthz`, `/readyz[?probe=1]`, `/metrics` (API port or `metrics.port`), worker `/metrics` and `/healthz`                 | none (probe: admin token after fix)                  |
| CLI                      | `serve`, `worker`, `migrate`, `validate-config`, `mock-provider`, `teams`, `keys`, `budgets`, `usage`, `cache`, `seed-dev` | local DB access, or remote with the admin token      |
| Background               | usage stream worker (XREADGROUP → Postgres), budget reconciliation, partition maintenance, budget webhooks                 | internal                                             |
| Outbound                 | provider adapters (openai, anthropic, openai-compatible, opencode bridge, mock), budget webhooks                           | provider credentials from config                     |
| Standalone mock provider | `/v1/*`, Anthropic `/v1/messages`, `/mock/*` control endpoints                                                             | none (test tool, binds `127.0.0.1` by default)       |

## 2. Threat model

- **Assets:**
  - upstream provider credentials, including the opencode basic-auth password and the Copilot
    subscription behind it;
  - virtual keys and the admin token;
  - tenant data in prompts, cached responses and usage records;
  - billing integrity: budgets, usage ledger, rate limits;
  - availability of a gateway that many tenants share;
  - the opencode host.
- **Actors:**
  - Unauthenticated network clients.
  - Authenticated tenants (virtual-key holders). Some are semi-trusted apps that forward
    end-user or document text, so request content is attacker-influenced, and indirect prompt
    injection reaches the model.
  - Admins, who are trusted.
  - Upstream providers, which are trusted for correctness but can fail.
- **Main trust boundary:** request bodies and headers on `/v1/*`. They drive the CPU work
  (tokenization, JSON-schema validation), memory (vectors, attribution fields), cache keys,
  usage records and the content that reaches the opencode agent.
- **Out of scope:** model-level prompt injection in consumer apps (DocsQA and OpsAgent own tool
  execution); host and network hardening outside the repo.

## 3. Findings

Severity reflects real-world impact on a shared gateway. Status: **fixed** (in the working tree,
with tests), **accepted** (documented residual risk), **follow-up** (needs a change in a path
owned by another agent; the exact change is in §6).

| ID    | Severity | Title                                                                                                               | Status    | Files                                                                            |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| SR-01 | High     | Token estimation lets one request stall the event loop (quadratic BPE on long runs)                                 | fixed     | `src/limits/estimate.ts`, `src/core/pipeline.ts`, `src/providers/mock.ts`        |
| SR-02 | High     | ReDoS through client JSON-Schema `pattern` in opencode tool and JSON-mode emulation                                 | fixed     | `src/util/json-schema.ts`                                                        |
| SR-03 | Medium   | Schema validator memory grows without bound; schema `$id` registry is shared across requests                        | fixed     | `src/util/json-schema.ts`                                                        |
| SR-04 | Medium   | Unbounded embedding `dimensions` crashes the gateway (OOM) through the mock provider                                | fixed     | `src/http/validation.ts`, `src/providers/mock.ts`, `mock-provider/src/server.ts` |
| SR-05 | Medium   | Client-chosen `x-request-id` is the usage-ledger idempotency key, so usage is dropped and spend under-counted       | fixed     | `src/app.ts`, `src/core/pipeline.ts`                                             |
| SR-06 | Medium   | opencode bridge relies only on server-side agent config to keep shell, edit and fetch tools off                     | fixed\*   | `src/providers/opencode/client.ts`, `src/providers/opencode/index.ts`            |
| SR-07 | Medium   | Unbounded `user`, `x-sy-user` and tags are copied into every usage event (Redis, buffer, Postgres)                  | fixed     | `src/app.ts`                                                                     |
| SR-12 | Medium   | Exact and semantic cache keys ignore response-affecting fields, so the cache serves wrong responses                 | fixed     | `src/cache/keys.ts`, `src/cache/semantic.ts`                                     |
| SR-14 | Medium   | Budget check-then-record race: concurrent requests can overshoot a hard budget                                      | accepted  | `src/limits/redis-budgets.ts:152`, `src/core/pipeline.ts` (`admit`)              |
| SR-08 | Low      | Malformed keys cost a Redis GET, a negative-cache write and a Postgres query, unauthenticated                       | fixed     | `src/auth/db-key-store.ts`, `src/auth/keys.ts`                                   |
| SR-09 | Low      | `GET /admin/config` leaks upstream `headers`, `x-api-key`-style keys and webhook URLs                               | fixed     | `src/admin/routes.ts`                                                            |
| SR-10 | Low      | Unauthenticated `/readyz?probe=1` fans out upstream and returns error details; `/admin` has no body limit           | fixed     | `src/app.ts`                                                                     |
| SR-11 | Low      | Client errors echo upstream auth messages (masked provider keys) and internal error text (hosts)                    | fixed     | `src/core/errors.ts`, `src/core/pipeline.ts`                                     |
| SR-13 | Low      | Pre-flight ignores `n`, so TPM and budget reservations are too small for `n > 1`                                    | fixed     | `src/core/pipeline.ts`                                                           |
| SR-15 | Low      | Redis outage fails open for rate limits and budgets by default                                                      | accepted  | `src/config/schema.ts:268` (`redis.fail_open: true`)                             |
| SR-16 | Low      | `/metrics` is unauthenticated on the API port unless `metrics.port` is set                                          | accepted  | `src/app.ts` (metrics route)                                                     |
| SR-17 | Low      | No connection or slow-body limits at the HTTP server (`requestTimeout = 0` for long generations)                    | accepted  | `src/server.ts:73`                                                               |
| SR-18 | Low      | One shared admin token (no RBAC or scoping); `--admin-token` on the CLI is visible in `ps`                          | accepted  | `src/app.ts`, `src/cli/commands.ts`                                              |
| SR-22 | Low      | Compose Redis (192 MB, `noeviction`) is smaller than the usage stream (MAXLEN 1e6); when it fills, limits fail open | follow-up | `config/gateway.compose.yaml`, `deploy/docker/docker-compose.yml`                |
| SR-19 | Info     | `cache.shared: true` and the semantic cache can serve one team's answer to another                                  | accepted  | `src/cache/keys.ts`                                                              |
| SR-20 | Info     | Budget webhook URLs are admin-supplied (SSRF limited to admins); no scheme allowlist                                | accepted  | `src/admin/schemas.ts`, `src/limits/redis-budgets.ts`                            |
| SR-21 | Info     | Prompt-injection surface in opencode transcript rendering                                                           | accepted  | `src/providers/opencode/transcript.ts`                                           |
| SR-23 | Info     | Dev-only advisory: `esbuild` ≤ 0.24.2 through `drizzle-kit` (GHSA-67mh-4wv8-2f99)                                   | accepted  | `pnpm-lock.yaml`                                                                 |

\* SR-06 is covered by unit tests against the fake opencode server. It still needs one live
check: `pnpm test:live`, about 5 real Copilot calls. This review made no real LLM calls.

Unless noted otherwise, file references are under `packages/gateway/`. Line numbers refer to
`HEAD` (`08d9ce9`).

### SR-01 (High): token estimation stalls the event loop

- **Evidence:** `src/limits/estimate.ts:26` called `encoder.encode(text)` on the whole request
  text, and `src/core/pipeline.ts:614` ran it for every chat request. The rate limiter needs the
  estimate, so the encode happens before the request is rate limited.
- **Why it is slow:** js-tiktoken's byte-pair merge is quadratic in the length of each
  pre-token, that is, each run of letters, punctuation or whitespace.
- **Measured:**
  - 10 KB of `"a"` took 10 s.
  - A 2048-character CJK run took 3 s.
  - 1 MB of ordinary prose took 250 ms.
- **Exploit:** any key holder, even one with a tiny rate limit, sends one 50 KB message of
  `"aaaa…"`. The single-threaded gateway freezes for minutes for every tenant, and health checks
  fail.
- **Fix:** estimation is bounded and still exact for ordinary text:
  - Runs over 12 characters, or over 4 consecutive non-ASCII characters, are estimated as UTF-8
    bytes / 4 instead of encoded.
  - At most 16 KiB (UTF-8) per request is encoded exactly. A `TokenBudget` is shared by every
    text of the request: messages, tools, embedding inputs, the per-item cost split, and rerank
    documents.
  - Worst case is now about 40 ms per request; prose remains exact.
  - The same 2 MB single-run body now completes in 20 ms on a live gateway.
- **Tests:** `security.test.ts` › SR-01, which covers 1 MB adversarial shapes (letters, CJK,
  emoji, punctuation, whitespace, prose) as single messages, 60-message bodies and embedding
  batches.

### SR-02 (High): ReDoS through client JSON-Schema patterns

- **Evidence:** `src/util/json-schema.ts:43` compiled schemas taken from
  `tools[].function.parameters` and `response_format.json_schema.schema` with ajv's default
  `RegExp` engine. It then validated model output against them (opencode tool-call and
  JSON-mode emulation).
- **Exploit:** a tenant sends a tool with
  `{"type":"string","pattern":"^(a+)+$"}`. The prompt steers the model to answer with
  `"aaaa…a!"`.
  - Measured: 27 characters blocked the event loop for 5.8 s.
  - Each extra character doubles the time.
- **Fix:** ajv now uses `guardedRegExp` (`code.regExp`). A pattern is enforced only if
  `isSafePattern` accepts it:
  - no backreferences or lookarounds;
  - star height ≤ 1, meaning no repeated group that contains a repetition or alternation;
  - at most one unbounded (or more than 16) repetition;
  - at most 256 characters.

  Strings longer than 4096 characters are not tested. Other patterns are treated as annotations.
  This is acceptable for an emulation layer: consumers must still validate tool arguments.
  Common patterns are still enforced, such as IDs, dates, fixed-length codes and `^(foo|bar)$`.

- **Tests:** `security.test.ts` › SR-02. The evil pattern on a 40-character input now returns in
  about 20 ms.

### SR-03 (Medium): validator memory growth and shared `$id` registry

- **Evidence:** `src/util/json-schema.ts:47` evicted entries from its own map only. ajv keeps
  every compiled schema in its internal cache and code scope.
  - Measured: 5000 unique schemas left 5002 entries in ajv's internal cache and 26 MB of heap
    growth. A tenant can vary one `description` field to leak memory until an OOM restart.
  - Schemas carrying `$id` were registered globally: a second schema with the same `$id` failed
    to compile, and its validation was silently skipped.
- **Fix:**
  - The cache is bounded by recycling the ajv instances when 500 schemas have accumulated.
  - `addUsedSchema: false` stops registration by `$id`.
  - Measured after the fix: 4.5 MB heap growth over 20 000 schemas.
- **Tests:** `security.test.ts` › SR-03.

### SR-04 (Medium): unbounded `dimensions` causes an OOM crash

- **Evidence:**
  - `src/http/validation.ts:127` accepted any positive `dimensions`.
  - `src/providers/mock.ts:157` and `mock-provider/src/server.ts:302` allocate a
    `new Array(dimensions)` for each input.
- **Exploit:** a key that can call a mock embedding route sends
  `{"dimensions": 2000000000}`. Mock routes ship in the example, compose and kind configs. The
  result is a fatal heap OOM that restarts the whole gateway.
- **Fix:**
  - The API rejects `dimensions` above 16 384 with a 400.
  - The mock adapter and the standalone mock clamp to 8192, the same ceiling as
    `embedding_dim`.
- **Tests:** `security.test.ts` › SR-04, plus a live check on `:8788`, which returned 400.

### SR-05 (Medium): client-controlled ledger idempotency key

- **Evidence:**
  - `src/app.ts:201` honors `x-request-id`.
  - `src/core/pipeline.ts:336` used it as `usage_events.request_id`.
  - `src/usage/writer.ts:71` deduplicates `ON CONFLICT (ts, request_id) DO NOTHING`, where `ts`
    has millisecond precision.
  - `src/usage/reconcile.ts:53` lowers the Redis budget counters to the Postgres totals whenever
    the stream is drained.
- **Impact:**
  - Requests that share an id within the same millisecond keep only one usage row.
  - This happens to concurrent calls from one trace, as DocsQA does when it propagates its
    request id. It also happens deliberately when a tenant sends bursts with a fixed id.
  - The dropped rows disappear from reports and from the authoritative spend. The next
    reconciliation then lowers the live budget counter, so a tenant can under-report its spend
    and stretch a hard budget.
- **Fix:**
  - The client id is still echoed and logged.
  - Usage events get a server-unique id that keeps the client id as a searchable prefix:
    `<client-id>:req_<24 chars>`.
  - Server-generated ids are unchanged.
- **Tests:** `security.test.ts` › SR-05 (20 concurrent requests with one id give 20 distinct
  events). `routing.test.ts` asserts the prefix.

### SR-06 (Medium): opencode tools disabled only by server-side config

- **Evidence:** `src/providers/opencode/index.ts:254` sent only `agent: "gateway"`. Keeping
  opencode's `bash`, `edit`, `write` and `webfetch` tools disabled depended entirely on
  `devenv/opencode/opencode.json`.
- **Exploit:** prompt content is tenant-controlled, including documents injected into RAG
  prompts. On a deployment whose `gateway` agent is missing tool restrictions, a prompt-injected
  request could make the model run shell commands or edit files on the opencode host.
- **Fix:** every prompt now carries `tools: { "*": false, bash: false, edit: false, … }`
  (`OPENCODE_DISABLED_TOOLS`), which opencode merges into the agent's permissions. The gateway
  emulates tool calling itself and never needs opencode tools.
- **Tests:** `opencode.test.ts` › "disables every opencode tool on each prompt".
- **Residual:** the opencode version on this machine (1.18.35) accepts `tools` in its prompt
  schema (`@opencode-ai/sdk` `SessionPromptData`). Run one live smoke test after merging (see §6).

### SR-07 (Medium): unbounded attribution fields

- **Evidence:** `src/app.ts:374` and `src/app.ts:407,411` copied `x-sy-user`, the body `user`
  field (any length, up to the 10 MB body limit) and each tag into every usage event. Those
  events go through Redis `XADD` (MAXLEN 1e6 entries), an in-memory buffer of 10 000 events, and
  Postgres.
- **Exploit:** at 600 rpm a tenant pushes about 6 GB/min into the shared Redis.
  - With `noeviction`, Redis then refuses writes, and rate limits and budgets fail open.
  - When Redis is down, the gateway's memory buffer fills with the same events.
- **Fix:** `end_user` is clipped to 256 characters and each tag to 128.
- **Tests:** `security.test.ts` › SR-07.

### SR-12 (Medium, correctness): cache keys omit response-affecting fields

- **Evidence:** `src/cache/keys.ts:52` hashed a fixed allowlist of fields: messages, tools,
  `tool_choice`, `response_format`, `max_tokens`, `stop`, `top_p`, `reasoning_effort` and
  `seed`.
  - Requests that differed in `logprobs`, `parallel_tool_calls`, `logit_bias`, penalties,
    `metadata` (which drives `mock_script` and `include_reasoning`) or any passthrough field
    shared one cache entry.
  - Clients got responses that did not match what they asked for, for example no logprobs, or
    parallel tool calls after asking for none.
  - The semantic scope (`src/cache/semantic.ts:48`) had the same gap.
- **Fix:**
  - Keys now cover every request field except an explicit ignore list: transport (`stream`,
    `stream_options`), attribution (`user`), `model`, and the normalized fields `max_tokens`,
    `temperature` and `n`. `temperature` and `n` are fixed for every cacheable request.
  - The semantic scope uses the same material.
  - Existing cache entries simply miss once after the upgrade.
- **Tests:** `security.test.ts` › SR-12.

### SR-14 (Medium, accepted): budget overshoot under concurrency

- **Evidence:** `RedisBudgetGuard.check()` reads spend and `record()` adds the actual cost after
  the response. N in-flight requests can all pass with `spent + preflight ≤ limit`.
- **Bound:** the overshoot is at most (in-flight requests of the team) × (cost per request).
  Per-key and per-team RPM/TPM limits and provider concurrency limits cap it.
- **Recommendation:** an atomic reservation (a Lua `INCRBYFLOAT` of the pre-flight cost that the
  actual cost later reconciles, like the TPM reservation). That changes the accounting model, so
  it was left for the next release.

### SR-08, SR-09, SR-10, SR-11, SR-13 (Low): fixed

- **SR-08:** database keys are always `sk-sy-` plus 40 base62 characters (`generateApiKey`).
  Tokens in any other format are rejected after the static-key check, without Redis or Postgres
  and without writing a negative-cache entry. Tests: `platform/keys.test.ts` (the fixtures now
  use well-formed unknown keys, plus a new test).
- **SR-09:** `redactConfig` now redacts:
  - every value under provider `headers`;
  - keys ending in `api-key`, `authorization`, `cookie` or `webhook(_url)` (Slack-style webhook
    URLs embed their secret).

  Test: `security.test.ts` › SR-09.

- **SR-10:**
  - `/readyz?probe=1` now requires the admin token: it fans out to every upstream and returns
    their error strings. `/admin/providers/health` remains available to admins.
  - Plain `/readyz`, which compose and Helm use, is unchanged.
  - `/admin/*` now applies the same `body_limit_mb` as `/v1`.

  Tests: `routing.test.ts` (health), `security.test.ts` › SR-10.

- **SR-11:**
  - `upstream_auth` errors return
    `"<provider>: upstream rejected the gateway's credentials"`.
  - Unexpected errors return `"Internal server error"` instead of, for example,
    `connect ECONNREFUSED 10.0.0.5:6379`.
  - The original messages are logged at `warn` (`request failed`).

  Test: `security.test.ts` › SR-11.

- **SR-13:** the pre-flight completion estimate is multiplied by `n`. Test: `security.test.ts` ›
  SR-13.

### Accepted low and informational items

- **SR-15:** `redis.fail_open: true` is the deliberate default and is documented in
  `config/gateway.example.yaml`:
  - When Redis is down, rate limits and budgets are skipped and the skips are logged.
  - Key verification fails closed with a 503 when Postgres is down.
  - Deployments with paid upstreams should set `fail_open: false`.
- **SR-16:** `/metrics` exposes team slugs, route names and spend. Use `metrics.port`; the Helm
  chart already forces it. The compose stack binds ports to `127.0.0.1`.
- **SR-17:** `requestTimeout = 0`, so long generations are never cut. `headersTimeout` is 60 s.
  Put the gateway behind a reverse proxy or ingress with connection limits and body-read
  timeouts. Every `/v1` and `/admin` request is authenticated before its body is read.
- **SR-18:** one admin token with full rights:
  - It is compared in constant time (hashed, `timingSafeEqual`) and can be rotated with a config
    reload.
  - Prefer `SWITCHYARD_ADMIN_TOKEN` over `--admin-token`.
  - RBAC and scoped admin tokens are a roadmap item.
- **SR-19:** shared caches are opt-in per route (`cache.shared: true`). The semantic scope hash
  includes the full context, so only identical system prompts and earlier turns can match.
- **SR-20:** webhooks are admin-configured and posted with a 5 s timeout and a fixed JSON body
  (no secrets). Restrict egress at the network layer if admins are not fully trusted.
- **SR-21:** user, assistant and tool content is rendered inside `<message>` tags with closing
  tags escaped.
  - Emulated tool calls are validated (name and ajv arguments) and only returned to the client.
    The gateway never executes tools.
  - Consumers must treat tool arguments as untrusted.
- **SR-23:** the advisory affects only the `drizzle-kit` dev dependency.
  `pnpm audit --prod` is clean.

## 4. Areas checked with no finding

- **Key handling:** keys are `sk-sy-` plus 40 base62 characters (about 238 bits) from the
  CSPRNG with rejection sampling.
  - Only SHA-256 hashes are stored (adequate for high-entropy keys) and the plaintext is shown
    once.
  - Revocation and rotation invalidate Redis and every replica (pub/sub), and TTLs bound
    staleness.
  - Expiry is checked on cached records too.
- **Admin authZ:** every `/admin` route sits behind the token middleware. With no admin token
  configured, the admin API is disabled (401), not open.
- **Scope checks:** `allowed_routes` applies to routes, direct models and `/v1/models`. The
  route kind is checked against the endpoint. Semantic-cache embedding uses only routes named in
  the config.
- **SQL:** queries are parameterized through drizzle or `postgres` tagged templates. The only
  `sql.unsafe` call takes a whitelisted group-by expression (`usage/reports.ts:80`). The
  partition DDL uses `format('%I', …)`.
- **Redis key and glob injection:** cache-purge input is validated and glob-escaped, and team
  slugs are regex-validated.
- **SSRF:** no client-controlled URLs reach `fetch`. Upstream base URLs come only from the
  config. The opencode bridge accepts `data:` image URLs only.
- **Header injection and log forging:** `x-request-id` is accepted only if it matches
  `^[A-Za-z0-9._:-]{1,128}$`, and logs are structured JSON. Client headers are not forwarded
  upstream; only the mock reads `x-mock-*`, and only with `allow_header_faults`.
- **Secrets in logs:**
  - pino redacts `authorization`, `api_key`, `password` and `admin_token`.
  - Prompt bodies are not logged by default.
  - The `seed-dev --output` file is written with mode 0600, and stdout is suppressed by the
    working-tree change in `cli/commands.ts`, which is not part of this review's edits.
- **Streams:** client disconnects cancel the upstream iterator and release the snapshot
  reference. The opencode session is always aborted or deleted. Upstream SSE bodies are
  cancelled in `finally`.
- **Containers:** distroless `nonroot` (UID 65532), read-only files, no shell. Compose sets
  `read_only`, `cap_drop: [ALL]` and `no-new-privileges`, and binds ports to `127.0.0.1`. Helm
  sets `runAsNonRoot`, `readOnlyRootFilesystem` and `automountServiceAccountToken: false`, and
  generates the admin token when it is empty.
- **Shipped configs:**
  - `gateway.local.yaml` binds `127.0.0.1` and its `sk-sy-dev-*` defaults are clearly dev-only.
  - `gateway.example.yaml` has no default credentials, and the admin API is disabled when its
    token is empty.

## 5. Verification

| Check                                            | Result                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -r test`                                   | gateway: 323 passed in 22 files (was 300 passed and 1 failed in 21 files); mock-provider: 42 passed in 2 files. **Total: 365 passed**                    |
| `pnpm -r typecheck`, `eslint packages`           | clean                                                                                                                                                    |
| `pnpm build`                                     | OK                                                                                                                                                       |
| `pnpm audit --prod`                              | No known vulnerabilities found                                                                                                                           |
| `pnpm audit` (including dev)                     | 1 moderate: `esbuild` through `drizzle-kit` (SR-23)                                                                                                      |
| Live (source build on `:8788`, mock-only config) | 2 MB single-run chat body: 200 in 20 ms; `/readyz?probe=1`: 401 without the admin token, 200 with it; `dimensions: 2e9`: 400; gateway healthy afterwards |

**Pre-existing failure fixed:** `unit/config.test.ts` still expected `docsqa-judge` to default
to `reasoning_effort: medium`. Commit `08d9ce9` had moved the judge routes to Haiku with a
Sonnet fallback. The test now asserts the shipped targets.

## 6. Follow-ups for the orchestrator (paths owned by other agents)

1. **SR-22 (compose Redis sizing).** Compose Redis runs with `--maxmemory 192mb` and
   `noeviction`, but the usage stream keeps up to `stream_maxlen` (1e6) entries even after they
   are acknowledged. That is about 600–800 bytes each, so roughly 700 MB.
   - **Failure mode:** after about 250k requests Redis refuses writes. Usage events are then
     buffered and dropped, and rate limits and budgets fail open.
   - **Change:** in `config/gateway.compose.yaml`, under `usage:`, add
     `stream_maxlen: 100000   # ~70 MB; Redis here is capped at 192 MB (noeviction)`.
   - Mention the Redis sizing (`stream_maxlen` × ~0.7 KB) in `docs/DEPLOYMENT.md` and in the
     Helm values notes.
2. **README and docs updates for this review:**
   - **README "Ops" row:** change `/readyz` (+ provider probes) to `/readyz` (provider probes
     with `?probe=1` need the admin token).
   - **README `x-request-id` row:** `propagated (generated if absent/unsafe); usage rows store
<id>:<server id>`.
   - **`docs/STATUS.md`:** mention the same two changes and link this file.
3. **CI (`.github/workflows`, being written by another agent while this review ran).** A first
   look at `ci.yml` and `docker.yml` found actions pinned by commit SHA and top-level
   `permissions` blocks. Before merging, confirm:
   - top-level permissions are `contents: read`, with per-job grants only where needed:
     `packages: write` and `id-token: write`/`attestations: write` in the docker job, and
     `id-token: write` for npm provenance;
   - no `pull_request_target`, and no secrets in jobs triggered by fork PRs;
   - `pnpm audit --prod --audit-level high` and gitleaks (with `.gitleaks.toml`) run;
   - tests use Redis db 1 and Postgres `llmgateway_test` service containers;
   - no uploaded artifact contains `.env` files.
4. **Compose demo admin token.** The default `${SWITCHYARD_ADMIN_TOKEN:-sk-sy-demo-admin-token}`
   is acceptable because ports bind to `127.0.0.1`. Keep the "local demo only" comment, and
   never reuse that file for remote hosts.
5. **Live checks after commit:**
   - `pnpm test:live` (about 5 Copilot calls) to confirm opencode accepts the per-prompt `tools`
     map (SR-06).
   - Re-sync `devenv/gateway-stable` (`:8787`), which still runs the pre-fix code.

## 7. Recommendations (next release)

- Atomic budget reservations (SR-14) and a per-key concurrency limit.
- Optional authentication for `/metrics` on the API port, or move it to `metrics.port` by
  default.
- An RE2-backed ajv regex engine (for example the `re2` package) to enforce every pattern
  safely, instead of treating unsafe ones as annotations.
- Scoped or multiple admin tokens with audit-log actor attribution per token.
- Cap the number of embedding inputs per request (OpenAI allows 2048) and rerank document
  sizes, beyond the 10 MB body limit.
- Retries for budget webhooks with an `http(s)`-only scheme check.
