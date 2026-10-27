#!/usr/bin/env bash
# Switchyard over plain HTTP: rerank, cache controls, attribution headers and the error envelope.
# Needs curl and jq. With SWITCHYARD_ADMIN_TOKEN set (a gateway with Redis and Postgres), it also
# creates two throwaway teams through the admin API to show a budget block (402) and a rate
# limit (429), then deletes them.
set -euo pipefail

BASE="${SWITCHYARD_BASE_URL:-http://127.0.0.1:8787/v1}"
ROOT="${BASE%/v1}"
KEY="${SWITCHYARD_API_KEY:-sk-sy-examples-local}"
ADMIN="${SWITCHYARD_ADMIN_TOKEN:-}"
NONCE="$(date +%s%N)"
HDR="$(mktemp)"
trap 'rm -f "$HDR"' EXIT

fail() {
  echo "✖ $*" >&2
  exit 1
}
# post <path> <json> [extra curl args…] → body on stdout, headers in $HDR, status in $STATUS
post() {
  local path="$1" body="$2"
  shift 2
  local out
  out="$(curl -sS -D "$HDR" -w '\n%{http_code}' "$BASE$path" -H 'content-type: application/json' "$@" -d "$body")"
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
header() { grep -i "^$1:" "$HDR" | head -1 | cut -d' ' -f2- | tr -d '\r'; }
chat() { printf '{"model":"%s","messages":[{"role":"user","content":"%s"}]}' "$1" "$2"; }
auth=(-H "authorization: Bearer $KEY")

# 1. Rerank (Cohere/Jina shape).
post /rerank '{"model":"rerank","query":"how is cost tracked?","documents":["Grafana dashboards","every request is priced and the cost is in usage.cost","Helm chart"],"top_n":2,"return_documents":true}' "${auth[@]}"
[[ "$STATUS" == 200 ]] || fail "rerank: HTTP $STATUS $BODY"
top="$(jq -r '.results[0].index' <<<"$BODY")"
[[ "$top" == 1 ]] || fail "rerank: expected document 1 first, got $top"
echo "✔ rerank: top document #$top ($(jq -c '[.results[] | {index, relevance_score}]' <<<"$BODY"))"

# 2. Cache controls. The chat route has an exact cache; repeat a request, then bypass / refresh.
prompt="cache demo $NONCE"
post /chat/completions "$(chat chat "$prompt")" "${auth[@]}"
c1="$(header x-sy-cache)"
post /chat/completions "$(chat chat "$prompt")" "${auth[@]}"
c2="$(header x-sy-cache)" saved="$(header x-sy-saved-usd)"
post /chat/completions "$(chat chat "$prompt")" "${auth[@]}" -H 'x-sy-cache: bypass'
c3="$(header x-sy-cache)"
post /chat/completions "$(chat chat "$prompt")" "${auth[@]}" -H 'x-sy-cache: refresh'
c4="$(header x-sy-cache)"
[[ "$c1 $c2 $c3 $c4" == "miss hit bypass miss" ]] || fail "cache: got '$c1 $c2 $c3 $c4'"
echo "✔ cache: first=$c1, repeat=$c2 (saved \$$saved), x-sy-cache:bypass → $c3, x-sy-cache:refresh → $c4 (re-stored)"

# 3. Attribution: x-sy-user and x-sy-tags are stored with the usage event of the request.
post /chat/completions "$(chat chat "attribution $NONCE")" "${auth[@]}" \
  -H 'x-sy-user: curl-example-user' -H 'x-sy-tags: app:examples,sdk:curl'
[[ "$STATUS" == 200 ]] || fail "attribution: HTTP $STATUS"
echo "✔ attribution: x-sy-user=curl-example-user x-sy-tags=app:examples,sdk:curl (request $(header x-request-id))"

# 4. Errors use the OpenAI envelope {"error":{"message","type","code","param"}}.
expect_error() { # <label> <status> <code>
  [[ "$STATUS" == "$2" ]] || fail "$1: expected HTTP $2, got $STATUS $BODY"
  local code
  code="$(jq -r '.error.code' <<<"$BODY")"
  [[ "$code" == "$3" ]] || fail "$1: expected code $3, got $code"
  echo "✔ error $1: $STATUS $code — $(jq -r '.error.message' <<<"$BODY")"
}
post /chat/completions "$(chat chat hi)" -H 'authorization: Bearer sk-sy-not-a-real-key'
expect_error "invalid key" 401 invalid_api_key
post /chat/completions "$(chat no-such-route hi)" "${auth[@]}"
expect_error "unknown model" 404 model_not_found
post /chat/completions '{"model":"chat","messages":[]}' "${auth[@]}"
expect_error "invalid body" 400 invalid_request

# 5. Budgets (402) and rate limits (429) need the platform layer (Redis + Postgres).
if [[ -z "$ADMIN" ]]; then
  echo "• 402/429 skipped: set SWITCHYARD_ADMIN_TOKEN against a gateway with Redis and Postgres"
  echo "curl: all checks passed"
  exit 0
fi
admin() { # <method> <path> [json]
  curl -sS -X "$1" "$ROOT/admin$2" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' ${3:+-d "$3"}
}
broke="ex-budget-${NONCE: -8}" busy="ex-rpm-${NONCE: -8}"
cleanup_teams() { admin DELETE "/teams/$broke" >/dev/null || true; admin DELETE "/teams/$busy" >/dev/null || true; }
trap 'cleanup_teams; rm -f "$HDR"' EXIT

admin POST /teams "{\"slug\":\"$broke\",\"budgets\":{\"monthly\":{\"limit_usd\":0.000001}}}" >/dev/null
broke_key="$(admin POST "/teams/$broke/keys" '{"name":"example"}' | jq -r .key)"
post /chat/completions "$(chat chat "budget $NONCE")" -H "authorization: Bearer $broke_key"
expect_error "budget" 402 budget_exceeded

admin POST /teams "{\"slug\":\"$busy\"}" >/dev/null
busy_key="$(admin POST "/teams/$busy/keys" '{"name":"example","rpm_limit":2}' | jq -r .key)"
for i in 1 2; do
  post /chat/completions "$(chat chat "rpm $i $NONCE")" -H "authorization: Bearer $busy_key"
  [[ "$STATUS" == 200 ]] || fail "rate limit: request $i got HTTP $STATUS"
done
post /chat/completions "$(chat chat "rpm 3 $NONCE")" -H "authorization: Bearer $busy_key"
expect_error "rate limit" 429 rate_limit_exceeded
echo "  retry-after=$(header retry-after)s x-ratelimit-limit-requests=$(header x-ratelimit-limit-requests) x-ratelimit-remaining-requests=$(header x-ratelimit-remaining-requests)"

echo "curl: all checks passed"
