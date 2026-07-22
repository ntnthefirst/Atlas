// Migration 008 — indexes on the `environment_id` foreign key of every table
// the launcher's data provider (WP-2.3) reads (`electron/services/launcher-
// providers/data-provider.cjs`): `tasks`, `notes`, `sessions`. Every one of
// these is already filtered by `WHERE environment_id = ?` in db.cjs
// (listTasksByEnvironment / getNotebookByEnvironment / listSessionsByEnvironment,
// all routed through electron/data/scoped.cjs) and none of them had a
// supporting index before this -- every such read has been a full table scan
// since 001_initial. That was fine when the only callers were "show me my
// own board" (already the whole result set the UI needs), but the launcher
// provider runs this same query on every keystroke, scoped-search-then-filter,
// with a search-latency budget (WP-2.3: under 30ms) that a full scan risks
// blowing once a table has any real number of rows in it.
//
// Plain single-column indexes, not composite with e.g. created_at: the
// provider (and every existing caller) still filters in application code
// after the fetch (LIKE-style substring matching has no useful index of its
// own in this schema, and there is no FTS virtual table here), so all the
// index needs to do is turn "every row in the table" into "every row in this
// environment" before that in-memory filter runs.
"use strict";

module.exports = {
	version: 8,
	name: "008_environment_scoped_indexes",

	up(db) {
		db.run("CREATE INDEX IF NOT EXISTS idx_tasks_environment_id ON tasks (environment_id)");
		db.run("CREATE INDEX IF NOT EXISTS idx_notes_environment_id ON notes (environment_id)");
		db.run("CREATE INDEX IF NOT EXISTS idx_sessions_environment_id ON sessions (environment_id)");
	},
};
