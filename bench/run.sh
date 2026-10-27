#!/usr/bin/env bash
# Switchyard benchmark: k6 against the gateway in front of a 0 ms mock provider, compared with
# calling the mock directly. Writes one JSON summary per run to bench/results/.
#
#   pnpm build && bench/run.sh            (needs k6 on PATH or K6=/path/to/k6)
#
# Modes: direct (k6 → mock), off (gateway, platform off), on (gateway + Postgres keys, Redis
# limits/budgets/cache/usage stream). "on" uses Redis db 1 (prefix sybench:) and a throwaway
# database llmgateway_bench that is dropped at the end.
#
# CPU budget: the gateway is pinned to one core (GW_CPU), the mock provider and k6 share another
# (LOAD_CPU), so a run uses at most two cores.
#
# Env: RATE=200 DURATION=15s VUS=32 MAX_DURATION=10s GW_CPU=2 LOAD_CPU=3 MODES="direct off on"
#      PG_ADMIN_URL=postgres://dev:dev@localhost:5432/postgres  BENCH_DB=llmgateway_bench
#      PG_TEMPLATE=template1  REDIS_URL_ON=redis://localhost:6379/1
#      OUT_DIR=bench/results
#      PROFILE_DIR=/tmp/prof → run the gateways under `node --cpu-prof` (one .cpuprofile per
#                              mode; summarize with `node bench/profile-top.mjs <file>`)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH="$ROOT/bench"
K6="${K6:-k6}"
CLI="$ROOT/packages/gateway/dist/cli.js"
RATE="${RATE:-200}"
DURATION="${DURATION:-15s}"
VUS="${VUS:-32}"
MAX_DURATION="${MAX_DURATION:-10s}"
GW_CPU="${GW_CPU:-2}"
LOAD_CPU="${LOAD_CPU:-3}"
MODES="${MODES:-direct off on}"
MOCK_PORT="${MOCK_PORT:-18790}"
OFF_PORT="${OFF_PORT:-18788}"
ON_PORT="${ON_PORT:-18789}"
PG_ADMIN_URL="${PG_ADMIN_URL:-postgres://dev:dev@localhost:5432/postgres}"
BENCH_DB="${BENCH_DB:-llmgateway_bench}"
PG_TEMPLATE="${PG_TEMPLATE:-template1}"
REDIS_URL_ON="${REDIS_URL_ON:-redis://localhost:6379/1}"
DATABASE_URL_ON="${PG_ADMIN_URL%/*}/$BENCH_DB"
OUT="${OUT_DIR:-$BENCH/results}"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/switchyard-bench.XXXXXX")"

MOCK_PID=""
GW_PIDS=()
GW_PID_OFF=""
GW_PID_ON=""
DB_CREATED=""
cleanup() {
  local code=$?
  for pid in "${GW_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  [ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; }
  if [ -n "$DB_CREATED" ]; then
    psql "$PG_ADMIN_URL" -qAtc "DROP DATABASE IF EXISTS $BENCH_DB WITH (FORCE)" >/dev/null || true
    redis-cli -u "$REDIS_URL_ON" --scan --pattern 'sybench:*' | xargs -r -n 500 redis-cli -u "$REDIS_URL_ON" DEL >/dev/null || true
  fi
  if [ "$code" -ne 0 ]; then
    for f in "$LOGS"/*.log; do [ -f "$f" ] && { echo "--- $f" >&2; tail -n 20 "$f" >&2; }; done
  fi
  rm -rf "$LOGS"
}
trap cleanup EXIT

busy() { ss -ltn "sport = :$1" | grep -q LISTEN; }
wait_http() { # url pid
  for _ in $(seq 1 100); do
    curl -fsS -o /dev/null "$1" 2>/dev/null && return 0
    kill -0 "$2" 2>/dev/null || { echo "process for $1 exited" >&2; return 1; }
    sleep 0.1
  done
  echo "timeout waiting for $1" >&2
  return 1
}

command -v "$K6" >/dev/null || { echo "k6 not found (set K6=/path/to/k6)" >&2; exit 1; }
[ -f "$CLI" ] || { echo "run pnpm build first" >&2; exit 1; }
for p in "$MOCK_PORT" "$OFF_PORT" "$ON_PORT"; do busy "$p" && { echo "port $p is busy" >&2; exit 1; }; done
mkdir -p "$OUT"
rm -f "$OUT/gateway-cpu.txt"

{
  echo "date: $(date -Is)"
  echo "host: $(uname -srm)"
  echo "cpu: $(lscpu | sed -n 's/^Model name:[[:space:]]*//p') ($(nproc) logical CPUs)"
  echo "memory: $(free -m | awk '/^Mem:/ {print $2 " MiB"}')"
  echo "node: $(node --version)  k6: $("$K6" version | head -n1)"
  echo "redis: $(redis-cli -u "$REDIS_URL_ON" INFO server | sed -n 's/^redis_version:\(.*\)\r$/\1/p')  postgres: $(psql "$PG_ADMIN_URL" -qAtc 'show server_version')"
  echo "gateway: $(node "$CLI" --version) pinned to CPU $GW_CPU; mock + k6 pinned to CPU $LOAD_CPU"
  echo "rate runs: $RATE req/s for $DURATION; max-throughput runs: $VUS VUs for $MAX_DURATION"
  echo "gateway logs: level info, written to /dev/null"
  echo "clock ticks per second (for gateway-cpu.txt): $(getconf CLK_TCK)"
  echo "load average at start: $(cut -d' ' -f1-3 /proc/loadavg)"
} | tee "$OUT/environment.txt"

echo "▶ mock provider :$MOCK_PORT (0 ms latency)"
taskset -c "$LOAD_CPU" node "$CLI" mock-provider --port "$MOCK_PORT" >"$LOGS/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 100); do curl -fsS -o /dev/null "http://127.0.0.1:$MOCK_PORT/v1/models" 2>/dev/null && break; sleep 0.1; done
MOCK_URL="http://127.0.0.1:$MOCK_PORT/v1"

k6run() { # name base key model scenario executor
  local name=$1 base=$2 key=$3 model=$4 scenario=$5 executor=$6
  echo "  · $name"
  taskset -c "$LOAD_CPU" env K6_NO_USAGE_REPORT=true "$K6" run --quiet --no-color \
    -e BASE_URL="$base" -e KEY="$key" -e MODEL="$model" -e SCENARIO="$scenario" \
    -e EXECUTOR="$executor" -e RATE="$RATE" -e VUS="$VUS" \
    -e DURATION="$([ "$executor" = vus ] && echo "$MAX_DURATION" || echo "$DURATION")" \
    -e OUT="$OUT/$name.json" "$BENCH/k6/gateway.js" >"$LOGS/k6-$name.log" 2>&1 ||
    { cat "$LOGS/k6-$name.log" >&2; return 1; }
}

start_gateway() { # mode port config
  local mode=$1 port=$2 config=$3
  echo "▶ gateway ($mode) :$port"
  env NODE_ENV=production PORT="$port" MOCK_URL="$MOCK_URL" LOG_LEVEL=info \
    taskset -c "$GW_CPU" node ${PROFILE_DIR:+--cpu-prof --cpu-prof-dir="$PROFILE_DIR" --cpu-prof-name="gateway-$mode.cpuprofile"} "$CLI" serve --config "$config" >/dev/null 2>"$LOGS/gateway-$mode.log" &
  GW_PIDS+=("$!")
  printf -v "GW_PID_${mode^^}" '%s' "$!"
  wait_http "http://127.0.0.1:$port/healthz" "$!"
}

# CPU time (user + system, in clock ticks) a process has used so far.
cpu_ticks() { awk '{print $14 + $15}' "/proc/$1/stat"; }
measured() { # pid name base key model scenario executor
  local pid=$1 name=$2
  shift
  local before after
  before=$(cpu_ticks "$pid")
  k6run "$@"
  after=$(cpu_ticks "$pid")
  echo "$name $((after - before))" >>"$OUT/gateway-cpu.txt"
}

want() { [[ " $MODES " == *" $1 "* ]]; }
BASE_OFF="http://127.0.0.1:$OFF_PORT/v1"
BASE_ON="http://127.0.0.1:$ON_PORT/v1"
KEY_OFF=sk-sy-bench-static
KEY_ON=""

if want on; then
  echo "▶ database $BENCH_DB (template $PG_TEMPLATE), Redis $REDIS_URL_ON prefix sybench:"
  psql "$PG_ADMIN_URL" -qAtc "CREATE DATABASE $BENCH_DB TEMPLATE $PG_TEMPLATE" >/dev/null
  DB_CREATED=1
  export DATABASE_URL="$DATABASE_URL_ON" REDIS_URL="$REDIS_URL_ON"
  node "$CLI" migrate --config "$BENCH/config/gateway.on.yaml" >"$LOGS/migrate.log" 2>&1
  node "$CLI" teams create bench --monthly-budget 1000000 --rpm 10000000 --tpm 1000000000 \
    --config "$BENCH/config/gateway.on.yaml" >/dev/null
  KEY_ON="$(node "$CLI" keys create --team bench --name k6 --json \
    --config "$BENCH/config/gateway.on.yaml" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).key))')"
  start_gateway on "$ON_PORT" "$BENCH/config/gateway.on.yaml"
  unset DATABASE_URL REDIS_URL
fi
want off && start_gateway off "$OFF_PORT" "$BENCH/config/gateway.off.yaml"

# Warm-up (JIT, connection pools, key caches); results discarded.
echo "▶ warm-up"
for mode in $MODES; do
  case "$mode" in
    direct) RATE=100 DURATION=10s k6run warmup-direct "$MOCK_URL" none mock-echo chat rate ;;
    off) RATE=100 DURATION=10s k6run warmup-off "$BASE_OFF" "$KEY_OFF" chat chat rate ;;
    on) RATE=100 DURATION=10s k6run warmup-on "$BASE_ON" "$KEY_ON" chat chat rate ;;
  esac
  rm -f "$OUT/warmup-$mode.json"
done

# Scenarios run back to back for every target (direct → off → on), so background load on the
# machine drifts as little as possible between the numbers that get subtracted.
scenario() { # suffix scenario executor direct-name direct-model
  local suffix=$1 sc=$2 ex=$3 dname=${4:-} dmodel=${5:-}
  echo "▶ $suffix"
  if want direct && [ -n "$dname" ]; then k6run "$dname" "$MOCK_URL" none "$dmodel" "$sc" "$ex"; fi
  local model=chat
  [ "$sc" = embed ] && model=embed
  if want off; then measured "$GW_PID_OFF" "off-$suffix" "$BASE_OFF" "$KEY_OFF" "$model" "$sc" "$ex"; fi
  if want on; then measured "$GW_PID_ON" "on-$suffix" "$BASE_ON" "$KEY_ON" "$model" "$sc" "$ex"; fi
  return 0
}
scenario chat-miss chat rate direct-chat mock-echo
scenario chat-stream stream rate direct-chat-stream mock-echo
scenario chat-hit hit rate
scenario embed embed rate direct-embed mock-embed
scenario healthz health rate
scenario max-chat-miss chat vus direct-max-chat mock-echo
scenario max-chat-hit hit vus

if want on; then
  sleep 2 # let the in-process writer flush
  echo "  usage rows written by the platform-on gateway: $(psql "$DATABASE_URL_ON" -qAtc 'select count(*) from usage_events' 2>/dev/null || echo '?')"
fi
for pid in "${GW_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
GW_PIDS=()

echo "load average at end: $(cut -d' ' -f1-3 /proc/loadavg)" | tee -a "$OUT/environment.txt"
node "$BENCH/report.mjs" "$OUT" | tee "$OUT/summary.md"
echo "✔ results in $OUT (processes stopped, bench database dropped, sybench:* keys removed)"
