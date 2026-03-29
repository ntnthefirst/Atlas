# Atlas

Atlas is a desktop app for activity tracking and project-focused time mapping.

Core features:
- Session-based tracking
- Automatic active-app logging
- Dashboard and logbook insights
- Task boards per map
- Visual notebook (text, media, post-its)
- Mini always-on-top session controls

## Installers (All Platforms)

Latest release page:
- https://github.com/ntnthefirst/Atlas/releases/latest

Direct latest asset links:
- Windows installer: https://github.com/ntnthefirst/Atlas/releases/latest/download/Atlas-Setup-Windows-x64.exe
- macOS DMG: https://github.com/ntnthefirst/Atlas/releases/latest/download/Atlas-Setup-macOS-arm64.dmg

Notes:
- Each GitHub release keeps its own installer assets (stable and beta/prerelease).
- GitHub may still show automatic source archives (`Source code (zip/tar.gz)`); those are GitHub-provided defaults.

## In-App Updates

The Settings `Updates` tab supports:
- Current installed version + publish timestamp
- Manual `Scan for updates`
- Automatic check preference
- Beta/pre-release opt-in
- In-app update installation (packaged builds), with browser-download fallback

## Release Channels

- Stable: semantic tags like `v1.2.3`
- Beta/prerelease: tags like `v1.2.4-beta.1`

Users who enable beta updates in Settings can discover and install prereleases.

## Development

### Quick Start

```bash
npm install
npm run dev
```

### Scripts

- `npm run dev`: Vite + Electron
- `npm run build`: TypeScript + Vite production build
- `npm run dist`: local Windows build (no publish)
- `npm run dist:ci:win`: CI publish Windows installers
- `npm run dist:ci:mac`: CI publish macOS installers
- `npm run lint`: ESLint

## CI/CD Overview

### Main Release Workflow

`/.github/workflows/main-ci-release.yml`:
- Runs lint/build gate
- Computes semantic version automatically
- Supports `stable` and `beta` channels
- Creates release tags and GitHub Releases
- Builds and publishes installers for Windows and macOS
- Keeps all historical releases/tags (no cleanup deletion)

### PR Guard Workflow

`/.github/workflows/pr-release-guard.yml`:
- Runs on PRs to `main`
- Requires exactly one release bump label:
  - `release:patch`
  - `release:minor`
  - `release:major`
  - `release:none`
- Optional `release:beta` label for beta intent visibility

## Project Structure

- `src/`: React UI + state
- `electron/`: main/preload, DB layer, activity tracker
- `public/`: static assets and build resources
- `release/`: local build outputs

## Additional Documentation

- Product/functional notes: `ATLAS_FUNCTIONELE_DOCUMENTATIE.md`
- Developer release and update internals: `DEV-DOCS.md`
