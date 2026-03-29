# Atlas Developer Docs

## Purpose

This document describes Atlas release automation, installer publishing, and the update system used by the app.

## Release and Installer Pipeline

Main workflow: `.github/workflows/main-ci-release.yml`

### What it does

1. Lint + build quality gate
2. Auto version calculation
3. Tag + GitHub Release creation
4. Installer builds on supported platforms:
    - Windows (`nsis`)
    - macOS (`dmg`, `zip`)
5. Asset publishing to the release through electron-builder

### Channels

- Stable: `vX.Y.Z`
- Beta/prerelease: `vX.Y.Z-beta.N`

`workflow_dispatch` inputs:

- `release_channel`: `stable` or `beta`
- `bump`: `auto`, `patch`, `minor`, `major`

`auto` bump behavior is based on commit messages:

- Breaking (`!` or `BREAKING CHANGE`) -> major
- `feat:` -> minor
- everything else -> patch

## PR Control and Safety

PR workflow: `.github/workflows/pr-release-guard.yml`

PRs to `main` must include exactly one label:

- `release:patch`
- `release:minor`
- `release:major`

Beta labels:

- `release:beta` (start beta from a bumped stable line, or continue when latest release is beta)
- `release:finalize-beta` (only valid when latest release is beta; publishes stable for that same base version)

State rules:

- If latest release is stable: exactly one bump label is required (`patch|minor|major`), `release:beta` optional.
- If latest release is beta: no bump labels are allowed.
- If latest release is beta: exactly one of `release:beta` (continue) or `release:finalize-beta` (finalize) is required.

This enforces version intent without manually editing versions in files.

## Update Engine

Main process file: `electron/main.cjs`

### Data sources

- GitHub Releases API for version/release history
- electron-updater for in-app install in packaged apps

### Preferences

Stored in `userData/update-preferences.json`:

- `autoCheck`
- `includeBeta`

IPC endpoints:

- `app:getUpdatePreferences`
- `app:setUpdatePreferences`
- `app:checkUpdates`
- `app:releaseHistory`
- `app:downloadAndInstallUpdate`

### Renderer bridge

Preload exports in `electron/preload.cjs`:

- `getUpdatePreferences`
- `setUpdatePreferences`
- `checkForUpdates({ includePrerelease })`
- `listReleaseHistory({ includePrerelease })`
- `downloadAndInstallUpdate({ includePrerelease })`

### Settings UI

`src/components/settings-window/SettingsWindowApp.tsx` includes:

- Current version + publish timestamp
- `Scan for updates`
- `Automatic update checks`
- `Beta updates`
- `Install update` button (in-app install in packaged builds)

## electron-builder Notes

Build config lives in `package.json` under `build`.

Important keys:

- `publish.provider = github`
- platform-specific `artifactName` values
- Windows target: `nsis` (required for best auto-update flow)

## Local Testing Tips

1. Run app in dev mode:

```bash
npm run dev
```

2. Build local installer without publishing:

```bash
npm run dist
```

3. Test update UI logic in Settings -> Updates.

4. In-app install (`downloadAndInstallUpdate`) only succeeds in packaged builds; in dev it falls back to browser download URL.

## Known Constraints

- GitHub always exposes source archive attachments on releases (`zip`, `tar.gz`); these are platform defaults and not custom upload artifacts.
- macOS signing/notarization is not configured in this repo by default.
- Linux installers are intentionally not built or published in CI.
