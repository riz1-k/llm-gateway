## What and why

<!-- What does this change, and why? Link the issue (Fixes #123). -->

## How was it tested?

<!-- Tests added or changed; manual checks (commands, config). -->

## Checklist

- [ ] Tests cover the change (`pnpm test`), and `pnpm lint` and `pnpm typecheck` pass
- [ ] Config changes: `schema.ts` fields have `.describe()`, and I ran `pnpm --filter switchyard-gateway schema`
- [ ] Public API changes: exported from `src/index.ts` with TSDoc (`pnpm check:package`)
- [ ] User-visible change: added a changeset (`pnpm changeset`)
- [ ] Docs updated (README, docs/\*, config/gateway.example.yaml) where relevant
- [ ] No secrets, prompt bodies or internal hostnames in logs or error messages
