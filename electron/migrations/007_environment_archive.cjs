// Migration 007 — environment archiving (WP-1.5): adds an `archived_at`
// TEXT column to `environments`, NULL by default and NULL for every
// pre-existing row.
//
// Archiving is explicitly NOT a soft delete: it hides an environment from
// switching surfaces (db.cjs#listEnvironments filters `archived_at IS NULL`)
// while every row it owns elsewhere -- tasks, notes, sessions, activity
// blocks, events, its own Notch layout, its config document -- stays exactly
// where it was, untouched. `archived_at` records WHEN an environment was
// hidden (a timestamp, not a boolean) purely so `listArchivedEnvironments`
// (db.cjs) can show the most-recently-archived one first -- the same reason
// `created_at` is a timestamp rather than an ordinal.
//
// `ADD COLUMN archived_at TEXT` with no default, nullable: exactly the same
// shape as migration 005's `config` column, and for the same reason (D3) --
// every existing environment gets NULL, i.e. "not archived", which is the
// only interpretation that doesn't silently hide something a user never
// asked to hide.
"use strict";

module.exports = {
	version: 7,
	name: "007_environment_archive",

	up(db) {
		if (!db.columnExists("environments", "archived_at")) {
			db.run(`ALTER TABLE environments ADD COLUMN archived_at TEXT`);
		}
	},
};
