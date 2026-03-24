# Atlas

Atlas is a desktop app for activity tracking and project-focused time mapping.

It combines:

- Session-based time tracking
- Automatic active-app logging
- Dashboard and logbook insights
- Task boards per map
- Visual notebook (text, post-its, media)
- Mini always-on-top session controls

## Tech Stack

- Electron
- React 19 + TypeScript
- Vite
- Tailwind CSS
- Framer Motion
- sql.js (SQLite in WASM)

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Run in development mode

```bash
npm run dev
```

This starts both:

- Vite renderer dev server
- Electron app shell

### 3. Start Electron without dev server workflow

```bash
npm run start
```

## Scripts

- `npm run dev` - Run renderer + Electron together
- `npm run dev:renderer` - Run only Vite
- `npm run dev:electron` - Run only Electron (after renderer is available)
- `npm run build` - TypeScript build + Vite production build
- `npm run dist` - Build Windows installer using electron-builder
- `npm run dist:portable` - Build portable Windows package
- `npm run lint` - Run ESLint
- `npm run preview` - Preview Vite production build

## Automatic Versioning and Releases

This repository uses a GitHub Actions workflow on every push to `main`:

- Lint and build are executed first.
- A semantic version tag is generated automatically.
- A GitHub Release is created automatically.
- Old releases/tags from older major versions are removed automatically.

Version bump rules are commit-message based:

- `feat:` -> minor bump
- `fix:` and other commits -> patch bump
- `BREAKING CHANGE` or `type(scope)!:` -> major bump

Example:

- New `v2.x.x` release will trigger cleanup of all `v1.x.x` releases/tags.

## Install in 1-2 Clicks (GitHub)

- Latest release page:
    - https://github.com/ntnthefirst/Atlas/releases/latest
- Direct Windows installer download:
    - https://github.com/ntnthefirst/Atlas/releases/latest/download/Atlas-Setup-latest.exe

How it works:

- On every push to `main`, GitHub Actions builds a Windows installer.
- The installer is attached to the new release.
- A stable file name `Atlas-Setup-latest.exe` is uploaded so users always have a single direct link.

## Project Structure

- `src/` - React UI and application state
- `src/components/` - Layout, views, and UI components
- `electron/` - Electron main/preload, DB layer, and activity tracker
- `public/` - Static assets and build resources
- `release/` - Electron builder outputs (ignored in git)

## Local Data

Atlas stores runtime data locally:

- SQLite DB via `sql.js` in Electron userData directory
- UI preferences in browser localStorage

## Notes

- Activity foreground tracking currently targets Windows behavior.
- If you want full internals and feature details, see:
    - `ATLAS_FUNCTIONELE_DOCUMENTATIE.md`
