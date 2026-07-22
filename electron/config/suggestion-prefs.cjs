"use strict";

// ---------------------------------------------------------------------------
// Suggestion surfacing preferences (WP-3.5) -- the global on/off switch plus
// the two hard rate limits the plan itself names: "at most one suggestion per
// session, and a global cap per day". Pure -- no Electron, no filesystem
// access -- mirroring electron/config/finding-lifecycle-prefs.cjs and
// electron/config/pattern-miner-prefs.cjs exactly: THIS module owns the
// shape/defaults/normalization, exercised under plain vitest; electron/
// services/suggestion-surfacing/suggestion-manager.cjs is the only place that
// actually loads/saves it from disk.
//
// -- Shape -------------------------------------------------------------------
// {
//   enabled:        the "stop suggesting things" switch. When false,
//                    suggestion-manager.cjs#getSuggestionToSurface returns
//                    immediately -- no db read, no rate-limit computation, no
//                    markSuggested call, nothing broadcast. See that module's
//                    own header for why this is checked FIRST, before
//                    anything else.
//   maxPerSession:   the plan's own "at most one suggestion per session" --
//                    kept configurable (like every other threshold in this
//                    package) for the same reason pattern-miner-prefs.cjs's
//                    thresholds are: dev builds need to tune/test it, even
//                    though the shipped default is exactly 1, the plan's own
//                    hard rule.
//   maxPerDay:       the plan's own "a global cap per day" -- a SEPARATE,
//                    independent ceiling from maxPerSession: a user who
//                    restarts Atlas several times in one day does not get a
//                    fresh per-session allowance each time, indefinitely --
//                    see rate-limit.cjs's own header for how the two compose.
// }
//
// Every threshold here is a genuine product decision this WP was asked to
// leave tunable, so the same discipline applies as every sibling prefs
// module: malformed/missing input never throws, it falls back to a
// documented default.
// ---------------------------------------------------------------------------

const { clampNumber } = require("./prefs-utils.cjs");

const SUGGESTION_PREFS_FILE = "suggestion-prefs.json";

const DEFAULT_ENABLED = true;
const DEFAULT_MAX_PER_SESSION = 1;
const DEFAULT_MAX_PER_DAY = 3;

const MIN_MAX_PER_SESSION = 1;
const MAX_MAX_PER_SESSION = 10;
const MIN_MAX_PER_DAY = 1;
const MAX_MAX_PER_DAY = 50;

function defaultSuggestionPreferences() {
	return {
		enabled: DEFAULT_ENABLED,
		maxPerSession: DEFAULT_MAX_PER_SESSION,
		maxPerDay: DEFAULT_MAX_PER_DAY,
	};
}

// Never throws, never returns a value outside its documented bounds -- exactly
// like normalizeFindingLifecyclePreferences(): a malformed/missing field is
// dropped back to its default rather than crashing a surfacing check over a
// corrupted prefs file.
function normalizeSuggestionPreferences(raw) {
	const base = defaultSuggestionPreferences();
	if (!raw || typeof raw !== "object") {
		return base;
	}
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
		maxPerSession: clampNumber(raw.maxPerSession, base.maxPerSession, MIN_MAX_PER_SESSION, MAX_MAX_PER_SESSION),
		maxPerDay: clampNumber(raw.maxPerDay, base.maxPerDay, MIN_MAX_PER_DAY, MAX_MAX_PER_DAY),
	};
}

module.exports = {
	SUGGESTION_PREFS_FILE,
	DEFAULT_ENABLED,
	DEFAULT_MAX_PER_SESSION,
	DEFAULT_MAX_PER_DAY,
	defaultSuggestionPreferences,
	normalizeSuggestionPreferences,
};
