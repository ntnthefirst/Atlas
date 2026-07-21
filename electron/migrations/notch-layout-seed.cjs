// ---------------------------------------------------------------------------
// One-time seed of the global default Notch layout (WP-1.3), from the
// pre-existing flat `notch-preferences.json` file.
//
// Not a numbered migration (see migrations/index.cjs) because it needs
// filesystem access to a file that lives BESIDE the database, not inside
// it -- exactly the same reason electron/migrations/legacy-import.cjs is a
// separate step run from AtlasDatabase's constructor rather than a numbered
// migration.up(db). Migration 006 (006_notch_layouts.cjs) only creates the
// `notch_layouts` table; this is what actually populates its "default" row,
// the first time a build with this table runs against an existing user's
// data.
//
// THE RISK THIS EXISTS TO AVOID: an existing user has a carefully configured
// Notch (custom tabs, widget grids, position, opacity) sitting in
// notch-preferences.json. If this table ever got seeded with schema
// defaults instead of that file's contents, the user would open Atlas to
// find their Notch silently reset to stock -- indistinguishable from data
// loss. So:
//
//   - If a "default" row already exists, this is a complete no-op (never
//     overwrites -- matches src/utils/storageMigration.ts's house rule,
//     "migrate on read, never destroy").
//   - If notch-preferences.json exists, its contents become the seeded
//     default row, defensively parsed the same way any other stored layout
//     is (electron/config/notch-layouts.cjs#parseStoredNotchLayout) -- a
//     corrupt or unreadable file falls back to schema defaults rather than
//     blocking startup, but never silently discards a file that DOES parse.
//   - The flat file itself is never deleted here or anywhere else in this
//     package -- WP-1.3 keeps it in place and readable for at least one
//     release, both as a manual-recovery fallback and because deleting a
//     user's file the moment its contents are copied elsewhere is exactly
//     the kind of "trust the migration blindly" move D3 warns against.
// ---------------------------------------------------------------------------
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { GLOBAL_DEFAULT_NOTCH_LAYOUT_ID, parseStoredNotchLayout } = require("../config/notch-layouts.cjs");
const { NOTCH_PREFS_FILE, defaultNotchPreferences } = require("../config/notch-prefs.cjs");

// Reads and defensively parses notch-preferences.json from beside `dbPath`.
// Exported separately from the seed step so a test can exercise "what would
// be seeded" without needing a real sqlite connection.
function readLegacyNotchPreferences(dbPath) {
	const legacyPath = path.join(path.dirname(dbPath), NOTCH_PREFS_FILE);
	try {
		if (!fs.existsSync(legacyPath)) {
			return { ...defaultNotchPreferences };
		}
		return parseStoredNotchLayout(fs.readFileSync(legacyPath, "utf8"));
	} catch {
		// A corrupt or unreadable legacy file must never block startup -- fall
		// back to the same schema default a missing file would produce.
		return { ...defaultNotchPreferences };
	}
}

// `core` is anything exposing run/first (an AtlasDatabase instance, or the
// sqlite-helpers wrapDatabase() shim -- same duck-typed contract migrations
// themselves rely on). Returns true if it actually seeded a row, false if it
// found one already there and left it untouched (useful for tests; ignored
// by the real caller).
function seedGlobalDefaultNotchLayoutIfNeeded(core, dbPath) {
	const existing = core.first("SELECT id FROM notch_layouts WHERE id = ?", [GLOBAL_DEFAULT_NOTCH_LAYOUT_ID]);
	if (existing) {
		return false;
	}

	const seeded = readLegacyNotchPreferences(dbPath);
	const now = new Date().toISOString();
	core.run("INSERT INTO notch_layouts (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)", [
		GLOBAL_DEFAULT_NOTCH_LAYOUT_ID,
		JSON.stringify(seeded),
		now,
		now,
	]);
	return true;
}

module.exports = { readLegacyNotchPreferences, seedGlobalDefaultNotchLayoutIfNeeded };
