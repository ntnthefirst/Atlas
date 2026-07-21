// Migration 002 — renames the `maps` table to `environments`, and the
// `map_id` foreign key column to `environment_id` on every table that
// references it, to match the product's "environments" language (see
// PRODUCT-VISION.md) instead of the old internal "maps" name (WP-0.7).
//
// Uses SQLite's native `ALTER TABLE ... RENAME TO` / `RENAME COLUMN`
// (supported since SQLite 3.25.0; this app runs 3.53.3 via
// node-sqlite3-wasm) rather than create-copy-drop: the rename happens
// in place, so every row and relationship survives untouched and there is
// no window where data could be lost if the process were interrupted
// mid-migration. There are no FOREIGN KEY constraints, indexes, views, or
// triggers declared anywhere in this schema (verified against 001_initial),
// so a plain rename is all that's needed — nothing else references the old
// names at the SQL level.
//
// Every check below is idempotent (mirrors 001_initial's style), so this is
// safe to run against a database that has already been migrated.
"use strict";

module.exports = {
	version: 2,
	name: "002_rename_maps_to_environments",

	up(db) {
		if (db.tableExists("maps") && !db.tableExists("environments")) {
			db.run("ALTER TABLE maps RENAME TO environments");
		}

		for (const table of ["sessions", "tasks", "notes"]) {
			if (db.columnExists(table, "map_id") && !db.columnExists(table, "environment_id")) {
				db.run(`ALTER TABLE ${table} RENAME COLUMN map_id TO environment_id`);
			}
		}
	},
};
