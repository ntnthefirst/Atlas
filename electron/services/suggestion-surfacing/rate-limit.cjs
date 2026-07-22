"use strict";

// ---------------------------------------------------------------------------
// Suggestion rate limiting (WP-3.5) -- the PURE half. A function of (recent
// suggestion history, now, config) -> allow/deny, no I/O, no clock of its
// own, no Electron -- mirrors the split this codebase already established for
// electron/services/pattern-miner/finding-lifecycle.cjs and electron/
// services/smart-functions/evaluate.cjs's own `decide()` (see that file's
// "recentFires"/"maxFiresPerWindow" rate cap for the closest existing
// precedent): every clock reading and every history value is passed in, so
// the plan's own "at most one suggestion per session, and a global cap per
// day" is a rule this can prove with literal numbers, never by waiting real
// hours or days. electron/services/suggestion-surfacing/suggestion-
// manager.cjs (the stateful half) is the only caller, and is the only place
// that ever reads a clock or a database.
//
// -- Where "history" comes from -----------------------------------------------
// Rather than inventing a second, parallel log of "suggestions shown",
// suggestion-manager.cjs derives `history.suggestedAtMsList` from the
// `findings` table's own `suggested_at` column (already written by
// electron/services/pattern-miner/finding-lifecycle-service.cjs#markSuggested
// on every single "this finding just became visible" transition, across every
// environment) -- one existing timestamp per finding, already durable, no
// migration required. This module only ever sees the resulting plain array of
// millisecond timestamps.
//
// -- Two INDEPENDENT limits, not one -----------------------------------------
// "One per session" and "a cap per day" answer different questions and must
// both pass:
//   * Per-SESSION: how many of those timestamps fall at/after
//     `history.sessionStartMs` -- a value the stateful layer fixes exactly
//     once, at its own construction (a fresh process = a fresh session; see
//     suggestion-manager.cjs's own header). Restarting Atlas therefore always
//     resets this count to zero, no matter how many suggestions were shown in
//     a previous run today.
//   * Per-DAY: how many of those timestamps fall on the SAME CALENDAR DAY as
//     `now`, regardless of which session produced them -- this is what makes
//     the cap genuinely "global": it does not reset just because the app
//     restarted, and it is deliberately never scoped to one environment (the
//     plan's own wording is "a global cap per day", not "per environment per
//     day").
// Both are computed independently and either one alone is enough to deny.
// ---------------------------------------------------------------------------

// Local calendar day (not a UTC day, and not a rolling 24h window) -- matches
// every other "is this the same day" comparison already in this codebase
// (src/components/notch/NotchApp.tsx's own isSameDay for today's sessions).
function isSameCalendarDay(aMs, bMs) {
	const a = new Date(aMs);
	const b = new Date(bMs);
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// `history`: `{ suggestedAtMsList: number[], sessionStartMs: number }`.
// `config`: `{ maxPerSession: number, maxPerDay: number }` (electron/config/
// suggestion-prefs.cjs's own normalized shape).
//
// Returns `{ allowed: boolean, reason: "session_limit"|"daily_limit"|null }`
// -- mirroring evaluate.cjs#decide's own `{ fire, reason }` shape -- rather
// than a bare boolean, so a caller (or a test) can tell WHICH limit denied a
// suggestion without re-deriving it.
function canSurfaceSuggestion(history, now, config) {
	const suggestedAtMsList = Array.isArray(history?.suggestedAtMsList)
		? history.suggestedAtMsList.filter((ts) => Number.isFinite(ts))
		: [];
	// A missing/invalid sessionStartMs defensively counts everything as
	// "before this session" (fails open toward the MORE restrictive reading --
	// see the daily check below, which still catches it) rather than treating
	// every past suggestion as having happened in the current session.
	const sessionStartMs = Number.isFinite(history?.sessionStartMs) ? history.sessionStartMs : now;

	const sessionCount = suggestedAtMsList.filter((ts) => ts >= sessionStartMs).length;
	if (sessionCount >= config.maxPerSession) {
		return { allowed: false, reason: "session_limit" };
	}

	const dailyCount = suggestedAtMsList.filter((ts) => isSameCalendarDay(ts, now)).length;
	if (dailyCount >= config.maxPerDay) {
		return { allowed: false, reason: "daily_limit" };
	}

	return { allowed: true, reason: null };
}

module.exports = { canSurfaceSuggestion, isSameCalendarDay };
