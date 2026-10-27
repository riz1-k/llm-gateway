# Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets) and GitHub
Actions. A release produces the artifacts below; the container image is also signed with cosign
(keyless):

| Artifact                                                                                                          | Where                          | Auth                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `switchyard-gateway@<version>` (with provenance)                                                                  | npmjs.com                      | npm trusted publishing (OIDC); `NPM_TOKEN` only for the first publish |
| Git tag `switchyard-gateway@<version>` + GitHub Release (notes from the changelog)                                | this repository                | `GITHUB_TOKEN`                                                        |
| `@riz1-k/switchyard-gateway@<version>`                                                                            | GitHub Packages (npm registry) | `GITHUB_TOKEN`                                                        |
| `ghcr.io/riz1-k/switchyard:<version>`, `:<major>.<minor>`, `:latest` (multi-arch, SBOM + provenance attestations) | GHCR                           | `GITHUB_TOKEN`                                                        |

## How it flows

`.github/workflows/release.yml` runs on every push to `main`:

1. **select-mode** looks at the repository:
   - changesets are pending → `version`;
   - no changesets, and a package version that is not on npm yet → `publish`;
   - otherwise → nothing to do.

   The release is opt-in: until the repository variable `RELEASE_ENABLED` is `true`, the run
   stops here with a notice, so fresh clones and forks never attempt a publish.

2. **version** opens or updates the "Version Packages" pull request. It bumps
   `packages/gateway/package.json`, writes `CHANGELOG.md`, regenerates `config.schema.json` and
   `docs/CONFIG.md`, and refreshes the lockfile.
3. When that pull request is merged, the next run is in `publish` mode:
   - **pack** builds, re-runs the package checks (schema in sync, publint, attw) and packs the
     tarball once;
   - **publish** publishes that exact tarball to npmjs.com with provenance, pushes the git tag
     and creates the GitHub Release;
   - **github-packages** publishes the same version under the scoped name
     `@riz1-k/switchyard-gateway` to GitHub Packages;
   - **docker** calls `docker.yml` (as a reusable workflow, because tags pushed with
     `GITHUB_TOKEN` do not trigger other workflows) to build and push the multi-arch image
     tagged `<version>`, `<major>.<minor>` and `latest`, then signs it with cosign. The
     certificate identity is `docker.yml` (the reusable workflow), with the workflow name
     `Release`; see [DEPLOYMENT.md](DEPLOYMENT.md#verifying-the-image) for the verify commands.

Every action is pinned to a commit SHA, each job gets only the permissions it needs, and the
publish job runs in the `npm` environment, where you can add required reviewers as an approval
gate.

### First release

The repository starts at version **0.1.0**, with no pending changesets. The first push to `main`
(or Release re-run) after setup, i.e. once `RELEASE_ENABLED` is `true`, therefore goes straight to `publish` mode and releases 0.1.0 as it is, without a
version bump. Its changelog entry is already written in `packages/gateway/CHANGELOG.md`.

## One-time setup (owner)

npm trusted publishing can only be configured for a package that already exists on npm, so the
very first publish uses a token, and every later one uses OIDC.

1. **Repository settings:**
   - Settings → Actions → General → enable **Allow GitHub Actions to create and approve pull
     requests** (for the Version Packages PR).
   - Settings → Environments → create an environment named **`npm`**. Optionally add required
     reviewers.
2. **First publish with a token:**
   - On npmjs.com create a **granular access token** with read and write access to packages, and
     enable **Bypass two-factor authentication**. The package doesn't exist yet, so scope it to
     all packages, with a short expiry (for example 7 days).
   - Add it as a secret named **`NPM_TOKEN`**, either on the `npm` environment or on the
     repository.
   - Settings → Secrets and variables → Actions → **Variables** → add **`RELEASE_ENABLED`** with
     the value `true` (the switch that turns the release automation on).
   - Push to `main`, or re-run the Release workflow. 0.1.0 is published with provenance, and the
     tag, GitHub Release, GitHub Packages copy and GHCR image follow.
3. **Switch to trusted publishing:**
   - On npmjs.com open `switchyard-gateway` → Settings → **Trusted publishing** → GitHub Actions,
     and enter:
     - organization or user `riz1-k`;
     - repository `llm-gateway`;
     - workflow filename `release.yml`;
     - environment `npm`.
   - Alternatively, with npm 11.15 or later and 2FA on your account:

     ```bash
     npm trust github switchyard-gateway --file release.yml --repo riz1-k/llm-gateway --env npm --allow-publish
     ```

   - Optionally set the package to **Require two-factor authentication and disallow tokens**,
     then **delete the `NPM_TOKEN` secret and revoke the token**. From then on the workflow
     authenticates with a short-lived OIDC token. The publish step logs which method it used.

GitHub Packages and GHCR need no setup: they use the workflow's `GITHUB_TOKEN`. After the first
image push, set the GHCR package visibility to **public** under Packages → switchyard →
Package settings, if it isn't already.

## Day-to-day

```bash
pnpm changeset             # in your PR: pick the bump, describe the change
```

Merge PRs as usual. Merge the Version Packages PR when you want to ship. Nothing else is manual.

### Before 1.0

Use `minor` for breaking changes and `patch` for everything else. The public API is the export
list of `packages/gateway/src/index.ts`, plus the config schema, the CLI and the HTTP API.

## Verifying a release locally (no publishing)

```bash
pnpm build && pnpm check:package                       # schema in sync, TSDoc, publint, attw
(cd packages/gateway && pnpm pack --pack-destination /tmp/sy)
scripts/pack-smoke.sh /tmp/sy/switchyard-gateway-*.tgz # empty project: CLI, server, library
scripts/verdaccio-e2e.sh                               # throwaway local registry, then the same checks
```

`scripts/verdaccio-e2e.sh` publishes to a temporary [Verdaccio](https://verdaccio.org) on
`127.0.0.1` with a dummy user, installs from it, and runs the CLI, the official `openai` SDK
(chat, streaming with `usage.cost`, embeddings) and the library API against it. It then stops
the registry and deletes everything.

## If something goes wrong

- **Publish failed after the tarball was packed:** re-run the whole workflow. `select-mode` only
  plans versions that are not on npm yet, so a version that did get published is not retried.
- **Image push failed:** re-run the `docker` job, or run the Docker workflow manually
  (`workflow_dispatch`). Images are only tagged `latest` from a release.
- **Bad release:** npm versions are immutable. Deprecate it
  (`npm deprecate switchyard-gateway@x.y.z "reason"`) and release a fix. Unpublishing is only
  possible within 72 hours and breaks users.
