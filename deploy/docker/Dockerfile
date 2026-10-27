# syntax=docker/dockerfile:1.28
#
# Switchyard gateway image. One image, every role:
#   docker run IMAGE                    → switchyard serve   (SWITCHYARD_CONFIG=/etc/switchyard/gateway.yaml)
#   docker run IMAGE worker --port 9465 → usage stream → Postgres writer (+ /metrics)
#   docker run IMAGE migrate            → idempotent, advisory-locked schema migration
#   docker run IMAGE mock-provider --host 0.0.0.0 --port 8790
#
# Build (from the repository root):
#   docker build -f deploy/docker/Dockerfile -t switchyard:dev .

# ── base: Node + the pnpm version pinned in package.json#packageManager (via corepack) ──────────
# The tag is written out (no ARG) so Dependabot can bump the tag and digest together.
FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS base
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_STORE=/pnpm/store
WORKDIR /src
COPY package.json ./
RUN corepack enable && corepack install

# ── deps: fetch every package of the lockfile into the store. Only invalidated when the lockfile
#    (or workspace settings) change, so source edits reuse this layer. ──────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --store-dir "$PNPM_STORE"

# ── build: offline install, bundle, then prune to production dependencies ─────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
RUN pnpm install --offline --frozen-lockfile --store-dir "$PNPM_STORE"
# Runtime needs JavaScript only; declaration files (the npm package's job) are skipped here.
RUN pnpm --filter switchyard-gateway exec tsdown --no-dts
# `pnpm deploy` copies the package (`files`: dist/, drizzle/) plus its production node_modules,
# resolved from the shared lockfile (exact same versions as CI/dev). pnpm ≥ 10 only does that for
# workspaces with inject-workspace-packages; enabling it for this command is safe because the
# gateway's only workspace dependency (@switchyard/mock-provider) is a devDependency bundled into
# dist/ by tsdown.
RUN pnpm --filter switchyard-gateway deploy --prod --offline --store-dir "$PNPM_STORE" \
      --config.inject-workspace-packages=true /out \
 && rm -rf /out/node_modules/.bin /out/node_modules/.modules.yaml /out/node_modules/.package-map.json \
 && find /out/node_modules -type f \( -name '*.md' -o -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
 # js-tiktoken ships every encoding twice (ESM + CJS, ~21 MB); the gateway only imports the ESM
 # `js-tiktoken/lite` entry and the o200k_base ranks (src/limits/estimate.ts).
 && tk="$(echo /out/node_modules/.pnpm/js-tiktoken@*/node_modules/js-tiktoken/dist)" \
 && find "$tk" -type f ! -name 'lite.js' ! -name 'chunk-*.js' ! -path '*/ranks/o200k_base.js' -delete \
 && node /out/dist/cli.js --version \
 && cd /out && node --input-type=module -e "const {Tiktoken}=await import('js-tiktoken/lite'); \
      const r=(await import('js-tiktoken/ranks/o200k_base')).default; \
      if (new Tiktoken(r).encode('hello world').length !== 2) process.exit(1)"

# ── runtime: distroless Node 24 (no shell, no package manager), non-root ──────────────────────
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8 AS runtime
ARG VERSION=0.1.0
ARG REVISION=unknown
ARG CREATED=1970-01-01T00:00:00Z
LABEL org.opencontainers.image.title="switchyard" \
      org.opencontainers.image.description="Switchyard: OpenAI-compatible LLM gateway (routing, fallback, caching, rate limits, budgets, per-team cost)" \
      org.opencontainers.image.source="https://github.com/riz1-k/llm-gateway" \
      org.opencontainers.image.url="https://github.com/riz1-k/llm-gateway" \
      org.opencontainers.image.documentation="https://github.com/riz1-k/llm-gateway/blob/main/docs/DEPLOYMENT.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="riz1-k" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs24-debian13:nonroot"

WORKDIR /app
# Files stay root-owned and read-only for the runtime user (works with readOnlyRootFilesystem).
COPY --from=build /out/package.json /app/package.json
COPY --from=build /out/node_modules /app/node_modules
COPY --from=build /out/drizzle /app/drizzle
COPY --from=build /out/dist /app/dist
# Default pricing table; a config can point `pricing_file` here or ship its own.
COPY config/pricing.json /app/config/pricing.json

ENV NODE_ENV=production \
    PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin \
    NODE_OPTIONS=--enable-source-maps \
    SWITCHYARD_CONFIG=/etc/switchyard/gateway.yaml \
    SWITCHYARD_MIGRATIONS_DIR=/app/drizzle

# 65532 = distroless "nonroot"
USER 65532:65532
# 8787 API · 9464 gateway metrics (metrics.port) · 9465 worker metrics · 8790 mock provider
EXPOSE 8787 9464 9465 8790

# No shell in the image: health checks use node itself, e.g.
#   node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve"]
