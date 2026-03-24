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
