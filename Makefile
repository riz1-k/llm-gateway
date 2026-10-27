# Switchyard developer shortcuts.  `make help` lists the targets.
SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

IMAGE        ?= switchyard:dev
VERSION      ?= $(shell node -p "require('./packages/gateway/package.json').version" 2>/dev/null || echo 0.0.0)
REVISION     ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
COMPOSE      := docker compose -f deploy/docker/docker-compose.yml
OBSERVE_HOST := docker compose -f deploy/docker/docker-compose.observe-host.yml
KIND_ENV     := deploy/terraform/envs/local-kind
TOOLS_DIR    ?= $(or $(TMPDIR),/tmp)/switchyard-tools
DEMO_SECONDS ?= 120
CHART        := deploy/helm/switchyard
GRAFANA_URL  ?= http://127.0.0.1:3301
# Optional env file (gitignored) sourced by dev/test-live; override with ENV_FILE=/path/to/.env
ENV_FILE     ?= .env

.PHONY: help install build test test-live lint typecheck dev mock validate clean \
        schema check-package pack-smoke verdaccio-e2e bench \
        image compose-up compose-demo compose-down compose-stop compose-logs compose-ps \
        observe-host-up observe-host-down dashboards dashboards-check screenshots chart-sync tools lint-alerts lint-helm lint-terraform lint-workflows lint-secrets audit lint-infra \
        k8s-up k8s-demo k8s-down

help:               ## show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ── development ──────────────────────────────────────────────────────────────────────────────
install:            ## pnpm install
	pnpm install

build:              ## build all packages
	pnpm build

test:               ## unit + integration tests (needs local Redis/Postgres)
	pnpm test

test-live:          ## opt-in: ≤ 6 real calls via the opencode bridge (OPENCODE_* from env or ENV_FILE, default .env)
	bash -c 'set -a; if [ -f "$(ENV_FILE)" ]; then source "$(ENV_FILE)"; fi; set +a; pnpm test:live'

lint:               ## eslint + prettier
	pnpm lint

typecheck:          ## tsc --noEmit
	pnpm typecheck

dev:                ## gateway on :8787 with config/gateway.local.yaml (env: ENV_FILE, default .env)
	SWITCHYARD_ENV_FILE="$(ENV_FILE)" scripts/dev.sh

mock:               ## standalone mock provider on :8790
	pnpm mock

validate:           ## validate config/gateway.local.yaml
	pnpm --filter switchyard-gateway exec tsx src/cli.ts validate-config ../../config/gateway.local.yaml

clean:
	rm -rf packages/*/dist packages/*/coverage

# ── package & release checks (nothing is published) ──────────────────────────────────────────
schema:             ## regenerate config.schema.json + docs/CONFIG.md from the zod schema
	pnpm --filter switchyard-gateway run schema

check-package:      ## schema/docs in sync, TSDoc on public API, publint, attw (after build)
	pnpm check:package

pack-smoke: build   ## pack the npm tarball, install it in an empty project, run CLI/server/library
	rm -rf $(TOOLS_DIR)/pack && mkdir -p $(TOOLS_DIR)/pack
	cd packages/gateway && pnpm pack --pack-destination $(TOOLS_DIR)/pack
	OPENAI_SDK=$${OPENAI_SDK:-7.45.0} scripts/pack-smoke.sh $(TOOLS_DIR)/pack/switchyard-gateway-*.tgz

verdaccio-e2e: build ## publish to a throwaway local verdaccio registry and test the installed package
	scripts/verdaccio-e2e.sh

bench: build        ## k6 benchmarks vs a 0 ms mock (needs k6; see bench/README.md)
	bench/run.sh

# ── container image & docker compose ─────────────────────────────────────────────────────────
image:              ## build the container image ($(IMAGE))
	docker build -f deploy/docker/Dockerfile -t $(IMAGE) \
	  --build-arg VERSION=$(VERSION) --build-arg REVISION=$(REVISION) \
	  --build-arg CREATED=$$(date -u +%Y-%m-%dT%H:%M:%SZ) .

compose-up: image   ## start the full stack (gateway :8797, Grafana :3301, Prometheus :9091, Tempo :3201)
	SWITCHYARD_IMAGE=$(IMAGE) $(COMPOSE) up -d --no-build --wait --wait-timeout 180
	@echo "gateway    http://127.0.0.1:8797   (admin token: see deploy/docker/docker-compose.yml)"
	@echo "grafana    http://127.0.0.1:3301   (admin / \$$GRAFANA_ADMIN_PASSWORD, default switchyard-local)"
	@echo "prometheus http://127.0.0.1:9091"
	@echo "tempo      http://127.0.0.1:$${TEMPO_PORT:-3201}   (OTLP/HTTP for other local services: http://127.0.0.1:$${TEMPO_OTLP_PORT:-4319})"

compose-demo:       ## seed teams/budgets and send $(DEMO_SECONDS)s of demo traffic
	SWITCHYARD_IMAGE=$(IMAGE) $(COMPOSE) --profile demo run --rm --no-deps seed
	node deploy/demo/traffic.mjs --url http://127.0.0.1:$${GATEWAY_PORT:-8797} --duration $(DEMO_SECONDS)

compose-down:       ## stop the stack and delete its volumes
	$(COMPOSE) --profile demo down -v --remove-orphans

compose-stop:       ## stop the stack, keep volumes
	$(COMPOSE) --profile demo down --remove-orphans

compose-logs:       ## follow gateway + worker logs
	$(COMPOSE) logs -f gateway worker

compose-ps:
	$(COMPOSE) ps

# ── observability ────────────────────────────────────────────────────────────────────────────
observe-host-up:    ## Prometheus :9092 + Grafana :3302 + Tempo :3200 (OTLP :4318) for a gateway on this host (Linux, host network)
	$(OBSERVE_HOST) up -d --wait --wait-timeout 180
	@echo "grafana    http://127.0.0.1:$${OBSERVE_GRAFANA_PORT:-3302}   (admin / \$$GRAFANA_ADMIN_PASSWORD, default switchyard-local)"
	@echo "prometheus http://127.0.0.1:$${OBSERVE_PROMETHEUS_PORT:-9092}  (scrapes 127.0.0.1:8787/metrics)"
	@echo "tempo      http://127.0.0.1:$${OBSERVE_TEMPO_PORT:-3200}  (OTLP/HTTP: http://127.0.0.1:$${OBSERVE_OTLP_PORT:-4318})"

observe-host-down:  ## stop the host-mode observability stack and delete its volumes
	$(OBSERVE_HOST) down -v --remove-orphans

dashboards:         ## regenerate observability/grafana/dashboards/*.json
	node observability/grafana/generate-dashboards.mjs

dashboards-check:   ## fail if the generated dashboards are stale
	node observability/grafana/generate-dashboards.mjs --check

screenshots:        ## PNGs of the three dashboards from Grafana at $(GRAFANA_URL) (needs uv + Chrome)
	uv run --no-project observability/screenshots/capture.py --url $(GRAFANA_URL) \
	  --password "$${GRAFANA_ADMIN_PASSWORD:-switchyard-local}" $(SCREENSHOT_ARGS)

# ── infra linting (pinned tool binaries downloaded to $(TOOLS_DIR)) ──────────────────────────
tools:              ## download promtool, kubeconform, actionlint, tflint, gitleaks
	@deploy/scripts/install-tools.sh $(TOOLS_DIR)

chart-sync:         ## copy observability/prometheus/alerts.yml into the Helm chart
	cp observability/prometheus/alerts.yml $(CHART)/files/alerts.yml

lint-alerts: tools  ## promtool check + unit-test the alert rules (+ chart copy in sync)
	@cmp -s observability/prometheus/alerts.yml $(CHART)/files/alerts.yml || \
	  { echo "$(CHART)/files/alerts.yml is stale: run 'make chart-sync'"; exit 1; }
	$(TOOLS_DIR)/promtool check rules observability/prometheus/alerts.yml
	$(TOOLS_DIR)/promtool test rules observability/prometheus/alerts.test.yml
	$(TOOLS_DIR)/promtool check config --syntax-only observability/prometheus/prometheus.yml
	$(TOOLS_DIR)/promtool check config --syntax-only observability/prometheus/prometheus.observe-host.yml

lint-helm: tools    ## helm lint + kubeconform -strict on the rendered chart (every ci/*-values.yaml)
	@mkdir -p $(TOOLS_DIR)/kubeconform-cache
	@for v in $(CHART)/ci/*-values.yaml; do \
	  echo "helm lint + kubeconform: $$v"; \
	  helm lint --strict $(CHART) -f $$v | tail -1 || exit 1; \
	  helm template sy $(CHART) -f $$v --api-versions monitoring.coreos.com/v1 \
	    | $(TOOLS_DIR)/kubeconform -strict -summary -kubernetes-version 1.37.0 -cache $(TOOLS_DIR)/kubeconform-cache \
	        -schema-location default \
	        -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
	    || exit 1; \
	done

lint-terraform: tools ## terraform fmt -check, validate (all envs/modules) and tflint
	terraform fmt -check -recursive deploy/terraform
	@for d in deploy/terraform/envs/*; do \
	  echo "terraform validate: $$d"; \
	  terraform -chdir=$$d init -backend=false -input=false -no-color >/dev/null && \
	  terraform -chdir=$$d validate -no-color || exit 1; \
	done
	cd deploy/terraform && $(TOOLS_DIR)/tflint --init >/dev/null && $(TOOLS_DIR)/tflint --recursive --config "$$PWD/.tflint.hcl"

lint-workflows: tools ## actionlint
	$(TOOLS_DIR)/actionlint -color

lint-secrets: tools   ## gitleaks over the git history (rules: .gitleaks.toml)
	$(TOOLS_DIR)/gitleaks git --config .gitleaks.toml --redact --no-banner .

audit:              ## pnpm audit of production dependencies (fails on high/critical)
	pnpm audit --prod --audit-level=high

lint-infra: dashboards-check lint-alerts lint-helm lint-terraform lint-workflows ## all infra checks

# ── Kubernetes (kind via Terraform) ──────────────────────────────────────────────────────────
k8s-up:             ## create the kind cluster and deploy everything (gateway :8797, Grafana :3301)
	terraform -chdir=$(KIND_ENV) init -input=false
	terraform -chdir=$(KIND_ENV) apply -auto-approve -input=false

k8s-demo:           ## demo traffic through the kind NodePort
	node deploy/demo/traffic.mjs --url http://127.0.0.1:8797 --duration $(DEMO_SECONDS) \
	  --admin-token "$$(terraform -chdir=$(KIND_ENV) output -raw admin_token)"

k8s-down:           ## destroy the kind cluster
	terraform -chdir=$(KIND_ENV) destroy -auto-approve -input=false
