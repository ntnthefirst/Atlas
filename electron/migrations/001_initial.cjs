// Migration 001 — the schema that used to be created implicitly by
// `initSchema()` in db.cjs before the migration framework existed (WP-0.3).
//
// The incremental `ALTER TABLE` column additions are preserved exactly as
// they were: they let a database from before those columns existed (maps
// without icon/accent/preset, tasks without priority/tags/due_date) migrate
// in place without losing any rows. Every statement here is safe to run
// against a database that already has the table/column in question, which
// is what makes this migration (and the runner that drives it) idempotent.
"use strict";

module.exports = {
	version: 1,
	name: "001_initial",

	up(db) {
		db.run(
			`CREATE TABLE IF NOT EXISTS maps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
		);

		// Environment metadata (icon / accent color / preset type) added
		// incrementally so existing databases migrate without losing data.
		for (const column of ["icon", "accent", "preset"]) {
			if (!db.columnExists("maps", column)) {
				db.run(`ALTER TABLE maps ADD COLUMN ${column} TEXT`);
			}
		}

		db.run(
			`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        map_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        total_duration INTEGER DEFAULT 0,
        paused_duration INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        is_paused INTEGER DEFAULT 0,
        pause_started_at TEXT,
        created_at TEXT NOT NULL
      )`,
		);

		db.run(
			`CREATE TABLE IF NOT EXISTS pauses (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      )`,
		);

		db.run(
			`CREATE TABLE IF NOT EXISTS activity_blocks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        app_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration INTEGER DEFAULT 0
      )`,
		);

		db.run(
			`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        map_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
		);

		// GitHub-Projects-style task fields, added incrementally so existing
		// databases migrate in place. tags is a JSON array string; due_date is
		// an ISO date (yyyy-mm-dd) or null.
		for (const [column, ddl] of [
			["priority", "TEXT DEFAULT 'none'"],
			["tags", "TEXT DEFAULT '[]'"],
			["due_date", "TEXT"],
		]) {
			if (!db.columnExists("tasks", column)) {
				db.run(`ALTER TABLE tasks ADD COLUMN ${column} ${ddl}`);
			}
		}

		db.run(
			`CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        map_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
		);
	},
};
