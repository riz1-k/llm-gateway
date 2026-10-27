# ADR 0007: OpenTelemetry: API as a dependency, SDK as optional dependencies loaded on demand

- **Status:** Accepted
- **Date:** 2026-10

## Context

SPEC §13 promises OTel spans per request and per attempt. Tracing is off by default, and with
it off nothing may change: no SDK loaded, no measurable overhead. The same package serves three
audiences:

- **`switchyard serve` and the container image.** The image is distroless and pruned with
  `pnpm deploy --prod`. Tracing should be a config switch there, not a rebuild.
- **npm users of the CLI.** They expect `npm i switchyard-gateway` to give them every feature.
- **Library embedders.** Many already run their own OpenTelemetry SDK (`@opentelemetry/sdk-node`)
  and want gateway spans in their traces, not a second provider.

The OpenTelemetry JS packages split into the API (`@opentelemetry/api`, about 1 MB, no
dependencies, a process-wide registry for the provider, context manager and propagator) and the
SDK. Switchyard needs five SDK packages: `sdk-trace`, `resources`, `core`,
`context-async-hooks` and `exporter-trace-otlp-http`. SDK 3.0 needs Node.js 22.15 (the gateway
supports 22.12) and declares a peer range of `@opentelemetry/api >=1.10.0 <1.11.0`.

Measured with `pnpm --filter switchyard-gateway deploy --prod` (2026-10-27): the OTel closure
(the five SDK packages plus their transitive `semantic-conventions`, `otlp-exporter-base`,
`otlp-transformer`, `sdk-logs` and `sdk-metrics`) is 10.5 MB raw. After the Dockerfile's pruning of `*.d.ts` and `*.map`, it is
3.6 MB, against a pruned deploy of about 40 MB. `semantic-conventions` alone is 12 MB raw,
mostly type declarations.

The API has one compatibility trap. A global registered through one copy of the API is only
visible to copies of the same or an older minor version. Two copies in one process can
silently disconnect the gateway's spans from the host's provider.

## Decision

- **`@opentelemetry/api` is a regular dependency, with the range `^1.9.0`.** The core imports
  only the API, through the thin module `src/observability/tracing.ts`. A caret range lets
  package managers dedupe it with the embedder's copy. It is not a peer dependency: `pnpm
deploy` fails on a package that is both a peer and a dev dependency, and a plain dependency
  works for CLI users without extra steps.
- **The five SDK packages are optional dependencies, pinned to exact versions** (`3.0.0`, and
  `0.300.0` for the exporter). npm, pnpm and yarn install them by default, so `npm i
switchyard-gateway`, `pnpm deploy --prod` (the image) and the Helm chart all have tracing.
  An install with `--no-optional` (or `--omit=optional`) leaves them out.
- **The SDK is loaded on demand.** `src/observability/otel-sdk.ts` is the only file that
  imports SDK packages. `startTracing` loads it with a dynamic `import()` only when
  `observability.otel.enabled` is true and `OTEL_SDK_DISABLED` is not `true`. The bundler emits
  it as a separate chunk. If the import fails, the gateway logs an error with an install hint
  and runs without tracing.
- **An existing global provider wins.** If `trace.setGlobalTracerProvider` reports that a
  provider is already registered, Switchyard shuts its own down and leaves the embedder's
  provider, context manager, propagator, diag logger and error handler alone. Gateway spans then
  flow into the embedder's provider ([LIBRARY.md § Tracing](../LIBRARY.md#tracing)).

## Consequences

- With tracing off, the process loads only the API. Every span call hits the API's no-op
  tracer. The tests check that `otel-sdk.js` and `@opentelemetry/sdk-trace` are never imported
  in that mode.
- Every install pays about 3.6 MB pruned (10.5 MB raw) on disk, even with tracing off. It costs
  no memory or startup time unless tracing is on.
- The image needs no rebuild or extra build argument for tracing. A config value or env var
  turns it on.
- Users who strip optional dependencies get a clear log line, not a crash, when they turn
  tracing on.
- The `^1.9.0` range means the gateway can resolve a newer API minor than the embedder's
  copy. LIBRARY.md tells embedders to keep one copy. Switchyard's own SDK needs API 1.10.x (its
  peer range), which is what the lockfile resolves today. An SDK upgrade moves both together.

## Alternatives considered

- **SDK as regular dependencies.** It is simpler and always present, but users who strip
  optional dependencies lose nothing important by not having it, and the install-size cost is
  the same. Rejected: it gains nothing, and makes the "loaded only when enabled" boundary a
  convention instead of something the package metadata shows.
- **SDK as optional peer dependencies.** This is the smallest install, and embedders choose
  their SDK version. But `npm i switchyard-gateway` users and the image would need extra steps
  to get tracing, and the CLI would need a "please install these five packages" path for a
  documented feature. Rejected for a CLI-first package. Embedders already get the
  important part through the existing-provider rule.
- **`@opentelemetry/sdk-node` or auto-instrumentations.** These pull in many more packages
  (gRPC, every instrumentation) and patch modules globally, and they still would not produce
  the gateway's GenAI attempt spans. Rejected.
- **No OTel, custom tracing.** Rejected: OTLP and W3C trace context are what other services
  and backends speak.
