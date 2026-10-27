#!/usr/bin/env bash
# Runs the gateway from this checkout with config/gateway.local.yaml (opencode :4096, llama.cpp
# :8081-8083) or any config via SWITCHYARD_CONFIG.
# Usage: scripts/dev.sh [extra serve args]
# Env:   SWITCHYARD_ENV_FILE (default ./.env, gitignored; e.g. OPENCODE_SERVER_PASSWORD),
#        SWITCHYARD_CONFIG, PORT
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${SWITCHYARD_ENV_FILE:-$ROOT/.env}"
case "$ENV_FILE" in /*) ;; *) ENV_FILE="$ROOT/$ENV_FILE" ;; esac
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
elif [ -n "${SWITCHYARD_ENV_FILE:-}" ]; then
  echo "warning: $ENV_FILE not found; credentials must come from the environment" >&2
fi
CONFIG="${SWITCHYARD_CONFIG:-$ROOT/config/gateway.local.yaml}"
cd "$ROOT/packages/gateway"
if [ -f dist/cli.js ] && [ "${SWITCHYARD_DEV_SOURCE:-0}" != "1" ]; then
  exec node dist/cli.js serve --config "$CONFIG" "$@"
fi
exec node --import tsx src/cli.ts serve --config "$CONFIG" "$@"
