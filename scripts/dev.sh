#!/usr/bin/env bash
# Runs the gateway locally against the devenv services (opencode :4096, llama.cpp :8081-8083).
# Usage: scripts/dev.sh [extra serve args]   (env: DEVENV_ENV, SWITCHYARD_CONFIG, PORT)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${DEVENV_ENV:-$ROOT/../devenv/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
else
  echo "warning: $ENV_FILE not found; opencode credentials must come from the environment" >&2
fi
if [ -f "$ROOT/.env" ]; then set -a; source "$ROOT/.env"; set +a; fi
CONFIG="${SWITCHYARD_CONFIG:-$ROOT/config/gateway.local.yaml}"
cd "$ROOT/packages/gateway"
if [ -f dist/cli.js ] && [ "${SWITCHYARD_DEV_SOURCE:-0}" != "1" ]; then
  exec node dist/cli.js serve --config "$CONFIG" "$@"
fi
exec node --import tsx src/cli.ts serve --config "$CONFIG" "$@"
