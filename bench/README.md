# Benchmarks

k6 load tests of the gateway in front of a mock upstream that answers instantly (0 ms), compared
with calling that mock directly. The difference is the gateway's own overhead. Results,
hardware and analysis: [RESULTS.md](RESULTS.md). Raw k6 summaries: [results/](results/).

```bash
pnpm build
bench/run.sh                    # k6 on PATH, or K6=/path/to/k6
```

| File                      | What                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.sh`                  | Starts the mock and the gateways, runs every scenario, writes `results/*.json`, cleans up                                                         |
| `k6/gateway.js`           | The k6 script (scenario, executor and target from env vars)                                                                                       |
| `config/gateway.off.yaml` | Platform **off**: static key, in-memory exact cache, no Redis or Postgres                                                                         |
| `config/gateway.on.yaml`  | Platform **on**: Postgres virtual key, Redis RPM/TPM limits (key + team), hard budget, Redis exact cache, usage stream with the in-process writer |
| `report.mjs`              | Turns `results/*.json` into the Markdown tables in `results/summary.md`                                                                           |
| `ab.sh`                   | A/B of two builds (`ab.sh <cli-A.js> <cli-B.js>`), interleaved A B B A, used to verify the profiling fixes                                        |
| `profile-top.mjs`         | Summarizes a `.cpuprofile` (from `PROFILE_DIR=… bench/run.sh`) by self time per module and function                                               |

What `run.sh` does:

- Starts `switchyard mock-provider` with 0 ms latency. The gateway reaches it over HTTP through an
  `openai-compatible` provider, exactly like the direct baseline does, so both paths have the
  same upstream hop.
- Pins the gateway to one CPU (`GW_CPU`, default 2), and the mock plus k6 to another (`LOAD_CPU`,
  default 3). A run uses at most two cores.
- Runs at a constant arrival rate (`RATE` = 200 req/s for `DURATION` = 15 s) to measure latency
  percentiles. Each request has unique content, so a "miss" is a real cache miss, and the hit
  scenario repeats one warmed-up prompt.
- Runs closed-loop (`VUS` = 32 for `MAX_DURATION` = 10 s) to measure maximum throughput on one
  gateway core.
- For platform **on**: creates a throwaway database (`BENCH_DB`, default `llmgateway_bench`),
  runs the migrations, and creates a team (high limits and budget) and a key through the CLI. It
  uses Redis db 1 with the prefix `sybench:`. Everything is removed at the end.
- Starts every target first, then runs each scenario against direct → off → on back to back.
  Background load on a shared machine then drifts as little as possible between the numbers
  that are subtracted.
- Records the gateway process's CPU time (user + system, from `/proc/<pid>/stat`) around every
  run, which gives **gateway CPU ms per request**. This is less sensitive to scheduling noise
  than latency.
- Warms each target up for 10 s first and discards the results.
- Stops every process it started, on success and on failure.

Override anything through the environment variables documented at the top of `run.sh`, for
example `MODES="direct off"` to skip the platform runs, or `PG_ADMIN_URL=…` and
`REDIS_URL_ON=…` for other servers.
