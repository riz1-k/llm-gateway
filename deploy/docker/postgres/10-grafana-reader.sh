#!/usr/bin/env bash
# Creates the read-only role Grafana uses for the Postgres-backed dashboard panels.
# Runs once, on first initialisation of the data volume (docker-entrypoint-initdb.d).
# pg_read_all_data (PG ≥ 14) also covers tables and monthly usage_events partitions that
# `switchyard migrate` / the worker create later.
set -euo pipefail
: "${GRAFANA_PG_USER:?}" "${GRAFANA_PG_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v role="$GRAFANA_PG_USER" -v pw="$GRAFANA_PG_PASSWORD" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'pw' CONNECTION LIMIT 10;
GRANT pg_read_all_data TO :"role";
ALTER ROLE :"role" SET default_transaction_read_only = on;
ALTER ROLE :"role" SET statement_timeout = '30s';
SQL
