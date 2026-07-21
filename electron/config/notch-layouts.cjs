// ---------------------------------------------------------------------------
// Per-environment Notch layout resolution (WP-1.3).
//
// Before this package, the Notch had exactly one preferences document,
// loaded from a flat `notch-preferences.json` file. This package moves
// storage into a keyed collection (`notch_layouts`, see migration
// 006_notch_layouts.cjs) so each environment can either point at its own row
// or, by leaving `notchLayoutId` null (WP-1.1's environment-config schema
// already reserved that field), fall through to one well-known "global
// default" row that every environment without an override shares.
//
// This module is the pure half of that story -- no window, app, db or
// filesystem access, same discipline as electron/config/notch-prefs.cjs and
// environment-config.cjs, and for the same reason: the resolution logic
// (own layout vs. inherited default vs. a malformed/missing row) has to be
// testable under plain vitest with no Electron runtime behind it. db.cjs
// does the actual SQL fetch (electron/db.cjs#getEffectiveNotchPreferences)
// and hands the raw column values to resolveNotchLayout() below, exactly the
// same fetch-in-db.cjs / normalize-in-config split environment-config.cjs
// already established for parseEnvironmentConfig.
//
// The schema of a layout itself is untouched -- normalizeNotchPreferences
// (electron/config/notch-prefs.cjs) still defines what a valid layout looks
// like. This module only decides WHICH stored document applies, and
// defends against a stored document that fails to parse.
// ---------------------------------------------------------------------------

"use strict";

const { normalizeNotchPreferences } = require("./notch-prefs.cjs");

// The well-known id every environment with `notchLayoutId === null` (WP-1.1's
// default; also what a pre-WP-1.3 environment or a hand-edited config
// resolves to) inherits from. Never reused as a real environment's own
// layout id -- environment.cjs mints those with randomUUID().
const GLOBAL_DEFAULT_NOTCH_LAYOUT_ID = "default";

// Parses a raw stored layout value -- a JSON string (the normal case coming
// out of `notch_layouts.data`), an already-parsed object (a caller that read
// the legacy flat file with JSON.parse itself), or null/undefined/garbage --
// into a fully-normalized NotchPreferences document. Never throws.
// `normalizeNotchPreferences` already tolerates `null`/non-object input by
// falling back to schema defaults, so the only extra work here is safely
// JSON-parsing a string without throwing on malformed JSON (a hand-edited
// notch-preferences.json, a truncated write from a crash mid-save, etc.).
function parseStoredNotchLayout(raw) {
	if (raw === null || raw === undefined) {
		return normalizeNotchPreferences(null);
	}
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) {
			return normalizeNotchPreferences(null);
		}
		try {
			return normalizeNotchPreferences(JSON.parse(trimmed));
		} catch {
			return normalizeNotchPreferences(null);
		}
	}
	return normalizeNotchPreferences(raw);
}

// The one function every reader of "which Notch layout applies to this
// environment" goes through. Pure: `notchLayoutId` is the environment's own
// config field (WP-1.1), and `ownLayoutRaw`/`defaultLayoutRaw` are whatever
// the caller already fetched for that id and for GLOBAL_DEFAULT_NOTCH_LAYOUT_ID
// respectively (db.cjs does the fetching; this just decides what to do with
// the result).
//
// `notchLayoutId` of null/empty/whitespace means "use the global default" --
// NEVER "empty layout" (see IMPLEMENTATION-PLAN.md, WP-1.3). A non-null id
// whose row turned out to be missing (deleted out from under it, a stale
// reference surviving a data-loss bug, or simply never seeded) falls back to
// the default too, rather than surfacing a broken/empty layout to the user.
function resolveNotchLayout({ notchLayoutId, ownLayoutRaw, defaultLayoutRaw }) {
	const hasOwnLayoutId = typeof notchLayoutId === "string" && notchLayoutId.trim().length > 0;
	if (hasOwnLayoutId && ownLayoutRaw !== null && ownLayoutRaw !== undefined) {
		return {
			usesDefault: false,
			layoutId: notchLayoutId,
			preferences: parseStoredNotchLayout(ownLayoutRaw),
		};
	}
	return {
		usesDefault: true,
		layoutId: GLOBAL_DEFAULT_NOTCH_LAYOUT_ID,
		preferences: parseStoredNotchLayout(defaultLayoutRaw),
	};
}

module.exports = {
	GLOBAL_DEFAULT_NOTCH_LAYOUT_ID,
	parseStoredNotchLayout,
	resolveNotchLayout,
};
