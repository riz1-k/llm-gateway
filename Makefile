# Switchyard developer shortcuts.
.PHONY: install build test test-live lint typecheck dev mock validate clean

install:
	pnpm install

build:
	pnpm build

test:
	pnpm test

test-live:          ## opt-in: ≤ 6 real Copilot calls through the opencode bridge
	bash -c 'set -a; source ../devenv/.env; set +a; pnpm test:live'

lint:
	pnpm lint

typecheck:
	pnpm typecheck

dev:                ## gateway on :8787 with config/gateway.local.yaml
	scripts/dev.sh

mock:               ## standalone mock provider on :8790
	pnpm mock

validate:
	pnpm --filter switchyard-gateway exec tsx src/cli.ts validate-config ../../config/gateway.local.yaml

clean:
	rm -rf packages/*/dist packages/*/coverage
