# Contributing to Switchyard

Thanks for helping! Bug reports, docs fixes, new provider adapters and performance work are all
welcome. For larger changes, such as a new subsystem, a config format change or a new
dependency, please open an issue first so we can agree on the approach. Everyone taking part
is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need:

- Node.js 24 (see `.node-version`; Node 22.12 or later also works) and pnpm (the version is
  pinned in `package.json` → `packageManager`; `corepack enable` picks it up);
- Redis 8 and Postgres 16 or later for the platform tests. Docker works:
  `docker run -d -p 6379:6379 redis:8` and
  `docker run -d -p 5432:5432 -e POSTGRES_USER=dev -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=llmgateway_test postgres:18`.

```bash
pnpm install
pnpm build
pnpm test        # unit + integration + openai SDK contract tests
pnpm lint        # eslint (type-aware) + prettier --check
pnpm typecheck
```

The platform tests use Redis db 1 (`redis://127.0.0.1:6379/1`) and the database
`llmgateway_test`. Override them with `SWITCHYARD_TEST_REDIS_URL` and
`SWITCHYARD_TEST_DATABASE_URL`. db 0 is refused. Every test file uses its own key prefix and
Postgres schema and cleans up after itself.

Handy commands:

| Command                                                                                                 | What                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm --filter switchyard-gateway exec tsx src/cli.ts serve --config ../../config/gateway.example.yaml` | run from source                                              |
| `pnpm mock`                                                                                             | standalone mock provider on :8790                            |
| `pnpm --filter switchyard-gateway schema`                                                               | regenerate `config.schema.json` and `docs/CONFIG.md`         |
| `pnpm check:package`                                                                                    | schema in sync, TSDoc on public API, publint, attw           |
| `scripts/pack-smoke.sh <tarball>`                                                                       | install a packed tarball in an empty project and exercise it |
| `scripts/verdaccio-e2e.sh`                                                                              | publish to a throwaway local registry and test the install   |
| `bench/run.sh`                                                                                          | k6 benchmarks (see [bench/README.md](bench/README.md))       |
| `make help`                                                                                             | everything else (compose, kind, infra lint)                  |

## Making a change

1. Fork, then branch from `main`.
2. Add tests. Behaviour changes need a test that fails without your change. The test layout:
   - `packages/gateway/test/unit`;
   - `test/integration`, the in-process gateway against the mock provider over HTTP;
   - `test/platform`, real Redis and Postgres;
   - `test/contract`, the official `openai` SDK.
3. Config changes: edit `src/config/schema.ts` and give every field a `.describe()`, then run
   `pnpm --filter switchyard-gateway schema`. CI fails when the schema or `docs/CONFIG.md` is
   stale.
4. Public API changes: export from `src/index.ts` with TSDoc. `pnpm check:package` enforces
   both.
5. Add a changeset if users will notice the change: run `pnpm changeset`, pick the bump and
   write one or two sentences for the changelog. Docs-only and internal changes don't need one.
6. Run `pnpm lint && pnpm typecheck && pnpm test`, then open a pull request. The template has a
   short checklist.

## Code guidelines

- TypeScript strict, ESM. No `any` in public types.
- Keep the request path allocation-light: it is benchmarked
  ([bench/RESULTS.md](bench/RESULTS.md)).
- New provider adapters implement `ProviderAdapter` (`src/providers/base.ts`). They translate
  to and from the canonical OpenAI shape, throw `ProviderError` with a correct `retryable` flag,
  and come with tests against recorded fixtures or the mock provider.
- Never log prompt bodies or secrets. Error messages returned to clients must not leak internal
  hostnames or credentials.
- Record significant design decisions as an ADR in [docs/adr/](docs/adr/README.md).

## Releases

Maintainers release with Changesets. Merging the "Version Packages" pull request publishes to
npm with provenance, tags the release, creates the GitHub Release and pushes the container image.
See [docs/RELEASING.md](docs/RELEASING.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
