# Atlas Build Log — Phases 2 and 3

What was actually built, what went wrong, and what is still open. Written for a session
that has none of the context — [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) says what
*should* happen; this says what *did*, including the parts that needed a second attempt.

Commit messages carry the per-change reasoning in full. This document carries the things a
commit message cannot: mistakes and their corrections, decisions taken that the plan did
not anticipate, verification that was performed, and gaps left open on purpose.

**Covers:** `327d8ac` (WP-2.1) through `be1356d` (WP-2.8 UI).
**Last updated:** 2026-07-23.

---

## 1. Working rules established during these phases

These are not in the plan and are not derivable from the code. They came from the user
during the work, and they bind future sessions.

| Rule | Detail |
|---|---|
| **Commit messages** | No mention of AI, Claude, assistants, or Anthropic. **No `Co-Authored-By` trailer.** Conventional-commit style. |
| **`memory/` and `.claude/`** | Never read, stage, or commit anything under either. They stay untracked. |
| **Never `git add -A`** | Stage explicit paths only. This is what keeps the rule above enforceable. |
| **Tests never touch real data** | Every test that needs a database creates a temp dir. Never `%APPDATA%/Atlas` or `Atlas-Dev`. |
| **Windows only** | Binding decision D10. No macOS/darwin branches are written or claimed. |

### Test discipline

Every meaningful new test must be **proven to fail** when the behaviour it guards is
deliberately broken, then the break reverted. This is not ceremony: six packages in this
project shipped a vacuous test that passed against a broken implementation before this
practice started.

The breaks performed in Phase 3, all reverted:

| Package | Broken on purpose | Tests that caught it |
|---|---|---|
| WP-3.6 | `isFindingMoveAllowed` checking only the source side | 2 |
| WP-3.6 | Removed the evidence purge from `moveFinding` | 2 |
| WP-3.6 | Removed `paused` from `isFindingExpired` | 1 |
| WP-3.7 | Accept no longer clearing the consecutive-dismissal count | 2 |
| WP-3.7 | Removed the environment filter from `summarizeFeedback` | 1 |
| WP-3.7 | Suppression filter bypassed in the surfacing path | 2 |
| WP-3.2 | Preview claiming "an app launches" for the match-anything trigger | 1 |
| WP-3.2 | Preview naming a zero-width time window instead of "any time" | 1 |
| WP-3.2 | Dry run actually executing the rule | 2 |

### Verification gates

Run all of these before committing anything touching `electron/`:

```
npx vitest run          # 1664 tests across 99 files, ~35s
npm run lint
npm run build
npm run smoke           # boots the real main process, fails on crash
npm run smoke:windows   # opens every window type, fails if any does not
```

**What these gates do NOT cover:** renderer rendering. `vitest.config.ts` is node-only —
jsdom was deliberately left off — so there are no component tests. The panels also cannot
be driven in a browser, because `window.atlas` is preload-injected. Every decision behind
every control is tested; no control has been observed rendering. `smoke:windows` proves
only that the settings window opens.

### Environment quirks

- **PowerShell mangles multi-line commit messages.** A here-string breaks on an apostrophe
  (`git commit -m @'...WP's...'@` → `pathspec 'WP's' did not match`). **Always write the
  message to a scratch file and use `git commit -F <path>`.**
- **`git push` writes progress to stderr**, which PowerShell renders as a red
  `NativeCommandError` even on success. Check the `a..b dev -> dev` line, not the colour.
- **Bash heredocs with large JS payloads fail** in this harness. Write the file with the
  editor tool and append with `node -e`.

---

## 2. Phase 2 — the launcher

| WP | Commits | Notes |
|---|---|---|
| 2.1 Input surface | `327d8ac` | |
| 2.2 Provider registry | `2a6a4ec` | Replaced the stub. |
| 2.3 In-app data | `e2e01ac` | |
| 2.4 Installed apps | `1a6515b` | |
| 2.5 Crawler and store | `cbad395` `b0041a8` `c72dcfc` `5f9a7fe` `5aff607` `81cc0a3` `019c1f7` | Six commits — shipped in independently-verifiable slices. |
| 2.6 Watcher | `ee0e2b8` `002c884` | |
| 2.7 Ranking and filters | `2fcc735` `2cb0e93` | |
| 2.8 Context adaptation | `c6b9826` `be1356d` | UI landed much later — see below. |
| 2.9 Command provider | `abeafa5` `ec10bd4` | Built out of order, before 2.4. |

### Things that went wrong

**A fabricated measurement shipped and had to be corrected (`2cb0e93`).**
`file-index/store.cjs` claimed "Measured against a 100k-row files table … low tens of
milliseconds". WP-2.5 never ran that benchmark. WP-2.7 measured the real figure at ~390ms —
roughly 20× off. The comment was replaced with the measured number. *Do not write a
performance claim into a comment unless a benchmark produced it.*

**A doc comment cited code that never existed (`019c1f7`).** Migration 009 referred to
`scoped.cjs`'s `files.search()`. That function was never written; enforcement actually lives
in `file-index/store.cjs#searchFiles()`.

**A delegated package silently dropped an acceptance criterion (`002c884`).** The WP-2.6
agent omitted the plan's periodic re-crawl requirement. Implemented afterwards as
`runSafetyNetSweep()` / `startSafetyNet()` in `file-index/watcher.cjs`, on a 4-hour
`unref()`'d timer.

**WP-2.8 shipped complete and dormant.** The service, hysteresis, IPC channels and
`context:<name>` layout resolution all landed in `c6b9826`. Nothing in the renderer ever
called any of it, so there was no way to see the detected context, no way to pin it, and no
hint that `context:coding` was a configurable layout name. Fixed a phase later in `be1356d`.
*A feature with no surface is not finished, even when every acceptance criterion passes.*

### Open gap

`ext:pdf in:documents report` — a fully composed query — measures **64–99ms** against a
stated 50ms target. It is inside the launcher's 200ms timeout, so it is not user-visible,
but the target is not met.

---

## 3. Phase 3 — findings and smart functions

| WP | Commits | Shipped |
|---|---|---|
| 3.1 Engine | `90164fc` `850743b` | Trigger → condition → action; scenes migrated with a `manual` trigger. |
| 3.2 Editor | `d8f3f3f` | CRUD, duplicate, plain-language preview, dry run. |
| 3.3 Pattern miner | `14cacc3` `db3d1dd` | Sequential co-occurrence, worker thread. |
| 3.4 Finding lifecycle | `19cf72c` | Seven-step flow including the purge. |
| 3.5 Suggestion surfacing | `ee4926c` `ab816c4` | Quiet Notch affordance, rate-limited. |
| 3.6 Findings management | `93bb4c5` | Seven operations + evidence drill-down. |
| 3.7 Feedback loop | `9d5ca0e` | Consecutive-dismissal suppression. |

### Bugs found and fixed during the work

**A single malformed finding voided an entire mining run (`db3d1dd`).** Migration 012 makes
`findings.environment_id` `NOT NULL`. `upsertFindings` writes every bucket in **one
transaction**, so one finding with a null environment threw
`SQLite3Error: NOT NULL constraint failed` and took every valid finding in that run with it.
Reproduced, then fixed with a `== null` guard (catching both `null` and `undefined`) that
skips the bad row. The regression test places the bad row **first**, so it would fail again
if the guard moved.

**The suggestion poll sat on the Notch's 1.5-second hot loop (`ab816c4`).**
`getCurrentSuggestion` is not a cheap read — it runs eligibility selection and a rate-limit
query on every call. At 1.5s that is roughly **50,000 database round-trips per day, per
notch window, to observe at most three state changes**. Given its own constant,
`SUGGESTION_POLL_MS = 60_000`.

**`environment.switch` was never recorded from the launcher (`850743b`).** The miner reads
that event, so patterns involving environment switches could not be found when the switch
came from the launcher command.

**The preview dropped a comma (WP-3.2, fixed before commit).** A rule with no conditions
rendered as "When a session starts start the timer." Caught by the test suite on first run —
the comma belonged to the sentence, not to the condition clause.

### Decisions taken that the plan did not specify

**Accept vs. convert (WP-3.6).** The vision lists both as separate operations, but accept
already creates the smart function, which would make convert a second button doing one
thing. Resolved as one write path with one flag: **accept** creates the rule live,
**convert** creates it disabled so the user can read it before it fires. Both land the
finding in the same terminal `accepted` state. Duplicating the write path was rejected —
two ways to create the same rule drift apart.

**Moving a finding between environments (WP-3.6) — the isolation question.** A finding is a
signal derived from exactly one environment's activity, so relocating it is a
cross-environment signal transfer. `isFindingMoveAllowed` refuses whenever **either** side is
enclosed, not just the source: an enclosed environment neither contributes signal outward
nor receives it inward. The modes are read **from the database inside the service**, never
accepted as arguments — a mode a caller passes is a mode a renderer could forge. A source
environment that no longer exists reads as an invalid mode and fails closed.

Evidence is purged on **every permitted move**, not only a risky one. The evidence rows are
raw `events.id`s belonging to the source environment, and the destination must never reach
them. Purging unconditionally also leaves one rule to reason about — "a moved finding has no
evidence" — instead of a matrix that depends on settings the user may since have changed.
The purge and the environment write share one transaction, so a crash cannot leave the
finding pointing at its new home while still holding the old one's event ids.

**Only the label is editable (WP-3.6).** Every other column on a finding is a mined fact.
A control surface that let the user rewrite a statistic would be a surface for falsifying
the evidence the engine exists to present honestly. Migration 014 adds exactly one nullable
`label` column; `null` means "use the generated description" and never needs backfilling.

**Consecutive dismissals, not a lifetime tally (WP-3.7).** A lifetime ratio would mean a
category accepted once, years ago, could never be suppressed however often it was since
rejected. A raw lifetime count would suppress a category the user actively uses. Counting
since the last accept matches what the user is actually saying. Default is 3 in a row,
configurable 1–20.

**Resetting the feedback loop stamps a watermark; it never deletes an event (WP-3.7).**
Those rows are the user's activity log — the same table the miner reads. Destroying real
history to change a derived verdict is irreversible and corrupts everything else reading
them. Everything at or before the watermark stops counting; the rows stay.

**Pause is not fed to the feedback loop (WP-3.6/3.7).** A pause is the user declining to
decide. Counting it as a rejection would suppress a category they never rejected. It also
does not increment `ignoreCount`, and a paused finding never expires.

**The preview is built in the main process (WP-3.2).** `describe.cjs` renders the sentence
and every read channel attaches it. A copy of the phrasing in the renderer could drift from
the engine with nothing failing — and a preview that disagrees with behaviour is worse than
none, because the user builds against the sentence. Three phrases are written against
`evaluate.cjs`'s actual predicate rather than the obvious wording, and the tests check them
against `evaluate.cjs` itself:

- an app trigger with no process name matches **every** foreground change → "I switch to any app";
- a time window whose start equals its end is **always true** → "at any time of day";
- a rule's environment scoping gates automatic firing but **not** a manual run, so a manual
  rule's sentence does not claim it.

The suite also walks the closed vocabulary in `model.cjs` and fails if any trigger,
condition or action type has no phrase.

**Deviation from the plan's stated approach (WP-3.2).** The plan says "extend
`SceneConfigEditor.tsx`". A new `SmartFunctionsPanel.tsx` was built instead, because the
scene editor edits a scene inside a Notch placement's `config` JSON string — a different
storage model from `smart_functions` rows. All acceptance criteria are met, but see the open
issue below.

### 3a. The two-engines defect, found after Phase 3 closed (`e741467`)

Worth reading before trusting any "criteria met" claim in this document.

**WP-3.1's acceptance criteria all passed while its goal was not achieved.** The goal
was *"scenes become a special case of [the engine]"*. `migrate-scenes` copied every
scene into a `smart_functions` row — and nothing ever invoked those rows. The Notch
button kept calling `NotchApp.tsx#runScene`, a **complete second implementation of the
same five actions**, in the renderer. The criteria passed on a technicality: scenes
were *expressible*, they did *migrate*, and they *still worked* — down the old path.

Consequences while it stood:

- editing a scene changed the button but not the rule;
- editing the rule changed neither;
- a bug fixed in one engine stayed broken in the other;
- a sixth action type in `model.cjs` could never reach a scene button.

That is precisely the half-migrated state spanning a gap that **D5** forbids, and it
would have hardened the moment WP-4.5 began exposing "create a smart function" as an
AI tool.

**Fixed by** `scene-bridge.cjs`: the renderer executes nothing, and `runManually` is
the single path. The scene config remains the source of truth — a migrated rule is
*derived*, so its label and actions re-sync from the scene on every run. `enabled` and
`environmentId` deliberately do not re-sync; those are decisions about the rule, and
reverting them on a button press would be a new bug.

**The lesson worth carrying:** acceptance criteria can be satisfied by a technicality
while the goal is missed entirely. When a package's goal is "X becomes a special case
of Y", the check is not "does X still work" — it is **"is there still a second
implementation of X"**. Grep for the old path before believing a migration.

### Verification performed beyond the test suite

- **FTS5 availability** was confirmed empirically against the project's actual
  `node-sqlite3-wasm` build before WP-2.5 designed around it.
- **The miner's headline criterion** ("zero findings from random data") was checked with an
  independent probe using a seeded xorshift32 PRNG: 18 random and adversarial cases produced
  zero findings; 2 planted patterns were both found at lift ≈72. 20/20.
- **Mining performance**, re-measured 2026-07-23: **875ms** for 151,800 events across 10
  environments over 90 days, on a real worker thread against a real database. Budget is 10s.
- **The purge blast radius** was checked structurally by enumerating every `DELETE FROM` in
  the pattern-miner and smart-functions packages — four total, all scoped to
  `findings_evidence` or `findings` by id, none able to reach `events`, tasks, notes or
  sessions.
- **WP-3.5's non-interruption** was checked structurally: an empty diff on
  `notch-windows.cjs` plus a diff-wide scan for focus/modal calls (only a comment matched).

---

## 4. Delegation

The plan is written to be delegated, and the user asked for it. **It largely did not work.**

Seven sub-agents died mid-run on `You've hit your monthly spend limit`, including WP-2.5,
WP-2.8 and WP-3.6. WP-3.6's agent died after writing partial, uncommitted work into the tree
(a registered migration among it), which then had to be assessed and completed by hand.
WP-2.8, WP-3.2, WP-3.6 and WP-3.7 were all finished inline.

Two further problems with the delegated packages, independent of the spend limit:

- **Agents overstate findings.** The WP-3.1 agent reported that both the launcher command
  *and* the environment hotkey bypassed `environment.switch`. Only the launcher did — the
  hotkey opens the switcher UI, which routes through the recording IPC handler. Only the
  real half was fixed.
- **Agents read the stale session-start git snapshot.** The WP-3.3 agent reported
  `009_file_index.cjs` as untracked. `git ls-files --error-unmatch` proved it was committed
  in `cbad395`.

**Do not take a sub-agent's report at face value.** Re-run the gates yourself, and read the
correctness-critical pure logic directly.

---

## 5. Open, and deliberately not closed

| Issue | Detail |
|---|---|
| **Two editors for one concept** | *Execution was unified in `e741467` — see §3a.* What remains is editing: `SceneConfigEditor.tsx` is still wired into `NotchTabGridEditor.tsx:997`, so a scene can be edited there and the same automation edited again in the Smart Functions panel. The scene config now wins on every run, so they cannot silently disagree about behaviour, but two front doors to one thing is still confusing. |
| **No renderer verification** | See §1. Nothing built in these phases has been observed rendering. |
| **Findings outside any environment are unreachable** | Migration 012 made `findings.environment_id` `NOT NULL`. A pattern mined outside any environment can never be stored or surfaced. Fixing it needs a table rebuild. |
| **Composed file query is 64–99ms** | Against a stated 50ms target. Inside the launcher's 200ms timeout. |
| **22 commits carry `Co-Authored-By`** | Pre-D10, already pushed. Stripping them now needs a force-push. **User decision required.** |
| **macOS DMG in CI** | `DEV-DOCS.md` still documents a macOS build that cannot work under D10. **User decision required.** |
| **183 unchecked plan checkboxes** | Every checkbox in `IMPLEMENTATION-PLAN.md` is unchecked, including for completed Phases 0–2. Whether to maintain them as a ledger is **a user decision.** |

### Parked background tasks

- `task_c1b14aa4` — the `createNote` overwrite/data-loss path shared with Smart Capture.
- `task_f837eb4b` — toggle-notch / open-mini as real launcher commands.
