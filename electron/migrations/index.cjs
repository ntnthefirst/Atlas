// Migration runner. Applies every migration in MIGRATIONS whose version is
// not yet recorded in `schema_migrations`, in array order, each inside its
// own transaction (so a crash mid-migration can't leave the schema and the
// migrations table disagreeing about what ran).
//
// `dbLike` is anything exposing run/all/first/tableExists/columnExists/
// transaction — either an AtlasDatabase instance (normal boot) or a
// sqlite-helpers `wrapDatabase()` shim around a bare connection (the legacy
// sql.js import flow, before an AtlasDatabase wrapper exists).
"use strict";

const MIGRATIONS = [
	require("./001_initial.cjs"),
	require("./002_rename_maps_to_environments.cjs"),
	require("./003_event_log.cjs"),
	require("./004_environment_isolation.cjs"),
	require("./005_environment_config.cjs"),
	require("./006_notch_layouts.cjs"),
	require("./007_environment_archive.cjs"),
];

function ensureMigrationsTable(dbLike) {
	dbLike.run(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
	);
}

function appliedVersions(dbLike) {
	return new Set(dbLike.all("SELECT version FROM schema_migrations").map((row) => row.version));
}

function runMigrations(dbLike) {
	ensureMigrationsTable(dbLike);
	const applied = appliedVersions(dbLike);

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.version)) {
			continue;
		}

		dbLike.transaction(() => {
			migration.up(dbLike);
			dbLike.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
				migration.version,
				migration.name,
				new Date().toISOString(),
			]);
		});
	}
}

module.exports = { MIGRATIONS, runMigrations };
