# Changesets

This folder holds pending release notes, managed by [Changesets](https://github.com/changesets/changesets).

- **Contributors:** run `pnpm changeset` for any user-visible change. Pick `patch`, `minor` or
  `major` for `switchyard-gateway` and describe the change in a sentence or two. Commit the
  generated `.changeset/*.md` file with your pull request.
- **Maintainers:** the release workflow keeps a "Version Packages" pull request up to date.
  Merging it bumps the version, writes `packages/gateway/CHANGELOG.md` and publishes. See
  [docs/RELEASING.md](../docs/RELEASING.md).

Before 1.0, breaking changes are `minor` bumps and must be called out in the changeset.
