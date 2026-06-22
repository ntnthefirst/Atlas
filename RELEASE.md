# Releasing Atlas

Versions are driven by `package.json` using `npm version`, which bumps the
version, makes a commit, and creates the matching `vX.Y.Z` git tag in one step.
**Pushing the tag** triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
which lints, builds, and publishes the GitHub release with Windows + macOS
installers. Tags containing `-beta` are published as pre-releases.

There is no release label or version math — the tag is the source of truth, and
`package.json` always stays in sync with it.

## Stable release

```bash
npm version patch      # 1.0.0 -> 1.0.1   (bug fixes)
npm version minor      # 1.0.0 -> 1.1.0   (features)
npm version major      # 0.8.0 -> 1.0.0   (breaking changes)
git push --follow-tags
```

## Beta release

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
