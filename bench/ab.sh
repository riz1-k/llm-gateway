#!/usr/bin/env bash
# A/B comparison of two gateway builds under identical load, interleaved so that background load
# on the machine affects both sides equally. Used to verify the profiling fixes in RESULTS.md.
#
#   bench/ab.sh <cli-A.js> <cli-B.js>        (each a built packages/gateway/dist*/cli.js)
#
# For platform off and on, and for chat miss, chat hit and embeddings at RATE req/s, it runs
# A, B, B, A (ABBA order cancels linear drift) and reports the medians of both runs per side,
# plus gateway CPU ms per request. Same env vars as run.sh (RATE, DURATION, GW_CPU, LOAD_CPU,
# PG_ADMIN_URL, BENCH_DB, PG_TEMPLATE, REDIS_URL_ON, OUT_DIR default bench/results/ab).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH="$ROOT/bench"
CLI_A="$(realpath "${1:?usage: ab.sh <cli-A.js> <cli-B.js>}")"
CLI_B="$(realpath "${2:?usage: ab.sh <cli-A.js> <cli-B.js>}")"
K6="${K6:-k6}"
RATE="${RATE:-200}"
DURATION="${DURATION:-15s}"
GW_CPU="${GW_CPU:-2}"
LOAD_CPU="${LOAD_CPU:-3}"
MOCK_PORT="${MOCK_PORT:-18790}"
PG_ADMIN_URL="${PG_ADMIN_URL:-postgres://dev:dev@localhost:5432/postgres}"
BENCH_DB="${BENCH_DB:-llmgateway_bench}"
PG_TEMPLATE="${PG_TEMPLATE:-template1}"
REDIS_URL_ON="${REDIS_URL_ON:-redis://localhost:6379/1}"
DATABASE_URL_ON="${PG_ADMIN_URL%/*}/$BENCH_DB"
OUT="${OUT_DIR:-$BENCH/results/ab}"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/switchyard-ab.XXXXXX")"
PIDS=()
DB_CREATED=""
cleanup() {
  local code=$?
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  if [ -n "$DB_CREATED" ]; then
    psql "$PG_ADMIN_URL" -qAtc "DROP DATABASE IF EXISTS $BENCH_DB WITH (FORCE)" >/dev/null || true
    redis-cli -u "$REDIS_URL_ON" --scan --pattern 'sybench:*' | xargs -r -n 500 redis-cli -u "$REDIS_URL_ON" DEL >/dev/null || true
  fi
  [ "$code" -ne 0 ] && for f in "$LOGS"/*.log; do [ -f "$f" ] && { echo "--- $f" >&2; tail -n 20 "$f" >&2; }; done
  rm -rf "$LOGS"
}
trap cleanup EXIT
for p in "$MOCK_PORT" 18791 18792 18793 18794; do
  if ss -ltn "sport = :$p" | grep -q LISTEN; then echo "port $p is busy" >&2; exit 1; fi
done
mkdir -p "$OUT"
rm -f "$OUT"/*.json "$OUT/gateway-cpu.txt"
{
  echo "date: $(date -Is)"
  echo "A: $CLI_A"
  echo "B: $CLI_B"
  echo "rate runs: $RATE req/s for $DURATION, order A B B A per scenario"
  echo "clock ticks per second (for gateway-cpu.txt): $(getconf CLK_TCK)"
  echo "load average at start: $(cut -d' ' -f1-3 /proc/loadavg)"
} | tee "$OUT/environment.txt"

taskset -c "$LOAD_CPU" node "$CLI_B" mock-provider --port "$MOCK_PORT" >"$LOGS/mock.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 100); do curl -fsS -o /dev/null "http://127.0.0.1:$MOCK_PORT/v1/models" 2>/dev/null && break; sleep 0.1; done
MOCK_URL="http://127.0.0.1:$MOCK_PORT/v1"

psql "$PG_ADMIN_URL" -qAtc "CREATE DATABASE $BENCH_DB TEMPLATE $PG_TEMPLATE" >/dev/null
DB_CREATED=1
CFG_ON="$BENCH/config/gateway.on.yaml"
DATABASE_URL="$DATABASE_URL_ON" REDIS_URL="$REDIS_URL_ON" node "$CLI_B" migrate --config "$CFG_ON" >"$LOGS/migrate.log" 2>&1
DATABASE_URL="$DATABASE_URL_ON" REDIS_URL="$REDIS_URL_ON" node "$CLI_B" teams create bench \
  --monthly-budget 1000000 --rpm 10000000 --tpm 1000000000 --config "$CFG_ON" >/dev/null
KEY_ON="$(DATABASE_URL="$DATABASE_URL_ON" REDIS_URL="$REDIS_URL_ON" node "$CLI_B" keys create \
  --team bench --name k6 --json --config "$CFG_ON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).key))')"

declare -A PID_OF PORT_OF KEY_OF
start() { # label cli config port key
  env NODE_ENV=production PORT="$4" MOCK_URL="$MOCK_URL" LOG_LEVEL=info \
    DATABASE_URL="$DATABASE_URL_ON" REDIS_URL="$REDIS_URL_ON" \
    taskset -c "$GW_CPU" node "$2" serve --config "$3" >/dev/null 2>"$LOGS/gw-$1.log" &
  PIDS+=("$!")
  PID_OF[$1]=$!
  PORT_OF[$1]=$4
  KEY_OF[$1]=$5
  for _ in $(seq 1 100); do curl -fsS -o /dev/null "http://127.0.0.1:$4/healthz" 2>/dev/null && return 0; sleep 0.1; done
  echo "gateway $1 did not start" >&2
  return 1
}
start off-A "$CLI_A" "$BENCH/config/gateway.off.yaml" 18791 sk-sy-bench-static
start off-B "$CLI_B" "$BENCH/config/gateway.off.yaml" 18792 sk-sy-bench-static
start on-A "$CLI_A" "$CFG_ON" 18793 "$KEY_ON"
start on-B "$CLI_B" "$CFG_ON" 18794 "$KEY_ON"

run() { # label scenario model duration name
  local label=$1 sc=$2 model=$3 dur=$4 name=$5 before after
  before=$(awk '{print $14 + $15}' "/proc/${PID_OF[$label]}/stat")
  taskset -c "$LOAD_CPU" env K6_NO_USAGE_REPORT=true "$K6" run --quiet --no-color \
    -e BASE_URL="http://127.0.0.1:${PORT_OF[$label]}/v1" -e KEY="${KEY_OF[$label]}" \
    -e MODEL="$model" -e SCENARIO="$sc" -e EXECUTOR=rate -e RATE="$RATE" -e DURATION="$dur" \
    -e OUT="$OUT/$name.json" "$BENCH/k6/gateway.js" >"$LOGS/k6-$name.log" 2>&1 ||
    { cat "$LOGS/k6-$name.log" >&2; return 1; }
  after=$(awk '{print $14 + $15}' "/proc/${PID_OF[$label]}/stat")
  echo "$name $((after - before))" >>"$OUT/gateway-cpu.txt"
}

echo "▶ warm-up"
for label in off-A off-B on-A on-B; do run "$label" chat chat 10s "warmup-$label"; done
rm -f "$OUT"/warmup-*.json
sed -i '/^warmup-/d' "$OUT/gateway-cpu.txt"

for mode in off on; do
  for sc in chat hit embed; do
    model=chat
    [ "$sc" = embed ] && model=embed
    echo "▶ $mode $sc"
    run "$mode-A" "$sc" "$model" "$DURATION" "$mode-$sc-A1"
    run "$mode-B" "$sc" "$model" "$DURATION" "$mode-$sc-B1"
    run "$mode-B" "$sc" "$model" "$DURATION" "$mode-$sc-B2"
    run "$mode-A" "$sc" "$model" "$DURATION" "$mode-$sc-A2"
  done
done
echo "load average at end: $(cut -d' ' -f1-3 /proc/loadavg)" | tee -a "$OUT/environment.txt"

node - "$OUT" <<'JS' | tee "$OUT/summary.md"
const { readFileSync } = require('node:fs');
const dir = process.argv[2];
const env = readFileSync(`${dir}/environment.txt`, 'utf8');
const hz = Number(env.match(/clock ticks per second[^:]*: (\d+)/)[1]);
const cpu = Object.fromEntries(
  readFileSync(`${dir}/gateway-cpu.txt`, 'utf8').trim().split('\n').map((l) => l.split(' ')),
);
const load = (n) => JSON.parse(readFileSync(`${dir}/${n}.json`, 'utf8'));
const avg = (a, b) => (a + b) / 2;
const f = (n) => n.toFixed(2);
console.log('| platform | scenario | build | p50 ms | p95 ms | p99 ms | gateway CPU ms/req |');
console.log('| --- | --- | --- | ---: | ---: | ---: | ---: |');
for (const mode of ['off', 'on'])
  for (const sc of ['chat', 'hit', 'embed'])
    for (const side of ['A', 'B']) {
      const [r1, r2] = [1, 2].map((i) => load(`${mode}-${sc}-${side}${i}`));
      const d = (k) => avg(r1.duration_ms[k], r2.duration_ms[k]);
      const c =
        ((Number(cpu[`${mode}-${sc}-${side}1`]) + Number(cpu[`${mode}-${sc}-${side}2`])) * 1000) /
        hz /
        (r1.requests.count + r2.requests.count);
      const label = { chat: 'chat miss', hit: 'exact-cache hit', embed: 'embeddings' }[sc];
      console.log(`| ${mode} | ${label} | ${side} | ${f(d('med'))} | ${f(d('p(95)'))} | ${f(d('p(99)'))} | ${f(c)} |`);
    }
JS
echo "✔ A/B results in $OUT"
