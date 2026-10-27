#!/usr/bin/env bash
# Runs every example against a throwaway mock provider + gateway, checks the output, tears down.
#
#   examples/run-all.sh                      # platform off: no Redis, no Postgres
#   examples/run-all.sh --platform           # + Redis db 1 and Postgres llmgateway_test (402/429)
#   examples/run-all.sh --runtime bun        # gateway, mock and TS examples on Bun (or deno)
#   examples/run-all.sh --only curl,openai-node
#
# Needs: a built gateway (pnpm build), Node >= 22.18, npm, curl, jq, uv (Python examples), and
# redis-cli with --platform.
# Ports are picked from EXAMPLES_PORTS (default 18700-18799). Exits non-zero on any failure.
# No real provider is ever called: the config routes everything to the mock.
set -uo pipefail

EX="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$EX/.." && pwd)"
CLI="$ROOT/packages/gateway/dist/cli.js"
CONFIG="$EX/config/gateway.examples.yaml"
ALL=(openai-node openai-python vercel-ai-sdk langchain-python langchain-js curl library-hono)

PLATFORM=0
RUNTIME="${EXAMPLES_RUNTIME:-node}"
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM=1 ;;
    --runtime) RUNTIME="$2"; shift ;;
    --runtime=*) RUNTIME="${1#*=}" ;;
    --only) ONLY="$2"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
if [[ -n "$ONLY" ]]; then IFS=',' read -r -a SELECTED <<<"$ONLY"; else SELECTED=("${ALL[@]}"); fi

if [[ -t 1 ]]; then say() { printf '\033[1m%s\033[0m\n' "$*"; }; else say() { printf '%s\n' "$*"; }; fi
die() { echo "✖ $*" >&2; exit 1; }

# --- prerequisites ---------------------------------------------------------------------------
[[ -f "$CLI" ]] || die "gateway not built: run 'pnpm install && pnpm build' first"
for tool in node npm curl jq; do command -v "$tool" >/dev/null || die "$tool is required"; done
[[ "$PLATFORM" == 0 ]] || command -v redis-cli >/dev/null || die "--platform needs redis-cli (apt install redis-tools)"
case "$RUNTIME" in
  node) RUN_JS=(node) ;;
  bun) RUN_JS=(bun) ;;
  deno) RUN_JS=(deno run -A) ;;
  *) die "--runtime must be node, bun or deno" ;;
esac
command -v "${RUN_JS[0]}" >/dev/null || die "$RUNTIME not found"
node -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null ||
  die "Node $(node --version) cannot run .ts files; use Node >= 22.18"
runtime_version() {
  case "$RUNTIME" in
    node) node --version ;;
    bun) echo "bun $(bun --version)" ;;
    deno) deno --version | head -1 ;;
  esac
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/switchyard-examples.XXXXXX")"
PIDS=()
REDIS_PREFIX=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  local pid
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do
    for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
  done
  if [[ -n "$REDIS_PREFIX" ]]; then
    redis-cli -u "$EXAMPLES_REDIS_URL" --scan --pattern "${REDIS_PREFIX}*" |
      xargs -r redis-cli -u "$EXAMPLES_REDIS_URL" unlink >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# First free port in EXAMPLES_PORTS that is not in the arguments.
free_port() {
  node -e '
    const net = require("node:net");
    const [lo, hi] = (process.env.EXAMPLES_PORTS || "18700-18799").split("-").map(Number);
    const taken = new Set(process.argv.slice(1).map(Number));
    const tryPort = (p) => {
      if (p > hi) { console.error("no free port"); process.exit(1); }
      if (taken.has(p)) return tryPort(p + 1);
      const s = net.createServer().once("error", () => tryPort(p + 1));
      s.listen(p, "127.0.0.1", () => s.close(() => console.log(p)));
    };
    tryPort(lo);' "$@"
}
wait_http() { # <url> <pid> <log>
  for _ in $(seq 150); do
    curl -sf -o /dev/null "$1" && return 0
    kill -0 "$2" 2>/dev/null || { cat "$3" >&2; die "process for $1 exited"; }
    sleep 0.2
  done
  cat "$3" >&2
  die "timed out waiting for $1"
}

# --- dependencies ----------------------------------------------------------------------------
wants() { [[ " ${SELECTED[*]} " == *" $1 "* ]]; }
npm_install() { # <dir>: npm ci when the lockfile changed (or node_modules is missing)
  local dir="$EX/$1"
  if [[ -f "$dir/package-lock.json" ]]; then
    if [[ ! -f "$dir/node_modules/.package-lock.json" || "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]]; then
      (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error) || die "npm ci failed in $1"
    fi
  else
    (cd "$dir" && npm install --no-audit --no-fund --loglevel=error >/dev/null) || die "npm install failed in $1"
  fi
}
say "Installing example dependencies"
for js in openai-node vercel-ai-sdk langchain-js; do wants "$js" && npm_install "$js"; done
if wants library-hono; then
  # The library example installs switchyard-gateway from a tarball of this checkout (like npm i).
  mkdir -p "$EX/.pack"
  (cd "$ROOT/packages/gateway" && pnpm pack --pack-destination "$EX/.pack" >/dev/null) || die "pnpm pack failed"
  rm -rf "$EX/library-hono/node_modules/switchyard-gateway"
  npm_install library-hono
fi
if wants openai-python || wants langchain-python; then
  command -v uv >/dev/null || die "uv is required for the Python examples (https://docs.astral.sh/uv/)"
fi

# --- mock provider + gateway -----------------------------------------------------------------
MOCK_PORT="$(free_port)"
GW_PORT="$(free_port "$MOCK_PORT")"
LIB_PORT="$(free_port "$MOCK_PORT" "$GW_PORT")"
export SWITCHYARD_API_KEY="sk-sy-examples-$RANDOM$RANDOM"
export SWITCHYARD_BASE_URL="http://127.0.0.1:$GW_PORT/v1"
unset SWITCHYARD_ADMIN_TOKEN

if [[ "$PLATFORM" == 1 ]]; then
  export EXAMPLES_REDIS_URL="${EXAMPLES_REDIS_URL:-redis://127.0.0.1:6379/1}"
  export EXAMPLES_DATABASE_URL="${EXAMPLES_DATABASE_URL:-postgres://dev:dev@127.0.0.1:5432/llmgateway_test}"
  [[ "$EXAMPLES_REDIS_URL" =~ /[1-9][0-9]*$ ]] || die "EXAMPLES_REDIS_URL must name a Redis db other than 0"
  REDIS_PREFIX="sy:examples:$RANDOM$RANDOM:"
  export EXAMPLES_REDIS_PREFIX="$REDIS_PREFIX"
  SWITCHYARD_ADMIN_TOKEN="sk-sy-admin-$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"
  export SWITCHYARD_ADMIN_TOKEN
  say "Platform on: Redis ${EXAMPLES_REDIS_URL} (prefix $REDIS_PREFIX), Postgres ${EXAMPLES_DATABASE_URL##*@}"
  (cd "$ROOT" && "${RUN_JS[@]}" "$CLI" migrate --config "$CONFIG") >"$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log"; die "migrate failed"; }
else
  say "Platform off: in-memory keys and cache, no Redis or Postgres (402/429 checks need --platform)"
fi

say "Starting the mock provider (:$MOCK_PORT) and the gateway (:$GW_PORT) on $(runtime_version)"
(cd "$ROOT" && exec "${RUN_JS[@]}" "$CLI" mock-provider --port "$MOCK_PORT") >"$WORK/mock.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$MOCK_PORT/health" "${PIDS[-1]}" "$WORK/mock.log"
(cd "$ROOT" && PORT="$GW_PORT" MOCK_URL="http://127.0.0.1:$MOCK_PORT" LOG_LEVEL=debug \
  exec "${RUN_JS[@]}" "$CLI" serve --config "$CONFIG") >"$WORK/gateway.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$GW_PORT/readyz" "${PIDS[-1]}" "$WORK/gateway.log"
echo "   mock:    $(ps -o args= -p "${PIDS[0]}" 2>/dev/null | sed "s#$ROOT/##g")"
echo "   gateway: $(ps -o args= -p "${PIDS[1]}" 2>/dev/null | sed "s#$ROOT/##g")"

# --- examples --------------------------------------------------------------------------------
library_smoke() {
  (cd "$EX/library-hono" && PORT="$LIB_PORT" exec "${RUN_JS[@]}" server.ts) >"$WORK/library.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  wait_http "http://127.0.0.1:$LIB_PORT/healthz" "$pid" "$WORK/library.log"
  head -1 "$WORK/library.log"
  local u="http://127.0.0.1:$LIB_PORT" body
  body="$(curl -sS "$u/")"
  [[ "$body" == "my service"* ]] || { echo "check failed: app route: $body"; return 1; }
  echo "✔ app route: GET / → \"$body\""
  body="$(curl -sS "$u/llm/v1/chat/completions" -H 'authorization: Bearer sk-sy-example-library' \
    -H 'content-type: application/json' -H 'x-sy-user: alice' -H 'x-sy-tags: feature:demo' \
    -d '{"model":"chat","messages":[{"role":"user","content":"hello from the embedded gateway"}]}')"
  [[ "$(jq -r '.choices[0].message.content' <<<"$body")" == "hello from the embedded gateway" ]] ||
    { echo "check failed: mounted gateway: $body"; return 1; }
  echo "✔ mounted gateway: POST /llm/v1/chat/completions → \"$(jq -r '.choices[0].message.content' <<<"$body")\" cost=\$$(jq -r '.usage.cost' <<<"$body")"
  body="$(curl -sS "$u/llm/v1/models" -H 'authorization: Bearer sk-sy-example-library')"
  echo "✔ models: $(jq -c '[.data[].id]' <<<"$body")"
  body="$(curl -sS "$u/usage/by-user")"
  [[ "$(jq -r '.alice.requests' <<<"$body")" == 1 ]] || { echo "check failed: usage sink: $body"; return 1; }
  echo "✔ custom UsageSink: GET /usage/by-user → $(jq -c . <<<"$body")"
  code="$(curl -s -o /dev/null -w '%{http_code}' "$u/llm/v1/chat/completions" -H 'content-type: application/json' -d '{}')"
  [[ "$code" == 401 ]] || { echo "check failed: expected 401, got $code"; return 1; }
  echo "✔ auth: no key → 401"
  echo "library-hono: all checks passed"
}

run_example() {
  case "$1" in
    openai-node | vercel-ai-sdk | langchain-js) (cd "$EX/$1" && "${RUN_JS[@]}" index.ts) ;;
    openai-python | langchain-python) (cd "$EX/$1" && uv run --quiet --script main.py) ;;
    curl) "$EX/curl/run.sh" ;;
    library-hono) library_smoke ;;
    *) echo "unknown example: $1"; return 2 ;;
  esac
}

declare -A RESULT TIME
FAILED=0
for name in "${SELECTED[@]}"; do
  say "── $name"
  start=$(date +%s%N)
  run_example "$name" >"$WORK/$name.out" 2>&1
  status=$?
  TIME[$name]=$(( ($(date +%s%N) - start) / 1000000 ))
  sed 's/^/   /' "$WORK/$name.out"
  if [[ $status == 0 ]] && grep -q "^$name: all checks passed$" "$WORK/$name.out"; then
    RESULT[$name]=PASS
  else
    RESULT[$name]="FAIL (exit $status)"
    FAILED=1
  fi
done

# Attribution: the x-sy-user / x-sy-tags headers sent by the examples must be in usage events.
say "── attribution (usage events)"
if [[ "$PLATFORM" == 1 ]]; then
  redis-cli -u "$EXAMPLES_REDIS_URL" xrange "${REDIS_PREFIX}usage" - + >"$WORK/usage.txt" 2>&1
  source_name="Redis stream ${REDIS_PREFIX}usage"
else
  grep '"msg":"usage"' "$WORK/gateway.log" >"$WORK/usage.txt"
  source_name="gateway log (usage sink)"
fi
for pair in curl:sdk:curl langchain-python:sdk:langchain-python vercel-ai-sdk:sdk:vercel-ai langchain-js:sdk:langchain-js; do
  name="${pair%%:*}" tag="${pair#*:}"
  wants "$name" || continue
  n="$(grep -c "$tag" "$WORK/usage.txt")"
  if [[ "$n" -gt 0 ]]; then
    echo "   ✔ $tag: $n usage event(s) with tag $tag in the $source_name"
  else
    echo "   ✖ $tag: no usage event with tag $tag in the $source_name"
    RESULT[attribution]=FAIL
    FAILED=1
  fi
done
[[ -n "${RESULT[attribution]:-}" ]] || RESULT[attribution]=PASS

# The gateway must not have logged an internal error.
if grep -q '"level":"\(error\|fatal\)"' "$WORK/gateway.log"; then
  echo "   ✖ the gateway logged errors:"
  grep '"level":"\(error\|fatal\)"' "$WORK/gateway.log" | head -5 | cut -c1-300
  RESULT[gateway-log]=FAIL
  FAILED=1
fi

say "Summary ($(runtime_version), platform $([[ $PLATFORM == 1 ]] && echo on || echo off))"
for name in "${SELECTED[@]}"; do printf '  %-18s %-16s %6s ms\n' "$name" "${RESULT[$name]}" "${TIME[$name]}"; done
printf '  %-18s %s\n' attribution "${RESULT[attribution]}"
[[ -n "${RESULT[gateway-log]:-}" ]] && printf '  %-18s %s\n' gateway-log "${RESULT[gateway-log]}"
if [[ $FAILED == 0 ]]; then say "All examples passed"; else say "FAILED"; fi
exit $FAILED
