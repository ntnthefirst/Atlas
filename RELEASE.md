# Releasing Atlas

Versions are driven by `package.json`. There is no release label and no version
math — the version in `package.json` is the source of truth, and the `vX.Y.Z`
tag always matches it.

There are two ways to release, and both end up in
[`release.yml`](.github/workflows/release.yml), which lints, builds, and
publishes the GitHub release with Windows + macOS installers.

## 1. Automatic: bump the version in a PR

[`auto-tag-release.yml`](.github/workflows/auto-tag-release.yml) watches pushes
to `main`. When a merge lands a version that has **no tag yet**, it creates and
pushes `v<version>` and publishes the release automatically.

So to ship a change, bump the version in the PR itself:

```bash
npm version minor --no-git-tag-version   # edits package.json only
git commit -am "chore: 1.2.0"
```

Merge the PR and the release builds and publishes on its own. If the merge does
**not** change the version, the workflow is a no-op — ordinary merges never
publish.

## 2. Manual: tag from `main`

`npm version` bumps the version, commits, and creates the tag in one step;
pushing the tag publishes.

## Stable release

```bash
npm version patch      # 1.0.0 -> 1.0.1   (bug fixes)
npm version minor      # 1.0.0 -> 1.1.0   (features)
npm version major      # 0.8.0 -> 1.0.0   (breaking changes)
git push --follow-tags
```

## Beta release

A release is published as a **pre-release** when either the version contains
`-beta` (e.g. `1.2.0-beta.0`) or `package.json` has `"beta": true`. The flag is
useful with the automatic path when you want a plain version number shipped as a
pre-release; remove it to go stable again.

Start a beta for the next version:

```bash
npm version premajor --preid=beta   # 0.8.0 -> 1.0.0-beta.0
npm version preminor --preid=beta   # 0.8.0 -> 0.9.0-beta.0
npm version prepatch --preid=beta   # 0.8.0 -> 0.8.1-beta.0
git push --follow-tags
```

Cut the next beta in the same line:

```bash
npm run release:beta   # 1.0.0-beta.0 -> 1.0.0-beta.1
git push --follow-tags
```

Finalize the beta into its stable release:

```bash
npm version patch      # 1.0.0-beta.1 -> 1.0.0
git push --follow-tags
```

## Notes

- `npm version` requires a clean working tree and refuses to recreate a tag
  that already exists, so the "tag already exists" failure can't happen
  silently.
- To redo a failed release, delete the tag locally and on the remote
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), fix the issue,
  then re-create and push the tag — or just re-run the failed workflow run from
  the Actions tab.
- PRs to `main` still run lint + build via `pr-ci-check.yml`; releasing is a
  separate, deliberate step.
