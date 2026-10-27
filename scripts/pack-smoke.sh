#!/usr/bin/env bash
# Installs a packed switchyard-gateway tarball (or a registry spec) into an empty temp project and
# exercises it like a user would: CLI version, init, validate-config, serve + HTTP calls, library
# import. Used by CI (Node 22 and 24) and for local release checks.
#
#   scripts/pack-smoke.sh <path/to/switchyard-gateway-x.y.z.tgz | switchyard-gateway@x.y.z> [npm install args…]
#   PORT (default 18797) is where the smoke gateway listens.
#   OPENAI_SDK=<version> also installs the official `openai` package and runs chat, streaming
#   (checks usage.cost) and embeddings through it.
set -euo pipefail

SPEC="${1:?usage: pack-smoke.sh <tarball|package spec> [npm install args…]}"
shift
[ -f "$SPEC" ] && SPEC="$(cd "$(dirname "$SPEC")" && pwd)/$(basename "$SPEC")"
PORT="${PORT:-18797}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/switchyard-smoke.XXXXXX")"
PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

cd "$WORK"
echo "▶ node $(node --version), npm $(npm --version), workdir $WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "$SPEC" "$@"

echo "▶ switchyard --version"
npx --no-install switchyard --version

echo "▶ switchyard init"
npx --no-install switchyard init >/dev/null
ls gateway.yaml .env.example

echo "▶ switchyard validate-config"
npx --no-install switchyard validate-config

echo "▶ switchyard serve (:$PORT)"
if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then echo "port $PORT is busy" >&2; exit 1; fi
# Run the bin directly (not via npx) so $! is the server itself and `kill` stops it.
PORT="$PORT" ./node_modules/.bin/switchyard serve >serve.log 2>&1 &
PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  kill -0 "$PID" 2>/dev/null || { cat serve.log; echo "serve exited" >&2; exit 1; }
  sleep 0.2
done
AUTH='authorization: Bearer sk-sy-local-change-me'
curl -fsS "http://127.0.0.1:$PORT/v1/chat/completions" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"model":"chat","messages":[{"role":"user","content":"smoke test"}]}' | tee chat.json
echo
grep -q '"content":"smoke test"' chat.json
grep -q '"cost":' chat.json
curl -fsS "http://127.0.0.1:$PORT/v1/embeddings" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"model":"embed","input":["a","b"]}' | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const r = JSON.parse(s);
      if (r.data.length !== 2) throw new Error("expected 2 embeddings");
      console.log(`embeddings: ${r.data.length} × ${r.data[0].embedding.length}`);
    });'
if [ -n "${OPENAI_SDK:-}" ]; then
  echo "▶ official openai SDK ${OPENAI_SDK}"
  npm install --no-audit --no-fund --loglevel=error "openai@${OPENAI_SDK}" "$@"
  cat >sdk.mjs <<JS
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://127.0.0.1:${PORT}/v1', apiKey: 'sk-sy-local-change-me' });
const chat = await client.chat.completions.create({
  model: 'chat',
  messages: [{ role: 'user', content: 'hello from the openai sdk' }],
});
console.log('sdk chat:', JSON.stringify(chat.choices[0].message.content), 'usage', JSON.stringify(chat.usage));
const stream = await client.chat.completions.create({
  model: 'chat',
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'streamed through the gateway' }],
});
let text = '';
let usage;
for await (const chunk of stream) {
  text += chunk.choices[0]?.delta?.content ?? '';
  if (chunk.usage) usage = chunk.usage;
}
if (text !== 'streamed through the gateway' || typeof usage?.cost !== 'number') throw new Error('stream');
console.log('sdk stream:', JSON.stringify(text), 'final usage', JSON.stringify(usage));
const emb = await client.embeddings.create({ model: 'embed', input: ['alpha', 'beta'] });
console.log('sdk embeddings:', emb.data.length, 'x', emb.data[0].embedding.length);
JS
  node sdk.mjs
fi
kill "$PID"
wait "$PID" 2>/dev/null || true
PID=""

echo "▶ library import"
cat >lib.mjs <<'EOF'
import { createGateway, loadConfig } from 'switchyard-gateway';
import { startMockServer } from 'switchyard-gateway/mock-provider';
import schema from 'switchyard-gateway/config.schema.json' with { type: 'json' };

const gateway = createGateway({ config: loadConfig('gateway.yaml', { env: {} }) });
const res = await gateway.fetch(
  new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-sy-local-change-me', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'library' }] }),
  }),
);
const body = await res.json();
if (body.choices[0].message.content !== 'library') throw new Error(JSON.stringify(body));
await gateway.close();
console.log(`library: ${res.status} ${body.choices[0].message.content}, cost ${body.usage.cost}`);
console.log(`exports: startMockServer=${typeof startMockServer}, schema title "${schema.title}"`);
EOF
node lib.mjs
echo "✔ smoke test passed"
