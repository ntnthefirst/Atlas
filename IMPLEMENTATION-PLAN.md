# Atlas Implementation Plan

How we get from what Atlas is today to what [PRODUCT-VISION.md](PRODUCT-VISION.md) describes.

This document is written to be **delegated**. Every work package is a self-contained brief:
an agent (or a future you who has forgotten this conversation) should be able to pick one
up, read only that section plus the conventions at the top, and execute it.

---

## 1. How to use this document

**If you are an agent picking up a work package:**

1. Read section 3 (Binding decisions), section 5 (Baseline), and section 7 (Conventions).
   These apply to every package and are not repeated in each one.
2. Read only your assigned work package.
3. Check its `Depends on` field. If those packages are not merged, stop and say so.
4. Implement, satisfy every acceptance criterion, open a PR.

**Do not** expand scope beyond your package. If you find something broken that is out of
scope, note it in the PR description and leave it. The plan is sequenced deliberately —
work done early in the wrong order costs more than it saves.

**Sizing unit:** `focused days` = roughly 6 hours of real, uninterrupted work. Not calendar
days. Calendar time depends entirely on the burst pattern (see section 4).

---

## 1b. Status

Last updated: 2026-07-21. Keep this current — it is what a fresh session reads first.

| Package | State |
|---|---|
| WP-0.1 Test harness | **Done.** Vitest + 3-OS CI matrix. |
| WP-0.2 Split main.cjs | **In progress.** 2455 → 1473 lines, 18 modules. Pure config, window geometry, three window factories and six IPC domains extracted. |
| WP-0.3 Database engine swap | **Done.** `node-sqlite3-wasm` (see D9), migration framework, verified legacy import. |
| WP-0.4 Secret vault | **Done.** Keys encrypted, legacy plaintext migrated. |
| WP-0.5 Event log | **Done.** Batched writer, retention, privacy-constrained.  |
| WP-0.6 Platform adapter (Windows) | **Done.** Rescoped by D10; powershell now confined to one file. |
| WP-0.7 maps → environments | **Done.** Migration 002, plus a localStorage key migration. |
| WP-0.8 Scoped data layer | **Done.** Two modes, frozen allowlist, leak-tested. |

**Suite: 504 tests, ~13s.** Verification commands now available:

```
npm test               # 504 unit/integration tests, ~13s
npm run lint           # now covers electron/ and scripts/ too
npm run smoke          # boots the real Electron main process, fails on crash
npm run smoke:windows  # opens every window type, fails if any does not
npm run verify:secrets # runs inside Electron; proves the vault encrypts
```

Run all five before committing anything that touches `electron/`. The two
smoke tests exist because vitest cannot construct a BrowserWindow and cannot
reach `safeStorage` — between them they cover the failure modes unit tests
structurally cannot see.

### WP-0.2: what is left, and the decision waiting to be made

Extracted so far, all **pure** (no shared mutable state), which is why a
mechanical cut-and-verify approach was safe:
`services/version.cjs`, `services/http.cjs`, `config/notch-prefs.cjs`,
`config/dashboard-prefs.cjs`, `config/focus-prefs.cjs`,
`config/update-prefs.cjs`, `config/prefs-utils.cjs`.

Then the **stateful** work began, guarded by the two smoke tests and the IPC
contract test: `windows/notch-geometry.cjs`, the three secondary window
factories (`settings-window`, `action-editor-window`, `notch-input-window`),
and the first three IPC domains (`ipc/tasks`, `ipc/notes`,
`ipc/environments`).

**Still in main.cjs (~1473 lines):**

- `wireIpc` — 45 of the original 72 handlers remain: `window:*`, `notch:*`,
  `focus:*`, `app:*`, `ai:*`, `screen:*`, `system:*`, `notchInput:*` and
  `dashboard:getLayout`/`setLayout`. Extract them domain by domain following
  `ipc/sessions.cjs`: each module exports `register(ipcMain, deps)`.
  **Pass anything reassigned as a getter**, never a value — `db` and
  `tracker` are assigned during `app.whenReady()` (after the modules are
  required, so a value freezes at `null`), and window refs like `miniWindow`
  are reassigned across their lifecycle (so a value goes stale). Plain
  `function` declarations that are never reassigned can be passed directly.
  The remaining domains are more entangled than the ones already done: they
  touch window refs and the focus engine's live runtime.
- `createMainWindow`, `createWelcomeWindow`, `createMiniWindow` — entangled
  with the tray and session lifecycle.
- `syncNotchWindows`, `applyNotchPreferences`, `createNotchWindowForDisplay`,
  `shouldNotchBeActive` — own the `notchWindows` map.
- `ensureTray`, and the focus engine runtime (timers, broadcast).

**The state-sharing question is now decided. Follow this for every window
module.** A shared mutable `registry` module was rejected: it would rewrite
hundreds of references at once for no behavioural gain.

Instead, each factory exports a function that **returns** the created
BrowserWindow, and main.cjs keeps ownership of the reference variables. The
factory receives an explicit dependencies object:

- values it reads at construction time → passed as plain values;
- anything read **later**, inside an event handler (`isQuitting` at close
  time, for instance) → passed as a **getter function**, never a snapshot,
  because capturing the value at construction silently changes behaviour;
- anything that mutates main.cjs state (nulling the ref when a window
  closes) → passed as a callback, e.g. `onClosed`.

If a factory needs more than about six dependencies, or captures state that
does not express cleanly as values/getters/callbacks, **leave it where it
is** and say why. Two clean extractions beat three contorted ones.

`npm run smoke:windows` is the gate that makes this safe — it opens every
window type and fails on any that does not. Do not move a window factory
without running it.

Still, do not start this with a limited context budget: a half-migrated
main.cjs violates D5.

### Known bugs found while testing, deliberately not fixed

Each is pinned by a test asserting the current (wrong) behaviour, so fixing
it means updating that test:

- `reorderTaskIds` (src/utils/taskHelpers.ts) — dragging a task onto itself
  sends it to the end of the list instead of doing nothing.
- `normalizeIdEnabledList` (electron/config/notch-prefs.cjs) — an item
  missing from saved preferences is always re-added as `enabled: true`,
  ignoring its default. Latent until the first off-by-default item ships.
- `clampFocusInt` (electron/config/focus-prefs.cjs) — `null` becomes the
  range minimum rather than the default, so `"focusMinutes": null` yields a
  1-minute Pomodoro instead of 25.

---

## 2. What we are building

A personal adaptive layer between the user and their computer, made of:

- **The Notch** — the always-available primary interface, and a real launcher.
- **Environments** — user-created contexts that own their own config, data, and isolation.
- **The Findings engine** — behavioural pattern detection that proposes automations.
- **Smart Functions** — trigger→action rules, created by the user or by AI.
- **An AI layer** — assistive, scoped per environment, cloud-backed today.
- **Integrations + MCP** — Atlas as a bridge between AI systems and the user's computer.

Time tracking — the whole of Atlas today — becomes **one module inside this**, not the
headline. See decision D2.

---

## 3. Binding decisions

These were decided up front. They are constraints, not suggestions. If a work package
seems to conflict with one, the decision wins and the package is wrong.

| # | Decision | Consequence for the plan |
|---|---|---|
| ~~**D1**~~ | ~~Windows and macOS in parallel.~~ | **SUPERSEDED BY D10.** |
| **D10** | **Windows only, for now.** | No macOS implementation is written, tested, or claimed. OS-touching packages ship a Windows implementation behind a platform abstraction, plus a fallback that reports `unsupported` — never fake data. macOS becomes a later package that fills in one file per adapter, not a rewrite. |
| **D2** | **Atlas evolves; tracking becomes one module.** | Sessions, logbook, notebook, and task boards are preserved and reframed. `maps` become `environments`. The dashboard becomes the Statistics surface. No feature deletion. |
| **D3** | **Real users exist; data must migrate cleanly.** | Every schema change needs a versioned, tested, reversible migration. Never ship a change that silently drops user data. Back up before migrating. |
| **D9** | **Database engine is `node-sqlite3-wasm`, not `better-sqlite3`.** | Superseded the original WP-0.3 choice. See "D9 in detail" below — this changes how writes must be issued. |
| **D4** | **The macro recorder is cut.** | No global input hooks, no native recorder, nothing in the plan. Smart Functions plus findings-generated automations cover the overlapping need. If this is ever revisited it is a new plan, not a phase here. |
| **D5** | **Bursty schedule — heavy periods, then gaps.** | *The most structurally important decision here.* Every work package must leave `main` shippable. No long-lived refactor branches, no "half-migrated" states that span a gap. Packages are sized to fit inside one burst. |
| **D6** | **Local LLM deferred.** | Keep the existing 3-provider cloud setup. Extend `smartParse.ts` as the on-device layer. Design the provider interface so a local model slots in later without redesign — but do not bundle one. |
| **D7** | **Full file index from the start.** | The launcher gets a real crawler, watcher, and ranked index on both OSes. This is the single most expensive choice made — see the risk note in section 4. |
| **D8** | **Plan is written as self-contained work packages.** | This document. Keep it that way when adding packages. |

### D9 in detail: why the database engine changed

`better-sqlite3` is a native module and **cannot be built on the developer
machine**: Visual Studio 2026 is installed without the VC++ toolset, and no
prebuilt binary exists for Electron 41's ABI. Both `npm install` and
`@electron/rebuild` fail. Fixing that means a multi-GB Visual Studio workload
install, and it would leave a permanent native-build burden on CI, on
packaging, and on every future Electron upgrade — the plan's own risk register
rated that failure "High likelihood, blocks Phase 0". It then happened.

`node-sqlite3-wasm` is real SQLite with a filesystem VFS. It writes only
changed pages, which is the actual requirement, and needs no compiler on any
platform.

**Measured, not assumed** (10k rows unless stated):

| | per write |
|---|---|
| WASM, batched in one transaction | **0.016ms** |
| WASM, unbatched, `synchronous=NORMAL` | **12.7ms** |
| WASM, unbatched, `synchronous=OFF` | 1.9ms — *rejected, risks corruption* |
| sql.js today, empty database | 1.1ms |
| sql.js today, 80k rows | 4.3ms, **rewriting 4.5 MB per write** |

**The consequence, which every future package must respect:** WASM SQLite is
~800× faster batched than unbatched. A single write per user action (~13ms) is
imperceptible and fine. Anything writing in bulk — the event log (WP-0.5)
above all — **must** wrap its writes in a transaction, or it will be far
slower than the sql.js it replaced. Multi-statement operations like
`deleteMap` are wrapped for the same reason, which also fixes a pre-existing
atomicity bug where a crash midway left orphaned rows.

Settings: `synchronous = NORMAL`. Not `OFF` — the speed is tempting and the
corruption risk is not acceptable for user data.

**WAL is not available.** `node-sqlite3-wasm`'s VFS accepts the pragma but
`journal_mode` still reports `delete`; its WASM VFS has no shared-memory
backing for WAL's coordination file. The plan's original "enable WAL"
criterion therefore **cannot be met** with this engine. Atlas is
single-process, so the practical cost is low, but do not write code that
assumes WAL's concurrent-reader semantics.

**Where the databases actually live** — this cost real debugging time, so it
is written down: production uses `%APPDATA%/Atlas`, the dev build uses
`%APPDATA%/Atlas-Dev`. They are separate. `npm run smoke` therefore never
touches real user data, which is exactly what you want, but it also means a
migration verified in dev has not been proven against a production database.
The legacy import was additionally verified by hand against a copy of the
real 4.27MB production database: six tables, 16,269 activity blocks and 65
sessions, all preserved with identical counts and `integrity_check` ok.

### A tension worth naming

**D7 + D5 pull against each other** (D1 no longer applies — see D10). A cross-platform file indexer is the most
OS-specific, most performance-sensitive subsystem in the plan, and D5 says nothing may sit
half-finished across a gap. Phase 2 is therefore deliberately sliced so the launcher is
useful and shippable *before* the indexer exists (WP-2.1 → 2.4, 2.9), and the indexer
itself lands in three independently-shippable pieces (WP-2.5 → 2.7). If appetite runs out
mid-Phase-2, you still have a working launcher rather than a broken one.

---

### A note on macOS (D10)

Atlas currently publishes a macOS DMG whose core feature does nothing: the activity
tracker returns `"Unknown"` for any non-Windows platform. With macOS out of scope, that
installer is shipping a promise the build cannot keep.

**Recommended, not yet done** (it touches the release pipeline and existing Mac users'
update path, so it needs a deliberate decision): either stop publishing the macOS target
in `.github/workflows/`, or label it clearly as unsupported on the releases page. Leaving
it as-is is the one option that actively misleads people.

The 3-OS CI test matrix is worth keeping regardless — it runs the unit suite on macOS and
Linux, costs nothing meaningful, and catches path-handling bugs (the temp-file database
tests especially) long before anyone tries to support those platforms properly.

---

## 4. Sizing

| Phase | Focused days | Shippable outcome |
|---|---|---|
| 0 — Foundation | 40–50 | Same app, on a foundation that can carry the rest |
| 1 — Environments | 20–25 | Environments are real, isolation works |
| 2 — Launcher Notch | 50–65 | The Notch is genuinely a launcher |
| 3 — Findings + Smart Functions | 35–45 | Atlas proposes automations |
| 4 — AI + MCP | 25–30 | AI can act on the system, scoped |
| 5 — Integrations | 30–40 | Framework + first four services |
| 6 — Statistics, privacy, plugins | 20–25 | Insight surfaces and a public plugin API |
| **Total** | **220–280** | |

Translation, roughly:

- Full-time (5 focused days/week): **11–14 months**
- 20–30 hrs/week (3 focused days/week): **18–23 months**
- 10–15 hrs/week (1.5 focused days/week): **3+ years**

**The honest read for a bursty schedule:** do not plan the whole thing. Plan Phase 0 and 1
(60–75 focused days). That is the work that makes everything after it possible and is the
work that gets more expensive the longer it is deferred. Reassess from there.

**Phases 0 and 1 are mandatory and ordered.** Phases 2–6 can be reordered or dropped
individually once 0 and 1 are merged.

---

## 5. Baseline: where Atlas actually is

Verified against the repo, not assumed. Line references are the state at time of writing.

**Stack:** Electron 41, React 19, TypeScript 5.9, Vite 8, Tailwind 4, framer-motion,
`sql.js` (WASM SQLite). ~19k lines total, ~90 commits, first commit 2026-03-24.

**What exists and is good:**

| Area | Where | State |
|---|---|---|
| Notch shell | [NotchApp.tsx](src/components/notch/NotchApp.tsx) (1,821 lines) | 59 widget types, grid placement, positions, idle opacity, click-through. Substantial. |
| Notch config UI | [NotchTabGridEditor.tsx](src/components/settings-window/NotchTabGridEditor.tsx) (1,104) | Full visual editor for tabs and widget grids. |
| Scenes | [scenes.ts](src/scenes.ts) | One-click batch: apps + URLs + timer + environment + tasks. **This is the manual half of Smart Functions, already built.** |
| Environments | `maps` table | id, name, created_at, icon, accent, preset. Presets in [environments.tsx](src/environments.tsx). |
| Activity tracking | [activity-tracker.cjs](electron/activity-tracker.cjs) | Foreground window poll every 1500ms. **Windows only.** |
| On-device parsing | [smartParse.ts](src/utils/smartParse.ts) (343) | Deterministic offline capture router. Explicitly designed for a local model to slot in behind `parseCapture`. |
| AI | [ai.cjs](electron/ai.cjs) (233) | Anthropic / Google / OpenAI. Keys held in main process, never in renderer. |
| Windows | [main.cjs](electron/main.cjs) (2,455) | 7 `BrowserWindow` creations: main, notch, mini, settings, action editor, notch input. |
| Release | `.github/workflows/` | Auto-versioning, label-gated PRs, stable + beta channels, Win/mac installers, in-app update. Mature. |

**Schema today** (`maps`, `sessions`, `pauses`, `activity_blocks`, `tasks`, `notes`) — see
[db.cjs](electron/db.cjs).

**What is missing or broken — the things this plan exists to fix:**

1. **No tests. None.** No test files, no vitest/jest/playwright, no `test` script. Every
   change is currently verified by hand. This blocks safe delegation entirely.
2. **The database cannot carry an event stream.** [db.cjs:95](electron/db.cjs:95) —
   `persist()` calls `db.export()` and rewrites the *entire* database file on *every
   write*. Fine at current volume. Fatal for behavioural logging.
3. **`main.cjs` is 2,455 lines with ~75 IPC handlers.** Two agents cannot work in this file
   without conflicting. It is the main obstacle to parallel delegation.
4. **API keys are stored in plaintext.** [ai.cjs:77](electron/ai.cjs:77) writes
   `ai-preferences.json` with raw `apiKey` values into userData. This contradicts the
   "encrypted storage" principle in the vision doc.
5. **macOS is published but not supported.** The tracker returns `"Unknown"` for any
   non-win32 platform ([activity-tracker.cjs:99](electron/activity-tracker.cjs:99)); only
   two `darwin` branches exist in the whole electron folder. A DMG ships regardless.
6. **No event log**, no scoping model, no permission model, no secret vault, no launcher
   input, no indexer, no integration framework.

---

## 6. Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│ RENDERER (React)                                             │
│  Notch  ·  Main app  ·  Settings  ·  Launcher  ·  Editors    │
└───────────────────────────┬──────────────────────────────────┘
                            │ preload bridge (window.atlas)
┌───────────────────────────┴──────────────────────────────────┐
│ MAIN PROCESS — modular services                              │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐            │
│  │ Windows    │  │ Launcher   │  │ Integrations │            │
│  │ service    │  │ providers  │  │ + OAuth      │            │
│  └────────────┘  └─────┬──────┘  └──────────────┘            │
│  ┌────────────┐  ┌─────┴──────┐  ┌──────────────┐            │
│  │ Platform   │  │ File index │  │ AI + MCP     │            │
│  │ adapters   │  │ + watcher  │  │ providers    │            │
│  │ (win/mac)  │  └────────────┘  └──────────────┘            │
│  └─────┬──────┘                                              │
│        │           ┌──────────────┐  ┌──────────────┐        │
│        └──────────▶│ Event log    │─▶│ Findings     │        │
│                    │ (batched)    │  │ miner        │        │
│                    └──────┬───────┘  └──────┬───────┘        │
│                           │                 ▼                │
│                           │          ┌──────────────┐        │
│                           │          │ Smart        │        │
│                           │          │ Functions    │        │
│                           │          └──────────────┘        │
│  ┌────────────────────────┴─────────────────────────┐        │
│  │ SCOPED DATA LAYER  — every read/write carries an │        │
│  │ environment id and an isolation mode             │        │
│  └────────────────────────┬─────────────────────────┘        │
│  ┌──────────────┐  ┌──────┴───────┐  ┌──────────────┐        │
│  │ Secret vault │  │ better-sqlite3│  │ Migrations  │        │
│  │ (safeStorage)│  │               │  │ (versioned) │        │
│  └──────────────┘  └───────────────┘  └─────────────┘        │
└──────────────────────────────────────────────────────────────┘
```

**The load-bearing idea:** the *scoped data layer* sits under everything. Isolation is
enforced once, at the data boundary — never re-implemented per feature. This is why
WP-0.8 must land before Phases 2–6, and why retrofitting it later would be a rewrite.

---

## 7. Conventions for every work package

**Branching and PRs**
- Branch from `dev`. Name it `<type>/<wp-id>-<slug>`, e.g. `refactor/wp-0-2-split-main`.
- PRs target `dev`. Only `dev` → `main` PRs need release labels (see [DEV-DOCS.md](DEV-DOCS.md)).
- PRs to `main` require **exactly one** of `release:patch` / `release:minor` /
  `release:major`. The CI guard will reject otherwise.

**Commits**
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- These drive auto-versioning. `feat:` → minor, `!`/`BREAKING CHANGE` → major.
- Reference the package: `refactor(wp-0.2): split main.cjs into service modules`.

**Definition of done — all of these, every package**
- [ ] Every acceptance criterion in the package is met.
- [ ] `npm run lint` and `npm run build` pass.
- [ ] `npm test` passes (once WP-0.1 lands).
- [ ] Works on Windows. macOS is out of scope (D10) — do not write untested macOS
      code, but do keep OS-specific work behind a platform adapter so adding it
      later is filling in a file rather than unpicking the codebase.
- [ ] Any schema change has a versioned, reversible, tested migration (D3).
- [ ] `main` remains shippable — no half-migrated state (D5).
- [ ] No plaintext secrets written to disk.

**Code style**
- Match surrounding code. Tabs, existing naming, existing comment density.
- The codebase comments the *why* above non-obvious blocks — see the header comments in
  [smartParse.ts](src/utils/smartParse.ts) and [scenes.ts](src/scenes.ts). Match that.
- Main-process files are CommonJS `.cjs`. Renderer is ESM TypeScript. Do not mix.

**Platform work**
- Never call `powershell.exe` inline from feature code. Go through a platform adapter
  (WP-0.6 establishes the pattern).
- Every adapter has a Windows implementation, a macOS implementation, and a safe fallback.

---

# PHASE 0 — Foundation

**40–50 focused days. Mandatory. Ordered.**

Nothing here is user-visible. Everything here is the reason the rest is possible. If you
only ever do one phase, do this one — it is also the phase that gets most expensive to
defer.

---

### WP-0.1 — Test harness

**Size:** 4–5 days · **Depends on:** nothing · **Platform:** n/a

**Goal:** `npm test` exists, runs fast, runs in CI, and can prove a change didn't break
anything.

**Why first:** there are zero tests today. Every subsequent package in this plan has
acceptance criteria that assume tests can verify them. Delegating work without this means
trusting agent output blind.

**Approach**
- Vitest for renderer + shared TypeScript. Node environment for `.cjs` main-process code.
- Seed with real coverage of the pure logic that already exists and is easy to test:
  `smartParse.ts` (richest target — it's deterministic and has a clear contract),
  `scenes.ts` parse/serialize round-trips, `taskHelpers.ts`, `formatters.ts`,
  `sessionHelpers.ts`, `accent.ts`.
- A `db.cjs` test that opens a temp database, runs the schema, and exercises CRUD.
- Add a `test` job to the existing CI quality gate.

**Files:** `vitest.config.ts` (new), `package.json`, `src/**/*.test.ts` (new),
`electron/*.test.cjs` (new), `.github/workflows/` (extend existing gate).

**Acceptance criteria**
- [ ] `npm test` runs and passes locally on Windows and macOS.
- [ ] ≥ 30 meaningful assertions across ≥ 5 modules — not placeholder tests.
- [ ] `smartParse.ts` covered for: task vs note routing, priority, due dates, tags,
      environment targeting, column resolution.
- [ ] DB test creates a temp file, does not touch the user's real database.
- [ ] CI fails the build when a test fails (verify by pushing a deliberate failure once).
- [ ] Full suite runs in under 30 seconds.

**Gotchas:** do not try to E2E-test Electron here. That is a later, separate concern. Unit
and integration coverage of pure logic is the goal.

---

### WP-0.2 — Split `main.cjs` into service modules

**Size:** 5–6 days · **Depends on:** WP-0.1 · **Platform:** n/a

**Goal:** `electron/main.cjs` becomes a thin bootstrap. Its ~75 IPC handlers and 7 window
definitions move into focused modules. **Zero behaviour change.**

**Why now:** at 2,455 lines this file is the hard blocker on parallel delegation — two
agents touching it will conflict every time. Almost every later package adds handlers here.

**Approach**

Suggested layout (adjust if the code argues otherwise):

```
electron/
  main.cjs                 ← bootstrap + app lifecycle only, target < 200 lines
  windows/                 ← one module per window (main, notch, mini, settings,
                             action-editor, notch-input) + shared window helpers
  ipc/                     ← handlers grouped by domain: environments, sessions,
                             tasks, notes, notebook, notch, focus, dashboard,
                             system, updates, ai
  services/                ← tracker, focus timer, updater, system-info
```

Move in small commits, one domain at a time, verifying the app boots between each. Do not
rename handler channel strings — the renderer and preload depend on them.

**Files:** all of `electron/`, `electron/preload.cjs` (imports only).

**Acceptance criteria**
- [ ] `main.cjs` under 250 lines.
- [ ] No IPC channel string changed — verified by diffing the channel list before/after.
- [ ] App boots; all 7 windows open; timer, tasks, notes, notebook, settings, updates all
      work by manual pass.
- [ ] `npm test` and `npm run lint` pass.
- [ ] No file in `electron/` over 400 lines afterwards.

**Gotchas:** this is a pure refactor and must stay one. Resist fixing anything you find —
note it in the PR instead. A behaviour change hidden inside a 2,000-line move is
effectively undebuggable.

---

### WP-0.3 — Database engine swap + migration framework

**Size:** 6–8 days · **Depends on:** WP-0.1, WP-0.2 · **Platform:** Win + macOS

**Goal:** replace `sql.js` with `better-sqlite3`, and add a versioned migration system.

**Why now:** [db.cjs:95](electron/db.cjs:95) exports and rewrites the entire database on
every single write. The event log (WP-0.5) writes continuously. This must change before
that exists, and it gets harder with every feature that depends on the current write path.

**Approach**
- Add `better-sqlite3`. It is a native module: `electron-rebuild` must run for both
  platforms, and the CI build matrix needs updating. Budget real time for this — it is the
  most likely source of trouble in the package.
- Introduce a `schema_migrations` table. Each migration: `up`, `down`, version number,
  checksum.
- Convert the existing implicit schema in `db.cjs` into migration `001_initial`.
- **The user-data migration (D3):** on first launch of the new version, detect the old
  `sql.js` file, back it up alongside with a timestamped name, import it, verify row counts
  per table, and only then swap. On any mismatch, abort and keep the old file.
- Remove `persist()` entirely — `better-sqlite3` writes through.
- Enable WAL mode.

**Files:** `electron/db.cjs`, `electron/migrations/` (new), `package.json`,
`.github/workflows/`, `electron/services/`.

**Acceptance criteria**
- [ ] All existing queries work unchanged from the caller's perspective.
- [ ] `persist()` is gone; no full-file rewrites remain.
- [ ] Migration runner applies pending migrations on boot, in order, idempotently.
- [ ] A test proves an old `sql.js` database migrates with **identical row counts** in
      every table.
- [ ] A backup of the pre-migration file exists after upgrade.
- [ ] Corrupt/partial old database → app starts, does not migrate, surfaces a clear error,
      original file untouched.
- [ ] Native module builds in CI for Windows and macOS; both installers produced.
- [ ] Write throughput: 10,000 inserts in under 2 seconds (regression guard for WP-0.5).

**Gotchas:** native modules and Electron version mismatches are the classic packaging
failure. Verify the *packaged* installer on both platforms, not just `npm run dev`.

---

### WP-0.4 — Encrypted secret vault

**Size:** 2–3 days · **Depends on:** WP-0.2 · **Platform:** Win + macOS

**Goal:** no secret is ever written to disk in plaintext.

**Why now:** [ai.cjs:77](electron/ai.cjs:77) writes raw API keys into
`ai-preferences.json`. Phase 5 adds OAuth tokens for a dozen services on top. Fix the
pattern before multiplying it.

**Approach**
- Wrap Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS) in a small
  `secrets` service: `set(key, value)`, `get(key)`, `delete(key)`, `has(key)`.
- Migrate existing plaintext keys transparently on first run, then overwrite the plaintext
  file.
- Handle `safeStorage.isEncryptionAvailable() === false` explicitly: refuse to store, tell
  the user why. Never silently fall back to plaintext.
- Keep the existing renderer contract — the renderer still only ever learns `hasKey`.

**Files:** `electron/services/secrets.cjs` (new), `electron/ai.cjs`.

**Acceptance criteria**
- [ ] `ai-preferences.json` contains no raw key material after upgrade.
- [ ] Existing users' configured keys still work with no re-entry.
- [ ] Encryption unavailable → clear error, nothing written.
- [ ] The renderer still never receives a key value (verify by grepping the IPC surface).
- [ ] Works on both platforms against the real OS keystore.

---

### WP-0.5 — Event log

**Size:** 5–6 days · **Depends on:** WP-0.3 · **Platform:** n/a

**Goal:** a single, batched, queryable, bounded stream of everything the user does. This is
the substrate the entire findings engine reads from.

**Why now:** it is the one genuinely new primitive in the architecture, and Phase 3 is
impossible without it. It should start collecting data as early as possible — a findings
engine with six months of history behind it is dramatically better than one starting cold.

**Approach**
- Table: `id`, `ts`, `environment_id`, `type`, `subject`, `payload` (JSON), `session_id`.
- Event types to start: `app.focus`, `app.blur`, `session.start/stop/pause`,
  `task.create/complete`, `note.create`, `scene.run`, `environment.switch`,
  `launcher.query`, `launcher.execute`.
- **Batched writer.** Buffer in memory, flush on a timer (~5s) and on app quit. Never write
  per event synchronously — this is what WP-0.3 was for, don't waste it.
- Retention policy from day one: configurable window (default 90 days), plus a hard row
  cap. Prune on boot. The vision explicitly promises not to hoard data.
- Query helpers the miner will need: by time range, by type, by environment, sequences
  within a time window.

**Files:** `electron/services/event-log.cjs` (new), `electron/migrations/`,
call sites across `electron/ipc/`.

**Acceptance criteria**
- [ ] Events written from every listed source.
- [ ] Batching verified: 1,000 events produce far fewer than 1,000 disk writes.
- [ ] Nothing is lost on clean quit (flush on `before-quit`).
- [ ] Retention prunes correctly; a test seeds 100k events and verifies the cap.
- [ ] Every event carries an `environment_id` (or an explicit global marker).
- [ ] Query helpers covered by tests.
- [ ] Measured overhead under 1% CPU during normal use.

**Gotchas:** be conservative about what gets logged. This file is the most privacy-sensitive
thing Atlas will ever write. No window titles containing content, no keystrokes, no
clipboard. App identity and coarse action types only.

---

### WP-0.6 — Platform adapter (Windows)

**Size:** 3–4 days · **Depends on:** WP-0.2 · **Platform:** Windows only (D10)

**Goal:** one interface for every OS-level query, with a Windows implementation behind it
and an honest `unsupported` fallback everywhere else.

**Why now:** OS access is currently an inline PowerShell string inside
`activity-tracker.cjs`. Every later package — the launcher, the app index, the file
indexer, context detection — needs the same access, and none of them should each grow
their own `execFile("powershell.exe", ...)`. The abstraction is worth building for that
reason alone, independently of which platforms exist.

**Scope changed by D10.** This was originally "make macOS work too". It is now "put the
seam in place". No macOS code is written. The value is that adding macOS later means
implementing one file against a settled interface, rather than unpicking PowerShell calls
scattered through feature code.

**Approach**
- Interface: `getForegroundWindow()`, `listRunningApps()`, `listInstalledApps()`,
  `getSystemStats()`, `launch(target)`.
- Windows: move the existing PowerShell approach behind the adapter unchanged. Note in the
  PR whether the 1500ms spawn cost justifies a native module later.
- Fallback: returns an explicit `unsupported` result, never fake data. Today
  `activity-tracker.cjs` returns the string `"Unknown"` on any non-Windows platform, which
  is indistinguishable from a real app named Unknown — that is the anti-pattern to remove.
- Callers must handle `unsupported` explicitly rather than treating it as a value.
- Rewire `activity-tracker.cjs` and `system-info.cjs` to consume the adapter.

**Files:** `electron/platform/index.cjs`, `electron/platform/win32.cjs`,
`electron/platform/unsupported.cjs` (all new), `electron/activity-tracker.cjs`,
`electron/system-info.cjs`.

**Acceptance criteria**
- [ ] No `powershell.exe` call anywhere outside `platform/win32.cjs`.
- [ ] Foreground tracking still works on Windows, verified by a real session producing
      correct activity blocks — this is a refactor and must not regress it.
- [ ] The fallback returns `unsupported`; no code path invents `"Unknown"`.
- [ ] Every caller handles `unsupported` explicitly.
- [ ] Tracker polling cost measured and recorded in the PR.
- [ ] The interface is documented well enough that a macOS implementation is a
      fill-in-the-blanks job.

**Gotchas:** the 1500ms PowerShell spawn is already meaningful overhead — measure before
and after so the refactor is not quietly making it worse.

---

### WP-0.7 — `maps` → `environments`

**Size:** 3–4 days · **Depends on:** WP-0.3 · **Platform:** n/a

**Goal:** the domain language matches the product. `maps` becomes `environments`
everywhere — schema, IPC, types, UI copy.

**Why now:** mechanical, touches everything, and every day of delay adds call sites. Do it
while the surface is small.

**Approach**
- Migration renames the table and updates foreign keys.
- Rename IPC channels `map:*` → `environment:*`. This is a breaking bridge change — update
  preload and every renderer call site in the same PR.
- `MapItem` → `Environment` in [types.ts](src/types.ts); `AtlasMapMenu.tsx` → environment
  naming; `mapId` → `environmentId` throughout.
- Update user-facing copy.

**Files:** `electron/migrations/`, `electron/db.cjs`, `electron/ipc/`,
`electron/preload.cjs`, `src/types.ts`, `src/App.tsx`, `src/components/**`, `src/hooks/**`,
`src/utils/smartParse.ts`.

**Acceptance criteria**
- [ ] No `map`/`mapId` identifiers remain for this concept (grep clean, allowing for
      genuinely unrelated uses).
- [ ] Migration preserves every row and relationship; test asserts counts before/after.
- [ ] App works end to end after migration on an existing database.
- [ ] `npm test` passes.

**Gotchas:** `scenes.ts` stores `environmentId` inside a JSON config string, and
`smartParse.ts` resolves environments by name. Both need attention — a blind
find-and-replace will miss the JSON payloads.

---

### WP-0.8 — Scoped data layer and isolation model

**Size:** 8–10 days · **Depends on:** WP-0.5, WP-0.7 · **Platform:** n/a

**Goal:** every read and write goes through a layer that knows which environment it belongs
to and enforces that environment's isolation mode. **The single most important package in
this plan.**

**Why now:** this is the landmine. Isolation enforced at the data boundary is one package.
Isolation retrofitted across a dozen finished features is a rewrite. Everything in Phases
2–6 writes data, so this must precede all of it.

**Approach**
- Add `isolation_mode` to `environments`: `connected` | `enclosed` (default `connected`).
- Introduce a scoped accessor: all domain queries go through
  `scoped(environmentId).tasks.list()` rather than raw SQL at call sites.
- Enforcement rules:
  - **Connected** — the environment reads its own data, plus *derived, non-sensitive*
    global signals (behavioural patterns, frecency rankings). Never raw content from
    another environment.
  - **Enclosed** — total isolation. AI memory, findings, indexed files, connected
    accounts, documents, and activity history are all invisible from outside, and this
    environment sees nothing global.
- Define "derived, non-sensitive" **explicitly in code**, as an allowlist. Not a convention,
  not a comment — a list a test can assert against.
- Every cross-environment read is a deliberate, named, logged operation.

**Files:** `electron/data/scoped.cjs` (new), `electron/data/isolation.cjs` (new),
`electron/db.cjs`, all of `electron/ipc/`, `electron/migrations/`.

**Acceptance criteria**
- [ ] No IPC handler issues raw SQL for scoped entities; all go through the accessor.
- [ ] Test: an enclosed environment's tasks, notes, events, and findings are unreachable
      from any other environment, through every code path.
- [ ] Test: a connected environment can read allowlisted derived signals and *nothing* else
      cross-environment.
- [ ] The allowlist is a single exported constant with a test asserting its exact contents
      — so widening it is always a deliberate, reviewable act.
- [ ] Switching an environment to enclosed immediately stops cross-environment reads.
- [ ] Existing data lands in `connected` mode with no behaviour change for current users.

**Gotchas:** the temptation is to make this flexible and configurable. Don't. Two modes,
enforced strictly. Ambiguity in an isolation model is indistinguishable from a bug, and
users cannot verify a promise you have not made precisely.

---

# PHASE 1 — Environments become first-class

**20–25 focused days.** First phase with visible user value.

---

### WP-1.1 — Environment configuration model

**Size:** 4–5 days · **Depends on:** WP-0.8

**Goal:** an environment owns its own settings — not just an icon and an accent.

**Approach:** a versioned JSON config per environment covering theme/accent, Notch layout
reference, default AI provider and system prompt, integration enablement, isolation mode,
and startup behaviour. Parse defensively with fallbacks, exactly as
[scenes.ts](src/scenes.ts) does with `parseSceneConfig` — follow that pattern.

**Acceptance criteria**
- [ ] Config persists per environment and survives restart.
- [ ] Malformed or partial config falls back to defaults without crashing.
- [ ] Config is versioned with an upgrade path.
- [ ] Existing environments get sensible defaults from their current icon/accent/preset.

---

### WP-1.2 — Isolation enforcement UI

**Size:** 3–4 days · **Depends on:** WP-1.1

**Goal:** the user can see and control what an environment can reach.

**Approach:** a Connected/Enclosed toggle with a plain-language explanation of exactly what
each mode shares. Show what *is* currently shared. Warn on switching enclosed → connected
(it widens exposure), and confirm on connected → enclosed (features will go quiet).

**Acceptance criteria**
- [ ] Mode is switchable per environment and takes effect immediately.
- [ ] The UI states precisely what is shared in connected mode, matching the WP-0.8
      allowlist — ideally rendered *from* it, so they cannot drift.
- [ ] Both transitions are explained before they happen.

---

### WP-1.3 — Per-environment Notch layout

**Size:** 5–6 days · **Depends on:** WP-1.1

**Goal:** switching environment changes the Notch.

**Approach:** Notch preferences move from global to per-environment, with a global default
to inherit from. Existing global prefs become that default, so nobody loses their setup.
Extend the existing editors in `settings-window/` rather than building new ones.

**Acceptance criteria**
- [ ] Each environment can have its own tabs and widget grid.
- [ ] Environments without an override inherit the default.
- [ ] Existing users' current Notch config becomes the default, unchanged.
- [ ] Switching environments visibly re-renders the Notch without a restart.

---

### WP-1.4 — Environment switching

**Size:** 4–5 days · **Depends on:** WP-1.3

**Goal:** switching is instant, available everywhere, and observable to the rest of the
system.

**Approach:** switch from the Notch, the main app, and a global hotkey. Emit an
`environment.switch` event (WP-0.5). Apply theme, accent, Notch layout, and AI config
atomically — no visible half-switched state.

**Acceptance criteria**
- [ ] Switch completes in under 200ms perceived.
- [ ] Theme, accent, Notch layout, and AI config all change together.
- [ ] Global hotkey works on both platforms, and is rebindable.
- [ ] Event emitted with previous and next environment.

---

### WP-1.5 — Environment management surface

**Size:** 4–5 days · **Depends on:** WP-1.2

**Goal:** the main app becomes the place environments are built.

**Approach:** create, edit, duplicate, archive, delete. Extend the existing preset templates
in [environments.tsx](src/environments.tsx). Deletion must be explicit about what it
destroys and require confirmation proportional to the loss.

**Acceptance criteria**
- [ ] Full lifecycle works, including duplicate-with-config.
- [ ] Deleting an environment states exactly what will be destroyed, with counts.
- [ ] Archived environments are hidden from switching but retain their data.

---

# PHASE 2 — The Notch becomes a launcher

**50–65 focused days.** The largest phase, and the one users will feel most.

Sliced so WP-2.1 → 2.4 and 2.9 deliver a genuinely useful launcher *before* the indexer
exists. If Phase 2 stalls, it stalls somewhere shippable (see D5/D7 tension, section 3).

---

### WP-2.1 — Launcher input surface

**Size:** 5–6 days · **Depends on:** WP-1.4

**Goal:** a fast, keyboard-first input on the Notch with a global hotkey.

**Approach:** extend the existing `NotchInputWindowApp` rather than starting fresh. Full
keyboard navigation, no mouse required. Sub-50ms open. Debounced querying, cancellable
in-flight searches, and a stable result list that doesn't reorder under the cursor while
the user is arrowing through it.

**Acceptance criteria**
- [ ] Global hotkey opens it from anywhere on both platforms, rebindable.
- [ ] Opens in under 50ms measured.
- [ ] Full keyboard control including Esc, arrows, Enter, and modifier-actions.
- [ ] Results never reorder under an active selection.
- [ ] Query and execution emit events (WP-0.5).

---

### WP-2.2 — Result provider architecture

**Size:** 4–5 days · **Depends on:** WP-2.1

**Goal:** one interface every result source implements, with unified ranking.

**Approach:** providers declare a name, a match function, and an execute function, and are
registered centrally. Providers run in parallel with individual timeouts — one slow
provider must never block the list. Ranking blends match quality with **frecency** (per
environment, using the event log). Results are environment-scoped through WP-0.8.

**Acceptance criteria**
- [ ] Adding a provider requires no changes to launcher core.
- [ ] A provider that hangs is dropped after its timeout; others still render.
- [ ] Frecency demonstrably promotes repeatedly-chosen results.
- [ ] Ranking is unit-tested with fixed inputs.

---

### WP-2.3 — In-app data provider

**Size:** 3–4 days · **Depends on:** WP-2.2

**Goal:** search everything Atlas already knows — no new infrastructure.

**Approach:** tasks, notes, environments, scenes, sessions, all straight from SQLite. This
is the cheapest real value in the whole phase.

**Acceptance criteria**
- [ ] All listed entity types are searchable and openable.
- [ ] Results respect environment scoping.
- [ ] Under 30ms for a typical database.

---

### WP-2.4 — Installed application provider

**Size:** 5–6 days · **Depends on:** WP-2.2, WP-0.6 · **Platform:** Win + macOS

**Goal:** launch any installed app by typing its name.

**Approach:** Windows — Start Menu shortcuts plus registry uninstall keys. macOS —
`/Applications`, `~/Applications`, and system paths via LaunchServices. Cache the list,
refresh in the background and on install events. Extract icons (there is already an
`app:getFileIcon` handler to build on).

**Acceptance criteria**
- [ ] Finds the large majority of installed apps on both platforms.
- [ ] Icons render in results.
- [ ] Newly installed apps appear without a restart.
- [ ] Enumeration does not block startup.

---

### WP-2.5 — File index: crawler and store

**Size:** 8–10 days · **Depends on:** WP-2.2 · **Platform:** Win + macOS

**Goal:** a queryable index of the user's files. **The most expensive package in the plan.**

**Approach**
- User-configured roots, with sensible defaults (home, documents, projects) and a clear
  exclusion list (`node_modules`, `.git`, caches, system directories).
- Store path, name, extension, size, mtime, and an environment association where one can be
  inferred.
- SQLite FTS5 for name matching. **Filename and metadata only — no content indexing.** That
  is a separate, much larger problem, and not what the vision asks for.
- Crawl in a worker so the UI never blocks. Throttle aggressively. Respect battery state.
- Show real progress — first crawl on a large home directory takes minutes and silence
  reads as a hang.

**Acceptance criteria**
- [ ] Initial crawl of a 100k-file tree completes without blocking the UI.
- [ ] Query latency under 50ms at 100k files.
- [ ] Exclusions honoured; index size stays proportionate.
- [ ] Progress is visible and the crawl is cancellable.
- [ ] Roots configurable per platform with correct default paths.
- [ ] Enclosed environments never surface files from other environments' roots.

**Gotchas:** the crawl is where users' laptops get hot and loud. Throttling is a feature,
not a polish item. Budget real time for tuning it.

---

### WP-2.6 — File index: watcher

**Size:** 5–6 days · **Depends on:** WP-2.5 · **Platform:** Win + macOS

**Goal:** the index stays current without re-crawling.

**Approach:** `ReadDirectoryChangesW` on Windows, FSEvents on macOS, via `chokidar` if its
overhead proves acceptable at scale — measure before committing. Debounce bursts (a `git
checkout` or an `npm install` can emit tens of thousands of events). Fall back to periodic
re-crawl if the watcher fails.

**Acceptance criteria**
- [ ] Create, modify, delete, and rename all reflected within 5 seconds.
- [ ] A 10k-file burst does not spike CPU or lose events.
- [ ] Watcher failure degrades to periodic re-crawl rather than a stale index.
- [ ] Handle limits respected on both platforms.

---

### WP-2.7 — File index: ranking and filters

**Size:** 4–5 days · **Depends on:** WP-2.6

**Goal:** the right file is first, not merely present.

**Approach:** blend fuzzy name match, recency, frecency, path depth, and environment
association. Support filters (`ext:pdf`, `in:project`). Tune against a real corpus, not
synthetic data.

**Acceptance criteria**
- [ ] A documented benchmark set of 20 realistic queries, with the expected result in the
      top 3 for at least 18.
- [ ] Filters work and compose.
- [ ] Ranking is unit-tested with fixed inputs.

---

### WP-2.8 — Context adaptation

**Size:** 5–6 days · **Depends on:** WP-2.3, WP-1.3

**Goal:** the Notch changes based on what the user is doing — the vision's coding / studying
/ working modes.

**Approach:** derive context from foreground app, active environment, and recent events.
Map contexts to Notch layouts. **Detection must be conservative** — a Notch that reshuffles
while you are looking at it is worse than a static one. Require sustained signal before
switching, and always allow a manual pin.

**Acceptance criteria**
- [ ] At least three contexts detected reliably (coding, communication, browsing).
- [ ] Requires sustained signal — no flapping on brief app switches.
- [ ] User can pin a layout and override detection entirely.
- [ ] Context changes are logged as events.

---

### WP-2.9 — Command and action provider

**Size:** 4–5 days · **Depends on:** WP-2.2

**Goal:** run Atlas itself from the launcher.

**Approach:** start/stop timer, switch environment, run a scene, create task or note,
open a view, toggle settings. Reuse the existing IPC surface — this is mostly wiring
existing handlers into the provider interface.

**Acceptance criteria**
- [ ] Every major Atlas action is reachable by typing.
- [ ] Commands accept arguments where sensible (`task Buy milk`).
- [ ] Command list is generated from a registry, not hand-maintained in two places.

---

# PHASE 3 — Findings and Smart Functions

**35–45 focused days.** The heart of the vision, and the only genuinely research-shaped
work in this plan. Expect tuning to take longer than building.

---

### WP-3.1 — Smart Functions engine

**Size:** 6–8 days · **Depends on:** WP-0.5, WP-1.4

**Goal:** a general trigger → condition → action engine. Scenes become a special case of it.

**Approach:** triggers (environment switched, app launched, time of day, session started,
display connected, file changed), conditions (environment, time window, app running), and
actions — reusing the action vocabulary already in [scenes.ts](src/scenes.ts): launch apps,
open URLs, control timer, switch environment, create tasks. Migrate existing scenes to smart
functions with a `manual` trigger, losing nothing.

**Acceptance criteria**
- [ ] All existing scene capabilities are expressible as smart functions.
- [ ] Existing scenes migrate automatically and still work.
- [ ] Rules are evaluated without polling where the platform allows events.
- [ ] A failing action does not abort the remaining actions; failures are logged.
- [ ] Infinite loops are prevented (a rule cannot retrigger itself indefinitely).

---

### WP-3.2 — Smart Function editor

**Size:** 5–6 days · **Depends on:** WP-3.1

**Goal:** users build rules without a manual.

**Approach:** extend `SceneConfigEditor.tsx`. Plain-language rule preview ("When I open
Figma, in Design, start the timer"). Dry-run before saving.

**Acceptance criteria**
- [ ] Create, edit, delete, enable/disable, duplicate.
- [ ] Plain-language preview matches actual behaviour.
- [ ] Dry-run shows what would happen without doing it.

---

### WP-3.3 — Pattern miner

**Size:** 8–10 days · **Depends on:** WP-0.5

**Goal:** find repeated sequences in the event log. **The hardest package here.**

**Approach**
- Start with one pattern class only: **sequential co-occurrence** — "B follows A within N
  minutes, at least K times, with confidence above T."
- Run offline, on idle, on a schedule. Never on the hot path.
- Require a genuinely high threshold. A wrong suggestion costs far more trust than a missed
  one earns.
- Scope strictly per environment (WP-0.8).
- Make thresholds configurable in dev builds — you will spend real time tuning them.

**Acceptance criteria**
- [ ] Detects a seeded synthetic pattern in a test fixture.
- [ ] Produces zero findings from random event data (no false-positive floor).
- [ ] Mining 90 days of events completes in under 10 seconds, off the main thread.
- [ ] Thresholds are configurable and documented.
- [ ] Enclosed environments are mined in complete isolation.

**Gotchas:** resist adding pattern classes until the first one is genuinely good. Breadth
here produces noise, and noise is what makes users switch the whole feature off.

---

### WP-3.4 — Finding lifecycle

**Size:** 5–6 days · **Depends on:** WP-3.3, WP-3.1

**Goal:** implement the vision's seven-step flow, including the part that deletes data.

**Approach:** detect → temporary finding → suggestion → accept/ignore → smart function →
**purge the temporary learning data** → keep mining. That purge step is a stated product
promise, not an optimisation. Ignored findings must not resurface immediately; back off
with increasing intervals.

**Acceptance criteria**
- [ ] All seven steps implemented, with the purge verifiable in the database.
- [ ] Accepting produces a working, editable smart function.
- [ ] Ignoring suppresses the finding with increasing back-off.
- [ ] Findings expire if never acted on.

---

### WP-3.5 — Suggestion surfacing

**Size:** 4–5 days · **Depends on:** WP-3.4

**Goal:** suggestions appear where they help and never where they interrupt.

**Approach:** a quiet Notch affordance. Never modal, never stealing focus. Hard rate limit —
at most one suggestion per session, and a global cap per day.

**Acceptance criteria**
- [ ] Suggestions never take focus or block input.
- [ ] Rate limits enforced and configurable.
- [ ] One-click accept, one-click dismiss, from the Notch.
- [ ] A global "stop suggesting things" switch that fully works.

---

### WP-3.6 — Findings management

**Size:** 4–5 days · **Depends on:** WP-3.4

**Goal:** the vision's full control surface — accept, reject, delete, pause, convert, move
between environments, edit.

**Acceptance criteria**
- [ ] All seven listed operations work.
- [ ] Moving a finding between environments respects isolation rules.
- [ ] The user can see the evidence behind a finding — which events produced it.

---

### WP-3.7 — Feedback loop

**Size:** 3–4 days · **Depends on:** WP-3.5

**Goal:** the system gets less annoying over time, not more.

**Approach:** track accept/reject per pattern type and per environment, and suppress
categories the user consistently rejects.

**Acceptance criteria**
- [ ] Repeated rejection of a pattern type visibly reduces its suggestions.
- [ ] Suppression is inspectable and resettable by the user.

---

# PHASE 4 — AI and MCP

**25–30 focused days.**

---

### WP-4.1 — AI provider abstraction

**Size:** 4–5 days · **Depends on:** WP-0.4

**Goal:** a provider interface that a local model can slot into later without redesign (D6).

**Approach:** generalise [ai.cjs](electron/ai.cjs) behind an interface covering completion,
streaming, and tool-calling. Keep the three cloud providers. Add capability flags so
callers can degrade when a provider lacks a feature.

**Acceptance criteria**
- [ ] Existing three providers work unchanged from the user's view.
- [ ] Streaming supported.
- [ ] Tool/function calling supported where the provider offers it.
- [ ] Adding a provider requires no changes outside its own module.
- [ ] Keys still never reach the renderer.

---

### WP-4.2 — Scoped AI context and memory

**Size:** 5–6 days · **Depends on:** WP-4.1, WP-0.8

**Goal:** the AI knows about the current environment — and only about it, when enclosed.

**Approach:** build context from the active environment: recent tasks, notes, activity,
findings. Per-environment AI memory. Enclosed environments share nothing. Show the user
exactly what was sent.

**Acceptance criteria**
- [ ] Context is environment-scoped and isolation-respecting.
- [ ] A test proves an enclosed environment's data never enters another's context.
- [ ] The user can inspect the exact context sent with any request.
- [ ] Context size is bounded and truncation is deterministic.

---

### WP-4.3 — MCP client

**Size:** 6–8 days · **Depends on:** WP-4.1

**Goal:** Atlas speaks MCP and can use MCP servers as tools.

**Approach:** implement the client over stdio and HTTP transports. Discovery, tool listing,
invocation, lifecycle. Servers configured per environment.

**Acceptance criteria**
- [ ] Connects to a reference MCP server over both transports.
- [ ] Tools discovered and invocable through the AI layer.
- [ ] Server crash or hang is contained — Atlas stays responsive.
- [ ] Server config is per environment and isolation-respecting.

---

### WP-4.4 — MCP permission model

**Size:** 4–5 days · **Depends on:** WP-4.3

**Goal:** the user controls exactly what AI can reach. The vision's "controlled permissions".

**Approach:** per-server, per-tool grants. Explicit consent for anything destructive or
outbound. An audit log of every invocation.

**Acceptance criteria**
- [ ] Tools are deny-by-default until granted.
- [ ] Destructive operations require per-call confirmation.
- [ ] Full audit log, inspectable by the user.
- [ ] Permissions are revocable and take effect immediately.

---

### WP-4.5 — AI-driven configuration

**Size:** 5–6 days · **Depends on:** WP-4.4, WP-3.1

**Goal:** the vision's example prompts actually work — "create a finding when I start my
server", "change my Notch layout".

**Approach:** expose Atlas's own operations as tools to the AI: create/edit smart functions
and findings, modify Notch layout, create environments. Every mutation is previewed and
confirmed before it applies.

**Acceptance criteria**
- [ ] All four example prompts from the vision doc work end to end.
- [ ] Every AI-initiated change is previewed and confirmed before applying.
- [ ] AI changes are undoable.
- [ ] AI cannot alter permissions or isolation settings. Ever.

---

# PHASE 5 — Integrations

**30–40 focused days for the framework plus the first four.** Roughly 2–4 days per service
after that.

The strategic point from the estimate discussion: **this is the phase that eats years if you
treat it as a personal checklist.** Build the framework, ship a handful, then open the
plugin API (WP-6.4) and let the long tail be someone else's work.

---

### WP-5.1 — OAuth broker and token vault

**Size:** 6–8 days · **Depends on:** WP-0.4 · **Platform:** Win + macOS

**Goal:** one correct OAuth implementation, used by every integration.

**Approach:** loopback redirect with PKCE. Tokens in the WP-0.4 vault, never on disk in
plaintext. Automatic refresh with failure handling. Per-environment account binding, so a
work GitHub and a personal GitHub can coexist.

**Acceptance criteria**
- [ ] Full OAuth flow works on both platforms in packaged builds.
- [ ] Tokens encrypted at rest; refresh is automatic and handles revocation.
- [ ] Multiple accounts per provider, bound per environment.
- [ ] Disconnecting genuinely deletes the tokens.

---

### WP-5.2 — Integration framework

**Size:** 5–6 days · **Depends on:** WP-5.1

**Goal:** a contract that makes each new integration small.

**Approach:** an integration declares auth requirements, capabilities, data it exposes to
the launcher and Notch, actions it offers to smart functions, and its rate limits. Shared
retry, backoff, and caching.

**Acceptance criteria**
- [ ] A new integration needs only its own module.
- [ ] Rate limiting and retry are handled by the framework, not per integration.
- [ ] Integrations are enablable per environment and respect isolation.
- [ ] A failing integration never degrades the rest of the app.

---

### WP-5.3 to WP-5.6 — First integrations

**Size:** 3–5 days each · **Depends on:** WP-5.2

Recommended order, chosen to match how you actually work:

- **WP-5.3 GitHub** — repos, issues, PRs, notifications. You already live here.
- **WP-5.4 Local dev signals** — running servers, git state, open projects. No OAuth,
  high daily value, and it is what makes the coding context in WP-2.8 real.
- **WP-5.5 Calendar** (Google/Outlook) — the highest-value non-dev integration; drives
  context and Notch content.
- **WP-5.6 Notion or Obsidian** — pick one. Obsidian is local files and far simpler; Notion
  is API-based and more work. Obsidian is the better first choice.

**Acceptance criteria (each)**
- [ ] Auth (where needed) via WP-5.1; no bespoke token handling.
- [ ] Surfaces results in the launcher.
- [ ] Offers at least one smart function trigger and one action.
- [ ] Degrades cleanly when offline or unauthorised.
- [ ] Respects environment isolation.

---

# PHASE 6 — Statistics, privacy, plugins

**20–25 focused days.**

---

### WP-6.1 — Per-environment statistics

**Size:** 4–5 days · **Depends on:** WP-1.4

**Goal:** the vision's insight list, built on the event log. Extend the existing dashboard
and analysis views rather than replacing them (D2).

**Acceptance criteria**
- [ ] Time per environment and per app; most common workflows; task completion; finding
      acceptance rates.
- [ ] Correct across environment switches mid-session.
- [ ] Enclosed environments excluded from global aggregates.

---

### WP-6.2 — Workflow insights

**Size:** 5–6 days · **Depends on:** WP-6.1, WP-3.3

**Goal:** surface what the miner learns as understanding, not just automation.

**Approach:** most frequent sequences, context-switch frequency, focus-block distribution.
Framed as insight, never as judgement — the vision is explicit that this is not
surveillance. Avoid scores, streaks, and anything that reads as a report card.

**Acceptance criteria**
- [ ] At least four insight types derived from real event data.
- [ ] No scoring, grading, or productivity-shaming framing.
- [ ] Every insight is traceable to the events behind it.

---

### WP-6.3 — Privacy dashboard

**Size:** 5–6 days · **Depends on:** WP-6.1

**Goal:** the user can see, export, and delete everything Atlas knows. This is what makes
the local-first promise checkable rather than merely stated.

**Acceptance criteria**
- [ ] Every category of stored data is listed with real counts and sizes.
- [ ] Full export in an open format.
- [ ] Granular deletion, per environment and per data type.
- [ ] Deletion is real and verifiable — including from the event log.
- [ ] Retention windows configurable here.

---

### WP-6.4 — Plugin API

**Size:** 6–8 days · **Depends on:** WP-5.2

**Goal:** stop being the bottleneck for the integration long tail.

**Approach:** expose the integration and launcher-provider contracts to third-party plugins,
sandboxed, with an explicit permission model reusing WP-4.4. Document it properly.

**Acceptance criteria**
- [ ] A third-party plugin can add a launcher provider and a smart function action.
- [ ] Plugins run sandboxed and cannot escape their granted permissions.
- [ ] A malicious or broken plugin cannot compromise user data or crash the app.
- [ ] Public documentation with a working example plugin.

---

## 8. Explicitly not in this plan

Recording these so they do not silently creep back in.

| Item | Why not |
|---|---|
| **Macro recorder** | Cut (D4). Native input hooks, antivirus and accessibility friction, per-OS breakage, and Smart Functions cover the overlapping need. |
| **Bundled local LLM** | Deferred (D6). The provider interface in WP-4.1 leaves the door open; nothing else assumes it. |
| **File content indexing** | Filename and metadata only (WP-2.5). Content search is a much larger problem and is not what the vision asks for. |
| **Cloud sync** | The vision is local-first. Multi-device sync would need a conflict model and a trust story that nothing here has. |
| **Mobile / web clients** | Out of scope entirely. |
| **The other ~16 integrations** | Deliberately pushed to the plugin API (WP-6.4) rather than the roadmap. |

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `better-sqlite3` native build fails in CI for one platform | High | Blocks Phase 0 | Budget extra time in WP-0.3; verify *packaged* installers, not just dev |
| File indexer hurts battery or thermals | High | Users disable it | Throttle from the start; WP-2.5 treats it as a requirement, not polish |
| Findings suggest bad automations | Medium | Feature gets switched off permanently | High thresholds, one pattern class, hard rate limits, WP-3.7 feedback loop |
| macOS parity slips quietly | Medium | Repeat of today's situation | D1 makes it a per-package acceptance criterion, not a phase |
| Isolation model leaks across environments | Low | Breaks the core trust promise | Enforced at the data layer (WP-0.8) with an explicit tested allowlist |
| Bursty schedule leaves a refactor half-done | Medium | `main` unshippable for months | D5: every package is independently shippable; no long-lived branches |
| Scope creep back toward the full vision doc | High | Nothing finishes | Section 8 exists; revisit it whenever a package starts growing |

---

## 10. If you only do one thing

**Phase 0 and Phase 1. 60–75 focused days.**

Afterwards Atlas looks almost the same to a user — but it has tests, a database that can
carry an event stream, a modular main process, encrypted secrets, working macOS support,
an event log quietly accumulating the history the findings engine will need, and an
isolation model enforced at the data boundary.

Every one of those gets significantly more expensive the longer it waits, and every phase
after this one assumes all of them. Phases 2–6 are then genuinely optional, genuinely
reorderable, and can be delegated in almost any order.
