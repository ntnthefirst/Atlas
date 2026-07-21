// Migration 006 — per-environment Notch layouts (WP-1.3): creates the
// `notch_layouts` table that `environments.config.notchLayoutId` (WP-1.1,
// migration 005) points into.
//
// Keyed by id rather than one row per environment with a foreign key,
// because the whole point of `notchLayoutId` is that MANY environments
// share one row -- every environment with no override points at the same
// well-known "default" id (electron/config/notch-layouts.cjs's
// GLOBAL_DEFAULT_NOTCH_LAYOUT_ID). A `notch_layouts(id, data)` table lets
// that sharing fall out of ordinary foreign-key-by-value lookup, with no
// special-casing of "the default row" versus "an environment's own row" at
// the schema level -- see electron/db.cjs#getEffectiveNotchPreferences.
//
// `data` holds the full NotchPreferences document as JSON, validated by
// application code (electron/config/notch-prefs.cjs's
// normalizeNotchPreferences) exactly like `environments.config` already
// does for its own JSON column (migration 005) -- for the same reason: this
// is an open-ended document, not a closed set of values a CHECK constraint
// could usefully validate.
//
// This migration ONLY creates the table -- it does not populate the
// "default" row. That happens once, lazily, in
// electron/migrations/notch-layout-seed.cjs, called from AtlasDatabase's
// constructor right after this runs. It isn't done here because seeding
// needs to read the pre-existing flat `notch-preferences.json` file, which
// lives beside the database file, not inside it -- filesystem access a
// migration's `up(db)` has no path to reach (see legacy-import.cjs for the
// same reasoning applied to importing a whole pre-WP-0.3 database file).
"use strict";

module.exports = {
	version: 6,
	name: "006_notch_layouts",

	up(db) {
		if (!db.tableExists("notch_layouts")) {
			db.run(`CREATE TABLE notch_layouts (
				id TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`);
		}
	},
};
