# Benchmark results

How much latency and CPU does Switchyard add on top of the upstream call? The upstream here is
the bundled mock provider with **0 ms latency**, reached over HTTP. The baseline is k6 calling
that mock directly, so `gateway − direct` is the gateway's own cost: HTTP in and out, auth,
validation, token estimation, limits, budgets, cache, the extra upstream hop, accounting and
logging.

**Summary (0.1.0, final run, one gateway core, 200 req/s):**

| Target (SPEC §15)               | Platform off (memory)                     | Platform on (Postgres keys, Redis limits/budgets/cache/usage) |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Cache miss: < 3 ms p50 overhead | **met:** +2.26 ms (pre-fix run: +2.34 ms) | **missed:** +3.41 ms (pre-fix run: +3.18 ms)                  |
| Cache hit: < 1 ms p50 overhead  | **met:** +0.48 ms (pre-fix run: +0.42 ms) | **missed:** +1.72 ms (pre-fix run: +1.12 ms)                  |

Throughput on one core, closed loop: cache misses at about **1,200–1,500 req/s** with the
platform off and **650–980 req/s** with it on; cache hits at about **3,000–3,600 req/s** off and
**2,000–2,150 req/s** on. The ranges span the two cleanest full runs. The direct mock serves
about 4,200 req/s on the same setup.

These numbers come from a shared laptop with other heavy workloads running (load average 4–8
during the runs reported here; runs at 10–16 were discarded). Treat differences under about
0.5 ms p50, and every p95/p99, as noise. Re-run `make bench` on a quiet machine before quoting
them elsewhere.

## Setup

| Item            | Value                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Machine         | Laptop, 11th Gen Intel Core i5-1135G7 @ 2.40 GHz (4 cores / 8 threads), 15 GB RAM, Linux 7.0 (Ubuntu 26.04)                          |
| Software        | Node.js 24.20.0, k6 2.3.0, Redis 8.0.5, Postgres 18.6 (all local)                                                                    |
| CPU budget      | Gateway pinned to CPU 2 (`taskset`); mock provider and k6 share CPU 3, so at most 2 cores                                            |
| Upstream        | `switchyard mock-provider`, 0 ms latency, OpenAI-compatible over HTTP (`mock-echo` chat, `mock-embed` 256-d)                         |
| Gateway         | `dist/cli.js serve`, `NODE_ENV=production`, log level `info` to `/dev/null`                                                          |
| Requests        | Chat: one ~60-token user message, echoed back, so ~60 completion tokens. Embeddings: 2 inputs. Unique content per request for misses |
| Latency runs    | k6 `constant-arrival-rate`, 200 req/s for 15 s per scenario and target (about 3,000 requests each), after a 10 s warm-up             |
| Throughput runs | k6 `constant-vus`, 32 VUs for 10 s                                                                                                   |

Configs: [config/gateway.off.yaml](config/gateway.off.yaml) and
[config/gateway.on.yaml](config/gateway.on.yaml).

- **Platform on** uses a Postgres virtual key (cached in process and in Redis), and runs per
  request:
  - key and team RPM/TPM in one Lua call;
  - a hard team budget, with the pre-flight check and the post-response increment;
  - the Redis exact cache;
  - usage events to a Redis Stream, with the in-process writer batching them into Postgres.
- Limits and budgets are set high enough never to reject, but every check runs. The final run
  wrote 39,740 usage rows.

Commands:

```bash
pnpm build
K6=/path/to/k6 bench/run.sh                                     # all scenarios → bench/results/
PROFILE_DIR=/tmp/prof bench/run.sh && node bench/profile-top.mjs /tmp/prof/gateway-on.cpuprofile
bench/ab.sh <dist-A>/cli.js <dist-B>/cli.js                     # interleaved A/B of two builds
```

## Final run (post-fix build)

Raw data: [results/](results/) (`*.json` are the k6 summaries; `environment.txt` holds hardware,
versions and load average). Run on 2026-10-27 at 14:20; load average 5.2 at the start and 4.1
at the end.

### Latency at 200 req/s (ms)

| Scenario                 | Target             |  p50 |   p95 |   p99 | Overhead p50 | Overhead p95 | Overhead p99 |
| ------------------------ | ------------------ | ---: | ----: | ----: | -----------: | -----------: | -----------: |
| Chat, cache miss         | direct mock        | 0.34 |  0.74 |  2.88 |              |              |              |
|                          | gateway, plat. off | 2.60 |  5.62 | 17.10 |        +2.26 |        +4.88 |       +14.22 |
|                          | gateway, plat. on  | 3.76 | 12.31 | 49.97 |        +3.41 |       +11.57 |       +47.09 |
| Streaming, TTFB (≈ TTFT) | direct mock        | 0.35 |  0.77 |  3.30 |              |              |              |
|                          | gateway, plat. off | 4.44 | 15.24 | 32.16 |        +4.08 |       +14.47 |       +28.85 |
|                          | gateway, plat. on  | 3.57 | 12.62 | 28.37 |        +3.21 |       +11.85 |       +25.07 |
| Streaming, total         | direct mock        | 0.42 |  0.99 |  3.66 |              |              |              |
|                          | gateway, plat. off | 4.67 | 15.62 | 32.27 |        +4.25 |       +14.62 |       +28.60 |
|                          | gateway, plat. on  | 3.65 | 12.92 | 28.46 |        +3.23 |       +11.92 |       +24.79 |
| Exact-cache hit          | direct mock\*      | 0.34 |  0.74 |  2.88 |              |              |              |
|                          | gateway, plat. off | 0.83 |  3.44 | 19.21 |        +0.48 |        +2.70 |       +16.33 |
|                          | gateway, plat. on  | 2.06 | 10.85 | 23.34 |        +1.72 |       +10.11 |       +20.45 |
| Embeddings (2 inputs)    | direct mock        | 0.30 |  0.55 |  1.75 |              |              |              |
|                          | gateway, plat. off | 2.84 |  6.41 | 11.73 |        +2.55 |        +5.86 |        +9.98 |
|                          | gateway, plat. on  | 4.72 | 26.19 | 90.90 |        +4.42 |       +25.63 |       +89.15 |
| `GET /healthz`           | gateway, plat. off | 0.28 |  1.06 |  3.77 |              |              |              |
|                          | gateway, plat. on  | 0.30 |  1.28 |  3.78 |              |              |              |

\* A cache hit never calls the upstream, so its "overhead" is measured against a full direct
upstream call. Against `GET /healthz` (the bare HTTP round trip to the gateway), a hit adds
0.55 ms with the platform off and 1.76 ms with it on.

**Streaming TTFT:** k6 has no SSE client, so TTFT is approximated by time to first byte. The
gateway flushes headers together with the first chunk, and the mock emits the whole stream at
once, so TTFB ≈ TTFT ≈ total here. The streaming rows of this run are inconsistent: platform off
is slower than platform on, the reverse of every other scenario and of the pre-fix run (+2.68
off / +3.10 on). That is a sign of background noise during those 30 s.

### Throughput, closed loop (32 VUs, one gateway core)

| Scenario         | Target                | req/s | p50 ms | p99 ms |
| ---------------- | --------------------- | ----: | -----: | -----: |
| Chat, cache miss | direct mock           | 4,198 |   6.72 |  21.89 |
|                  | gateway, platform off | 1,243 |  21.94 |  65.81 |
|                  | gateway, platform on  |   651 |  45.06 | 140.27 |
| Exact-cache hit  | gateway, platform off | 3,630 |   7.55 |  21.63 |
|                  | gateway, platform on  | 2,017 |  13.31 |  37.70 |

Every run had 100 % successful checks: status 200, `[DONE]` on streams, and `x-sy-cache: hit` on
the hit runs.

## Pre-fix run

Raw data: [results/pre-fix/](results/pre-fix/). Run on 2026-10-27 at 13:56, with the build before
the profiling fixes and the earlier version of `run.sh`, which ran the targets one after another
rather than interleaved. Load average 7.8 at the start and 3.6 at the end.

| p50 overhead (ms) / throughput | Platform off | Platform on |
| ------------------------------ | -----------: | ----------: |
| Chat miss                      |        +2.34 |       +3.18 |
| Streaming TTFB                 |        +2.68 |       +3.10 |
| Exact-cache hit                |        +0.42 |       +1.12 |
| Embeddings                     |        +2.40 |       +4.29 |
| Max req/s, miss                |        1,497 |         980 |
| Max req/s, hit                 |        3,009 |       2,149 |

## Profiling and fixes

The platform-on targets were missed, so the gateway was profiled once with `node --cpu-prof`
(`PROFILE_DIR=/tmp/prof bench/run.sh` with short runs). Self time as a share of the gateway's
busy CPU:

| Hot spot                                              | Platform off | Platform on |
| ----------------------------------------------------- | -----------: | ----------: |
| Log writes (pino → sonic-boom `fs.write`)             |         21 % |         6 % |
| `fetch` to the upstream (undici)                      |         12 % |         9 % |
| Token estimation (js-tiktoken, pre-flight TPM/budget) |          9 % |         8 % |
| Garbage collection                                    |          8 % |        11 % |
| ioredis (commands, pipelines, parsing)                |            – |         9 % |
| zlib (cache values ≥ 512 B)                           |            – |         2 % |
| Hono, `@hono/node-server`, zod                        |        < 3 % |       < 3 % |

The logging share with the platform off came from two `info` lines per request. The in-memory
`LogUsageSink` logged the whole usage event, next to the `request completed` line that already
carries the same fields.

Small fixes applied:

1. **`LogUsageSink` logs at `debug`.** With the platform off, there is now one `info` line per
   request instead of two (`src/usage/sinks.ts`).
2. **Budget check concurrent with the rate-limit check.** Both are reads, so it saves one Redis
   round trip before dispatch. A rate-limit rejection still wins, and the TPM reservation is
   still released when the budget rejects (`Pipeline.admit`).
3. **TPM reconciliation and budget increment in parallel** after the response. That saves one
   Redis round trip before a non-streamed response is returned (`Pipeline.account`).

All 341 gateway tests pass with the changes.

### Re-measured: interleaved A/B

Two full-suite re-runs after the fixes landed during heavy background load (load average
10–16). Their numbers swung by 3× in both directions, so they were discarded.
[`bench/ab.sh`](ab.sh) then ran the pre-fix build (A) and the fixed build (B) side by side,
interleaved A B B A per scenario at 200 req/s. That puts background load on both sides equally.
Raw data: [results/ab/](results/ab/). Load average was about 5 at the start and 10 at the end.

| Platform | Scenario        | Build | p50 ms | p95 ms | Gateway CPU ms/req |
| -------- | --------------- | ----- | -----: | -----: | -----------------: |
| off      | chat miss       | A     |   2.52 |   5.02 |               1.38 |
| off      | chat miss       | B     |   2.52 |   5.61 |               1.39 |
| off      | exact-cache hit | A     |   0.85 |   1.73 |               0.91 |
| off      | exact-cache hit | B     |   0.79 |   1.72 |               0.79 |
| off      | embeddings      | A     |   7.46 |  24.08 |               2.33 |
| off      | embeddings      | B     |   8.23 |  46.88 |               2.33 |
| on       | chat miss       | A     |  60.44 | 206.65 |               3.34 |
| on       | chat miss       | B     |  20.22 | 111.90 |               3.22 |
| on       | exact-cache hit | A     |   6.70 |  48.00 |               2.47 |
| on       | exact-cache hit | B     |   9.69 |  59.62 |               2.59 |
| on       | embeddings      | A     |  38.74 | 156.72 |               3.27 |
| on       | embeddings      | B     |   9.20 |  59.33 |               2.56 |

**Verdict: the fixes did not measurably move the targets.**

- **CPU per request:** unchanged on platform-off misses (1.38 vs 1.39 ms). It is about 13 %
  lower on platform-off hits, within noise on platform-on misses and hits, and lower on
  platform-on embeddings.
- **Why the logging fix didn't help:** sonic-boom coalesces log lines that arrive while a write
  is in flight. Halving the number of lines therefore mostly reduced bytes, not write calls.
- **Platform-on latencies** in this run are dominated by machine load: tens of milliseconds even
  on hits. They say nothing about the round trips saved.

The fixes stay in, because they are correct and cheap. The honest result for the platform-on
path is **about 3.2–3.4 ms p50 overhead on a miss and 1.1–1.7 ms on a hit**, above the SPEC
targets.

> CPU ms/req at 200 req/s is higher than at saturation (the off-mode miss path costs about
> 0.8–0.9 ms/req at 1,100–1,250 req/s). Per-request wakeups, epoll and timers are not amortized at low
> rates, and the sibling hyperthread was busy with other work. Compare CPU numbers only within
> one run.

## Where the remaining time goes

- **Platform on, per request:**
  - Auth comes from the in-process key cache.
  - Then three sequential Redis round trips: rate limit plus budget (now concurrent), the cache
    lookup, and reconciliation plus budget increment (now parallel).
  - Usage `XADD` is pipelined and off the critical path.
  - On this loaded machine a loopback Redis round trip costs about 0.3–0.5 ms at p50, which
    accounts for most of the gap to platform off.
  - Further reductions would change semantics, for example not awaiting the post-response
    writes, or merging the rate-limit and budget checks into one Lua script. Both are roadmap
    candidates, not quick fixes.
- **Both modes:**
  - Token estimation is deliberate: exact o200k counts for TPM and budget pre-flight, bounded
    for safety (SR-01).
  - undici `fetch` is the cost of the second HTTP hop to the upstream.
  - A gateway that forwards to a real upstream pays this hop by definition. With real LLM
    latencies of 200 ms to several seconds, 2–4 ms of overhead is below 2 %.

## Caveats

- **Shared laptop, not an isolated benchmark host.** Other heavy workloads (builds, browsers,
  containers) were running throughout. CPU pinning keeps the gateway on its own logical core,
  but sibling hyperthreads, memory pressure (swap was in use) and frequency scaling still leak
  in. Load averages are recorded in every `environment.txt`.
- **Short runs:** 15 s at 200 req/s gives about 3,000 samples per cell. p99 values rest on about
  30 samples.
- **Scope:** the mock answers instantly and identically, and real upstreams don't. These
  numbers are gateway overhead, not end-to-end latency.
- **Shared core:** k6 and the mock share one core, so the direct baseline also competes with the
  load generator. The gateway path adds a cross-core hop on top of that, and that hop is part of
  the measured overhead.
