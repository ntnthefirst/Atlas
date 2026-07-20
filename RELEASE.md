# Releasing Atlas

One rule: **the version in `package.json` is the release.** Bump it in your PR,
merge, and it publishes itself. There are no labels, no manual tags, and no
version math.

## The flow

1. Open a PR into `main` with the version bumped:

    ```bash
    npm version minor --no-git-tag-version   # edits package.json only
    git commit -am "chore: 1.2.0"
    ```

2. [**PR Check**](.github/workflows/pr-check.yml) runs on the PR and must pass
   before it can be merged:
    - **Lint and Build** — `npm run lint` + `npm run build`.
    - **Version** — the version must be valid semver, higher than the one on
      `main`, and not already tagged.

3. Merge. [**Release**](.github/workflows/release.yml) runs on `main`, and when
   the version is new it lints, builds, tags `v<version>`, creates the GitHub
   release, and uploads the Windows + macOS installers.

That's the whole process — two workflows, one source of truth.

## Choosing the bump

```bash
npm version patch --no-git-tag-version   # 1.1.0 -> 1.1.1   bug fixes
npm version minor --no-git-tag-version   # 1.1.0 -> 1.2.0   features
npm version major --no-git-tag-version   # 1.1.0 -> 2.0.0   breaking changes
```

Use `--no-git-tag-version` so only `package.json` changes; the Release workflow
creates the tag on `main`.

## Pre-releases (beta)

A release is published as a **pre-release** when either:

- the version contains `-beta` — e.g.
  `npm version preminor --preid=beta --no-git-tag-version` → `1.2.0-beta.0`, or
- `package.json` contains `"beta": true` — useful to ship a plain version number
  as a pre-release. Remove the field to go stable again.

## Notes

- **Every PR must bump the version**, because every merge to `main` publishes.
  If a PR genuinely shouldn't ship (say a README typo), fold it into another PR
  that does bump.
- Turn on branch protection for `main` and mark **Lint and Build** and
  **Version** as required checks, so a PR can't merge until both are green.
  Also enable **Require branches to be up to date before merging** — that forces
  a stale PR to rebase and re-run, which is what catches two PRs racing on the
  same version number.
- Release is safe to re-run: if `v<version>` already exists it skips. A failed
  publish can be retried from the Actions tab (**Run workflow**) without a new
  commit.
- The installer version comes from `package.json`, so the tag, the release, and
  the installers can never disagree.
