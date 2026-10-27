#!/usr/bin/env bash
# End-to-end proof that the *published* artifact works, without publishing anywhere real:
# throwaway verdaccio registry → `pnpm publish` with a dummy user → install from the registry in
# an empty project → CLI (init / validate-config / serve), openai SDK and library checks.
# Everything lives in a temp dir that is deleted afterwards, and verdaccio is stopped by PID.
#
#   scripts/verdaccio-e2e.sh            (after `pnpm build`)
#   VERDACCIO_PORT=48731 VERDACCIO_VERSION=7.0.2 OPENAI_SDK=7.45.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${VERDACCIO_PORT:-48731}"
VERSION="${VERDACCIO_VERSION:-7.0.2}"
REGISTRY="http://127.0.0.1:$PORT/"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/switchyard-verdaccio.XXXXXX")"
VPID=""
cleanup() {
  local code=$?
  if [ -n "$VPID" ]; then kill "$VPID" 2>/dev/null || true; wait "$VPID" 2>/dev/null || true; fi
  if [ "$code" -ne 0 ] && [ -f "$TMP/verdaccio.log" ]; then
    echo "--- verdaccio log (tail)" >&2
    tail -n 40 "$TMP/verdaccio.log" >&2
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

if ss -ltn "sport = :$PORT" | grep -q LISTEN; then echo "port $PORT is busy" >&2; exit 1; fi
[ -f "$ROOT/packages/gateway/dist/cli.js" ] || { echo "run pnpm build first" >&2; exit 1; }

cat >"$TMP/config.yaml" <<YAML
storage: $TMP/storage
auth:
  htpasswd:
    file: $TMP/htpasswd
    max_users: 10
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    timeout: 60s
    max_fails: 10
    fail_timeout: 10s
packages:
  'switchyard-gateway':
    access: \$all
    publish: \$authenticated
  '**':
    access: \$all
    publish: \$authenticated
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
YAML

echo "▶ verdaccio@$VERSION on $REGISTRY (storage $TMP/storage)"
npm install --prefix "$TMP/verdaccio" --no-audit --no-fund --loglevel=error "verdaccio@$VERSION"
# Start the bin with node directly (not via npx) so $! is verdaccio itself and `kill` stops it.
node "$TMP/verdaccio/node_modules/verdaccio/bin/verdaccio" --config "$TMP/config.yaml" \
  --listen "127.0.0.1:$PORT" >"$TMP/verdaccio.log" 2>&1 &
VPID=$!
for _ in $(seq 1 120); do
  curl -fsS "${REGISTRY}-/ping" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "${REGISTRY}-/ping" >/dev/null

echo "▶ dummy user"
TOKEN="$(curl -fsS -X PUT "${REGISTRY}-/user/org.couchdb.user:smoke" \
  -H 'content-type: application/json' \
  -d '{"name":"smoke","password":"smoke-local-only","email":"smoke@example.invalid"}' |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')"
NPMRC="$TMP/npmrc"
printf '//127.0.0.1:%s/:_authToken=%s\n' "$PORT" "$TOKEN" >"$NPMRC"

echo "▶ pnpm publish → $REGISTRY"
(
  cd "$ROOT/packages/gateway"
  # provenance needs a CI OIDC token; this is a local registry
  NPM_CONFIG_USERCONFIG="$NPMRC" npm_config_userconfig="$NPMRC" \
    pnpm publish --registry "$REGISTRY" --no-git-checks --no-provenance 2>&1 | tail -n 25
)
echo "▶ registry metadata"
curl -fsS "${REGISTRY}switchyard-gateway" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const m = JSON.parse(s); const v = m["dist-tags"].latest; const d = m.versions[v];
    console.log(`  ${m.name}@${v}  bin=${JSON.stringify(d.bin)}  files=${d.dist.fileCount ?? "?"}  unpacked=${d.dist.unpackedSize ?? "?"}  shasum=${d.dist.shasum}`);
    const ws = JSON.stringify(d).includes("workspace:");
    if (ws) throw new Error("published manifest still contains workspace: ranges");
    console.log("  no workspace: ranges in the published manifest");
  });'

echo "▶ install from the registry and exercise it"
NPM_CONFIG_USERCONFIG="$NPMRC" OPENAI_SDK="${OPENAI_SDK:-7.45.0}" \
  "$ROOT/scripts/pack-smoke.sh" "switchyard-gateway@$(node -p "require('$ROOT/packages/gateway/package.json').version")" \
  --registry "$REGISTRY"
echo "✔ verdaccio end-to-end passed (registry stopped and $TMP removed on exit)"
