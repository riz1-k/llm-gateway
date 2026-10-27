#!/usr/bin/env bash
# Provision the portfolio teams, budgets and DB-backed virtual keys on a running Switchyard
# (admin API) and write each key into the consuming project's gitignored .env. Idempotent:
#
#   * teams docsqa ($50/month), opsagent ($50), evals ($100): created if missing; the monthly budget
#     (soft 0.8, action block) is reset to these values if it drifted. Daily budgets are untouched.
#   * one key per (team, name): a key already present in a target .env is kept when its prefix
#     matches an *active* key of that name and the gateway accepts it; otherwise a new key is issued
#     (the plaintext is shown once, so it goes straight into the .env file, never to stdout) and
#     stale active keys of the same name that no .env references any more are revoked.
#
# Usage:  scripts/seed-portfolio.sh [--check] [docsqa] [opsagent]        (default: both consumers)
#   --check   report drift only, change nothing (exit 1 if anything would change)
# Env:    SWITCHYARD_URL          default http://127.0.0.1:8787
#         SWITCHYARD_ADMIN_TOKEN  default sk-sy-dev-admin (the local dev placeholder token)
#         PORTFOLIO_ROOT          default: the directory that contains this repo
#         DOCSQA_ENV_FILE         default $PORTFOLIO_ROOT/docsqa/.env
#         OPSAGENT_ENV_FILE       default $PORTFOLIO_ROOT/opsagent/agent/.env
#
# Static config keys (sk-sy-dev-docsqa / -opsagent / -evals) keep working for CI and compose; they
# are attributed to the same teams (see docs/ADMIN.md §2).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
G="${SWITCHYARD_URL:-http://127.0.0.1:8787}"
TOKEN="${SWITCHYARD_ADMIN_TOKEN:-sk-sy-dev-admin}"
PORTFOLIO_ROOT="${PORTFOLIO_ROOT:-$(dirname "$ROOT")}"
DOCSQA_ENV_FILE="${DOCSQA_ENV_FILE:-$PORTFOLIO_ROOT/docsqa/.env}"
OPSAGENT_ENV_FILE="${OPSAGENT_ENV_FILE:-$PORTFOLIO_ROOT/opsagent/agent/.env}"

CHECK=0
SELECTED=()
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    docsqa | opsagent) SELECTED+=("$a") ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
[ ${#SELECTED[@]} -gt 0 ] || SELECTED=(docsqa opsagent)

command -v jq >/dev/null || { echo "seed-portfolio: jq is required" >&2; exit 2; }

# slug | display name | monthly budget USD
TEAMS=(
  "docsqa|DocsQA|50"
  "opsagent|OpsAgent|50"
  "evals|Evals|100"
)
SOFT=0.8
ACTION=block

# consumer | team | key name | allowed routes (JSON array, filtered to existing routes; null = all) | env file | variable
KEYS=(
  "docsqa|docsqa|portfolio-docsqa|[\"docsqa-chat\",\"docsqa-fast\",\"docsqa-judge\",\"docsqa-embed\",\"docsqa-rerank\",\"mock-chat\",\"mock-embed\",\"mock-rerank\",\"mock-tools\"]|$DOCSQA_ENV_FILE|LLM_API_KEY"
  "docsqa|evals|portfolio-evals|null|$DOCSQA_ENV_FILE|EVAL_JUDGE_API_KEY"
  "opsagent|opsagent|portfolio-opsagent|[\"opsagent-chat\",\"opsagent-judge\",\"opsagent-scripted\",\"mock-chat\",\"mock-embed\",\"mock-rerank\",\"mock-tools\"]|$OPSAGENT_ENV_FILE|LLM_API_KEY"
  "opsagent|evals|portfolio-evals|null|$OPSAGENT_ENV_FILE|EVAL_LLM_API_KEY"
)

DRIFT=0
log() { printf '%-10s %s\n' "$1" "$2"; }
selected() { local c; for c in "${SELECTED[@]}"; do [ "$c" = "$1" ] && return 0; done; return 1; }

# api METHOD PATH [JSON] -> body on stdout, HTTP status in $STATUS (file-based: subshell-safe)
STATUS_FILE="$(mktemp)"
trap 'rm -f "$STATUS_FILE"' EXIT
api() {
  local method="$1" path="$2" data="${3:-}" out
  printf 000 >"$STATUS_FILE"
  local args=(-sS -X "$method" -H "Authorization: Bearer $TOKEN" -H 'x-sy-actor: seed-portfolio'
    -w '\n%{http_code}' "$G$path")
  [ -n "$data" ] && args+=(-H 'content-type: application/json' --data "$data")
  out="$(curl "${args[@]}")" || { echo "seed-portfolio: cannot reach $G" >&2; exit 1; }
  printf '%s' "${out##*$'\n'}" >"$STATUS_FILE"
  printf '%s' "${out%$'\n'*}"
}
status() { cat "$STATUS_FILE"; }

env_get() { # file var -> value or empty
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1 | tr -d '"'"'"
}

env_set() { # file var value
  local file="$1" var="$2" val="$3" dir
  dir="$(dirname "$file")"
  [ -d "$dir" ] || { echo "seed-portfolio: $dir does not exist" >&2; exit 1; }
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
    ! git -C "$dir" check-ignore -q "$file"; then
    echo "seed-portfolio: refusing to write a key into $file: it is not gitignored" >&2
    exit 1
  fi
  if [ ! -f "$file" ]; then
    (umask 077 && : >"$file")
  fi
  chmod 600 "$file" # it holds secrets now
  if grep -q "^$var=" "$file"; then
    local tmp
    tmp="$(mktemp "$file.XXXXXX")"
    awk -v k="$var" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$file" >"$tmp"
    chmod --reference="$file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
    mv "$tmp" "$file"
  else
    printf '\n# Switchyard virtual key (managed by llm-gateway/scripts/seed-portfolio.sh)\n%s=%s\n' "$var" "$val" >>"$file"
  fi
}

mask() { printf '%s…' "${1:0:12}"; }

# ── preflight ─────────────────────────────────────────────────────────────────────────────────
ROUTES="$(api GET /admin/config | jq -c '.routes | keys')"
[ "$(status)" = 200 ] || { echo "seed-portfolio: GET /admin/config -> $(status) (admin token?)" >&2; exit 1; }

# ── teams + monthly budgets ───────────────────────────────────────────────────────────────────
for t in "${TEAMS[@]}"; do
  IFS='|' read -r slug name limit <<<"$t"
  body="$(api GET "/admin/teams/$slug")"
  want="$(jq -nc --argjson l "$limit" --argjson s "$SOFT" --arg a "$ACTION" \
    '{monthly: {limit_usd: $l, soft_threshold: $s, action: $a}}')"
  if [ "$(status)" = 404 ]; then
    DRIFT=1
    if [ $CHECK = 1 ]; then log "$slug" "team missing"; continue; fi
    api POST /admin/teams "$(jq -nc --arg s "$slug" --arg n "$name" --argjson b "$want" \
      '{slug: $s, name: $n, budgets: $b}')" >/dev/null
    [ "$(status)" = 201 ] || { echo "seed-portfolio: create team $slug -> $(status)" >&2; exit 1; }
    log "$slug" "team created, monthly budget \$$limit"
    continue
  fi
  [ "$(status)" = 200 ] || { echo "seed-portfolio: GET team $slug -> $(status)" >&2; exit 1; }
  ok="$(jq --argjson l "$limit" --argjson s "$SOFT" --arg a "$ACTION" \
    '[.budgets[]? | select(.period=="monthly" and .limit_usd==$l and .soft_threshold==$s and .action==$a)] | length' <<<"$body")"
  if [ "$ok" = 1 ]; then
    log "$slug" "team ok, monthly budget \$$limit (soft $SOFT, $ACTION)"
  else
    DRIFT=1
    if [ $CHECK = 1 ]; then log "$slug" "monthly budget drifted"; continue; fi
    api PUT "/admin/teams/$slug/budgets" "$want" >/dev/null
    [ "$(status)" = 200 ] || { echo "seed-portfolio: PUT budgets $slug -> $(status)" >&2; exit 1; }
    log "$slug" "monthly budget reset to \$$limit"
  fi
done

# ── keys ──────────────────────────────────────────────────────────────────────────────────────
key_works() { # plaintext -> 0 if the gateway accepts it
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "$G/v1/models")" = 200 ]
}

declare -A DONE=()
for k in "${KEYS[@]}"; do
  IFS='|' read -r _ team kname _ <<<"$k"
  id="$team/$kname"
  [ -n "${DONE[$id]:-}" ] && continue
  DONE[$id]=1

  # Every place this key is referenced (selected or not) — so a partial run never revokes a key that
  # another project's .env still uses.
  targets=() wanted=0 routes=null
  for k2 in "${KEYS[@]}"; do
    IFS='|' read -r c2 t2 n2 r2 f2 v2 <<<"$k2"
    [ "$t2/$n2" = "$id" ] || continue
    targets+=("$c2|$f2|$v2")
    routes="$r2"
    selected "$c2" && wanted=1
  done
  [ $wanted = 1 ] || continue

  active="$(api GET "/admin/teams/$team/keys" | jq -c --arg n "$kname" '[.data[] | select(.name==$n and .status=="active")]')"
  [ "$(status)" = 200 ] || { echo "seed-portfolio: list keys $team -> $(status)" >&2; exit 1; }

  # Reuse a referenced plaintext that matches an active key of this name and still authenticates.
  chosen="" referenced=()
  for tg in "${targets[@]}"; do
    IFS='|' read -r _ f v <<<"$tg"
    cur="$(env_get "$f" "$v")"
    case "$cur" in sk-sy-*) referenced+=("${cur:0:12}") ;; *) continue ;; esac
    [ -n "$chosen" ] && continue
    if [ "$(jq --arg p "${cur:0:12}" '[.[] | select(.prefix==$p)] | length' <<<"$active")" -ge 1 ] && key_works "$cur"; then
      chosen="$cur"
    fi
  done

  if [ -z "$chosen" ]; then
    DRIFT=1
    if [ $CHECK = 1 ]; then
      log "$team" "key $kname: no valid key in the consumers' .env (would issue one)"
    else
      allowed="$(jq -c --argjson have "$ROUTES" 'if . == null then null else map(select(. as $r | $have | index($r))) end' <<<"$routes")"
      created="$(api POST "/admin/teams/$team/keys" "$(jq -nc --arg n "$kname" --argjson r "$allowed" \
        '{name: $n, allowed_routes: $r, metadata: {managed_by: "seed-portfolio"}}')")"
      [ "$(status)" = 201 ] || { echo "seed-portfolio: create key $id -> $(status): $created" >&2; exit 1; }
      chosen="$(jq -r .key <<<"$created")"
      referenced+=("${chosen:0:12}")
      log "$team" "key $kname issued ($(mask "$chosen")), routes: $(jq -r 'if . == null then "all" else join(",") end' <<<"$allowed")"
    fi
  else
    log "$team" "key $kname ok ($(mask "$chosen"))"
  fi

  # Write the key to the selected consumers' .env files.
  for tg in "${targets[@]}"; do
    IFS='|' read -r c f v <<<"$tg"
    selected "$c" || continue
    [ -n "$chosen" ] || continue
    if [ "$(env_get "$f" "$v")" != "$chosen" ]; then
      DRIFT=1
      if [ $CHECK = 1 ]; then log "$c" "$f: $v out of date"; continue; fi
      env_set "$f" "$v" "$chosen"
      log "$c" "wrote $v to $f"
    else
      log "$c" "$f: $v up to date"
    fi
  done

  # Revoke stale active keys of this name that no .env references.
  [ $CHECK = 1 ] && continue
  refs="$(printf '%s\n' "${referenced[@]}" | jq -R . | jq -sc .)"
  for stale in $(jq -r --argjson refs "$refs" '.[] | select(.prefix as $p | $refs | index($p) | not) | .id' <<<"$active"); do
    api POST "/admin/keys/$stale/revoke" >/dev/null
    log "$team" "revoked stale $kname key $stale"
  done
done

if [ $CHECK = 1 ]; then
  [ $DRIFT = 0 ] && echo "seed-portfolio: in sync" || { echo "seed-portfolio: drift detected"; exit 1; }
fi
