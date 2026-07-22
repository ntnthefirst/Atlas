// Migration 011 (WP-3.1) -- the smart functions engine's own table: a general
// trigger -> condition -> action rule, of which a migrated Notch scene (see
// src/scenes.ts's NotchSceneConfig) is one special case (a "manual" trigger,
// no conditions) and a future user-authored rule (WP-3.2's editor) is another.
//
// -- `environment_id` is nullable = global, mirroring `files` (migration 009)
// -- NOT `scoped.cjs`'s WP-0.8 discipline (which refuses to build an unscoped
// accessor at all). A smart function's data-ownership question is genuinely
// different from a task/note/session's: a Notch scene lives inside a
// notch_layouts row, and a layout is keyed by id, not by environment -- many
// environments (every one with no override) share the SAME layout row (see
// migration 006's header). A scene on a SHARED layout has no single owning
// environment to attribute it to, so electron/services/smart-functions/
// migrate-scenes.cjs resolves `environment_id` to a specific environment only
// when reverse-mapping `environments.config.notchLayoutId` finds EXACTLY one
// owner, and leaves it NULL (global -- evaluated regardless of which
// environment is active) otherwise. A user-authored rule (WP-3.2) can equally
// choose to be global by leaving this unset.
//
// -- `trigger`/`conditions`/`actions` are JSON documents, not normalized
// columns -- same reasoning as `environments.config` (migration 005) and
// `notch_layouts.data` (migration 006): these are open-ended, versioned-by-
// application-code shapes electron/services/smart-functions/model.cjs
// defensively parses, not a closed set of values a CHECK constraint could
// usefully validate. `conditions` and `actions` are JSON ARRAYS (zero or
// more); `trigger` is a single JSON OBJECT (`{type, ...}`) -- exactly one
// trigger per rule, matching the plan's "trigger -> condition -> action"
// phrasing singular on the first noun.
//
// -- `migrated_from` is the migration's own idempotency key -- `"<notch_layouts
// row id>:<placement id>"` -- UNIQUE so a second run of migrateScenes() (every
// boot; see main.cjs) can never insert the same scene twice. NULL for every
// user-authored rule (SQLite's UNIQUE constraint treats multiple NULLs as
// distinct, so this never collides across ordinary rules).
"use strict";

module.exports = {
	version: 11,
	name: "011_smart_functions",

	up(db) {
		db.run(`CREATE TABLE IF NOT EXISTS smart_functions (
			id TEXT PRIMARY KEY,
			environment_id TEXT,
			label TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			trigger TEXT NOT NULL,
			conditions TEXT NOT NULL DEFAULT '[]',
			actions TEXT NOT NULL DEFAULT '[]',
			source TEXT NOT NULL DEFAULT 'user',
			migrated_from TEXT UNIQUE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`);

		// Backs store.cjs's main listing query -- a specific environment's own
		// rules plus the global ones (`WHERE environment_id = ? OR environment_id
		// IS NULL`) -- mirroring idx_files_environment_id's own reasoning
		// (migration 009). The migration's own idempotency check (`WHERE
		// migrated_from = ?`) needs no index of its own: `migrated_from`'s UNIQUE
		// constraint above already gives SQLite one for free.
		db.run("CREATE INDEX IF NOT EXISTS idx_smart_functions_environment_id ON smart_functions (environment_id)");
	},
};
