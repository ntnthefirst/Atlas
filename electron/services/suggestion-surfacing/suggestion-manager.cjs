"use strict";

// ---------------------------------------------------------------------------
// Suggestion surfacing manager (WP-3.5) -- the STATEFUL half: owns the
// persisted on/off + rate-limit preferences (electron/config/suggestion-
// prefs.cjs) and is the ONE seam electron/ipc/suggestions.cjs calls through.
// Mirrors electron/services/pattern-miner/finding-lifecycle-manager.cjs's own
// split exactly: every actual DECISION lives in the pure ./rate-limit.cjs
// (allow/deny) and ./selection.cjs (which finding, if any); this module is
// deliberately thin around them, and reuses electron/services/pattern-miner/
// store.cjs's existing findings read surface and finding-lifecycle-
// manager.cjs's own markSuggested() rather than inventing either a second
// findings accessor or a second, parallel way to move a finding into
// "suggested". Accept/ignore are NOT here at all -- see electron/ipc/
// suggestions.cjs's own header for why those stay on findings:accept/
// findings:ignore, untouched.
//
// -- getSuggestionToSurface(): the ONE entry point ---------------------------
// Polled from the Notch (src/components/notch/NotchApp.tsx), exactly like
// every other ambient value it reads (tasks, dashboard, environments, ...) --
// there is no push/broadcast here, and deliberately so: a poll that returns
// null most of the time costs nothing extra over the polling this app already
// does everywhere, while a broadcast would be one more thing that could fire
// unprompted. Checks, in order, and returns `null` the instant any one of
// them fails:
//   1. `preferences.enabled` -- see the header below ("fully works").
//   2. `environmentId` -- nothing is ever suggested with no active
//      environment (findings are always environment-scoped; WP-0.8).
//   3. a db actually exists yet.
//   4. selection.cjs#selectFindingToSurface found an eligible candidate.
//   5. rate-limit.cjs#canSurfaceSuggestion allows it right now.
// Only once ALL FIVE pass does this call lifecycleManager.markSuggested() --
// the SAME finding-lifecycle-service.cjs transition WP-3.4 already built,
// reused verbatim, never a parallel "mark this shown" write of its own.
//
// -- "Fully works" when disabled ---------------------------------------------
// Check #1 is FIRST and returns immediately: with `enabled: false`, this
// function touches neither `getDb()` nor the clock nor `lifecycleManager` at
// all -- no query, no rate-limit arithmetic, no markSuggested call, and (since
// this is the only path that ever returns a suggestion to the renderer)
// nothing is ever sent back for the Notch to render. See suggestion-
// manager.test.js's own "global switch" suite, which proves this with a
// fixture that WOULD otherwise definitely produce a suggestion.
//
// -- Why sessionStartMs is fixed once, here, at construction -----------------
// "A new session resets the per-session limit" (this WP's own rate-limit
// rule) means, concretely, "a new run of the Atlas process" -- there is no
// other renderer-visible boundary that means "session" here (unlike the
// timer/work `Session` domain object, which is unrelated). Capturing `now()`
// once, the moment main.cjs constructs this manager, is therefore exactly
// "when did THIS run of Atlas start" -- restarting Atlas always produces a
// brand new manager instance with a brand new (later) `sessionStartMs`,
// which rate-limit.cjs's own session filter (`ts >= sessionStartMs`) then
// necessarily excludes every suggestion shown by a previous run, while the
// SAME timestamps still count toward the calendar-day cap (which never reads
// `sessionStartMs` at all). `deps.sessionStartMs`/`deps.now` exist purely so
// tests can simulate "a fresh process, later today" without an actual
// restart.
// ---------------------------------------------------------------------------

const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");
const {
	SUGGESTION_PREFS_FILE,
	defaultSuggestionPreferences,
	normalizeSuggestionPreferences,
} = require("../../config/suggestion-prefs.cjs");
const { canSurfaceSuggestion } = require("./rate-limit.cjs");
const { selectFindingToSurface } = require("./selection.cjs");
const patternMinerStore = require("../pattern-miner/store.cjs");
const { buildFindingRuleLabel } = require("../pattern-miner/finding-translator.cjs");

function createSuggestionManager(deps = {}) {
	const resolvePrefsPath = deps.getPrefsPath ?? (() => path.join(app.getPath("userData"), SUGGESTION_PREFS_FILE));
	const getDb = deps.getDb ?? (() => null);
	const now = deps.now ?? (() => Date.now());
	// `lifecycleManager` is electron/services/pattern-miner/finding-lifecycle-
	// manager.cjs's own instance -- its markSuggested() (and, transitively,
	// getPreferences() for the expiry/back-off thresholds selection.cjs needs)
	// is reused verbatim; this module creates no lifecycle state of its own.
	const lifecycleManager = deps.lifecycleManager;
	const getEventLog = deps.getEventLog ?? (() => null);
	// See this file's header -- fixed exactly once, never reassigned.
	const sessionStartMs = Number.isFinite(deps.sessionStartMs) ? deps.sessionStartMs : now();

	let preferences = defaultSuggestionPreferences();

	function loadPreferences() {
		try {
			const raw = fs.readFileSync(resolvePrefsPath(), "utf8");
			preferences = normalizeSuggestionPreferences(JSON.parse(raw));
		} catch {
			preferences = defaultSuggestionPreferences();
		}
		return preferences;
	}

	function persist() {
		try {
			fs.writeFileSync(resolvePrefsPath(), JSON.stringify(preferences, null, 2), "utf8");
		} catch {
			// Non-blocking: preferences still apply for the rest of this session
			// even if they can't be written to disk -- same discipline as every
			// sibling manager's own persist().
		}
	}

	function getPreferences() {
		return preferences;
	}

	function setPreferences(patch) {
		preferences = normalizeSuggestionPreferences({ ...preferences, ...(patch || {}) });
		persist();
		return preferences;
	}

	// See this file's header for the full five-step short-circuit chain.
	function getSuggestionToSurface(environmentId) {
		if (!preferences.enabled) {
			return null;
		}
		if (!environmentId) {
			return null;
		}
		const db = getDb();
		if (!db) {
			return null;
		}

		const nowMs = now();
		const allFindings = patternMinerStore.listAllFindings(db);
		const lifecycleConfig = lifecycleManager?.getPreferences?.() ?? {};

		const candidate = selectFindingToSurface(allFindings, environmentId, nowMs, lifecycleConfig);
		if (!candidate) {
			return null;
		}

		// Deliberately built from the SAME `allFindings` read above (one query,
		// not two): every finding's own `suggestedAt` -- across every
		// environment, since the daily cap is global, not per-environment -- is
		// exactly the "recent suggestion history" rate-limit.cjs's header
		// describes. A "new" candidate's own `suggestedAt` is still null here
		// (it has never been shown), so it can't double-count itself.
		const history = {
			sessionStartMs,
			suggestedAtMsList: allFindings
				.map((finding) => (finding.suggestedAt ? Date.parse(finding.suggestedAt) : NaN))
				.filter((ts) => Number.isFinite(ts)),
		};
		const decision = canSurfaceSuggestion(history, nowMs, preferences);
		if (!decision.allowed) {
			return null;
		}

		const result = lifecycleManager.markSuggested(candidate.id);
		if (!result.ok) {
			// Lost a race (e.g. accepted/ignored by another path a moment ago) --
			// fail closed, exactly like a denied rate-limit check.
			return null;
		}

		// WP-3.7's own feedback loop reads this back to suppress categories the
		// user consistently rejects -- pattern type and outcome only, never a
		// raw window title or file path (electron/services/event-log.cjs's own
		// privacy header).
		getEventLog()?.record?.("suggestion.shown", {
			environmentId: result.finding.environmentId,
			subject: result.finding.id,
			payload: { patternType: result.finding.patternType },
		});

		return {
			id: result.finding.id,
			environmentId: result.finding.environmentId,
			patternType: result.finding.patternType,
			description: buildFindingRuleLabel(result.finding),
			confidence: result.finding.confidence,
			occurrences: result.finding.occurrences,
			suggestedAt: result.finding.suggestedAt,
		};
	}

	return {
		loadPreferences,
		getPreferences,
		setPreferences,
		getSuggestionToSurface,
	};
}

module.exports = { createSuggestionManager };
