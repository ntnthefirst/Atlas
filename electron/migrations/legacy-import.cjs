// Imports a pre-WP-0.3 sql.js-authored database file into the new engine
// (node-sqlite3-wasm) the first time it's encountered.
//
// sql.js writes standard SQLite files, so node-sqlite3-wasm can in fact open
// one directly (verified empirically against a real production database
// before writing this) — but nothing here *trusts* that without checking.
// The flow:
//
//   1. Copy the original to a timestamped backup, before anything else
//      happens, unconditionally.
//   2. Copy the original again into a private working file and open ONLY
//      that with the new engine — never the original, never the backup.
//   3. Run the schema migrations against the working copy (adds
//      `schema_migrations`, plus any columns a very old database might
//      still be missing).
//   4. Compare per-table row counts between the untouched backup and the
//      migrated working copy, for every user table the source has.
//   5. Only if every count matches: rename the working copy over the
//      original path.
//
// On any error or mismatch at any step, the working copy is discarded, the
// file at `dbPath` is never opened for writing and is left exactly as it
// was, and a clear error is thrown that points at the backup.
"use strict";

const fs = require("node:fs");
const { Database } = require("node-sqlite3-wasm");
const { wrapDatabase } = require("./sqlite-helpers.cjs");
const { runMigrations } = require("./index.cjs");

const timestampForFilename = (isoTimestamp) => isoTimestamp.replace(/[:.]/g, "-");

function listUserTables(core) {
	return core
		.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.map((row) => row.name);
}

function readTableCounts(core, tableNames) {
	const counts = {};
	for (const table of tableNames) {
		counts[table] = core.first(`SELECT COUNT(*) AS c FROM "${table}"`).c;
	}
	return counts;
}

// Tables that a migration renames, as `legacy name -> current name`.
//
// Verification reads the table list from the pre-migration source and then
// counts rows in the migrated copy, so without this a renamed table is looked
// up under a name that no longer exists — the import aborts and the app
// refuses to start for exactly the existing users this whole path exists to
// protect.
//
// ADD AN ENTRY HERE whenever a migration renames a table.
const TABLE_RENAMES = {
	// 002_rename_maps_to_environments
	maps: "environments",
};

const currentNameOf = (legacyTable) => TABLE_RENAMES[legacyTable] ?? legacyTable;

function safeUnlink(filePath) {
	try {
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
		}
	} catch {
		// Best-effort cleanup only — never let cleanup failure mask the real error.
	}
}

/**
 * Detect whether `dbPath` needs the legacy import flow.
 *
 * Returns `false` when there's no file yet (fresh install) or when the file
 * already has a `schema_migrations` table (it has already been through this
 * flow, or is a fresh database created by the new engine). Returns `true`
 * for a genuine pre-migration sql.js file, and also for a file that can't
 * even be opened — that ambiguous case is resolved by the import attempt
 * itself, which fails loudly without touching the original.
 */
function needsLegacyImport(dbPath) {
	if (!fs.existsSync(dbPath)) {
		return false;
	}

	let probe;
	try {
		probe = new Database(dbPath, { readOnly: true });
		const hasMigrationsTable = probe.get(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
		);
		return !hasMigrationsTable;
	} catch {
		return true;
	} finally {
		try {
			probe?.close();
		} catch {
			// Never opened, or already closed — nothing to do.
		}
	}
}

function importLegacyDatabaseIfNeeded(dbPath) {
	if (!needsLegacyImport(dbPath)) {
		return;
	}

	const timestamp = timestampForFilename(new Date().toISOString());
	const backupPath = `${dbPath}.sqljs-backup-${timestamp}`;
	const workingPath = `${dbPath}.migrating-${timestamp}.tmp`;

	// Step 1 — unconditional backup of the untouched original.
	fs.copyFileSync(dbPath, backupPath);

	let working = null;
	try {
		// Step 2 — work on a private copy; the original is never opened
		// read-write during this process.
		fs.copyFileSync(dbPath, workingPath);

		let tables;
		let sourceCounts;
		const sourceProbe = new Database(backupPath, { readOnly: true });
		try {
			const sourceCore = wrapDatabase(sourceProbe);
			tables = listUserTables(sourceCore);
			sourceCounts = readTableCounts(sourceCore, tables);
		} finally {
			sourceProbe.close();
		}

		// Step 3 — import: open the working copy and bring it up to the
		// current schema. Since the file is already valid SQLite, "opening"
		// it *is* the import; the migrations only add what's missing.
		working = new Database(workingPath);
		const workingCore = wrapDatabase(working);
		runMigrations(workingCore);

		// Step 4 — verify. Each source table is counted under whatever name it
		// now has, since a migration may have renamed it (see TABLE_RENAMES).
		const targetCounts = readTableCounts(workingCore, tables.map(currentNameOf));
		const mismatches = tables.filter((table) => sourceCounts[table] !== targetCounts[currentNameOf(table)]);
		if (mismatches.length > 0) {
			throw new Error(
				`row count mismatch after import for: ${mismatches
					.map(
						(table) =>
							`${table} (source=${sourceCounts[table]}, imported=${targetCounts[currentNameOf(table)]})`,
					)
					.join(", ")}`,
			);
		}

		working.close();
		working = null;

		// Step 5 — swap. Only reached once the working copy is verified.
		fs.renameSync(workingPath, dbPath);
	} catch (err) {
		if (working) {
			try {
				working.close();
			} catch {
				// already closed / never fully opened.
			}
		}
		safeUnlink(workingPath);
		safeUnlink(`${workingPath}-wal`);
		safeUnlink(`${workingPath}-shm`);

		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to migrate the existing database at "${dbPath}" to the new database engine: ${reason}. ` +
				`A backup of the original, untouched file was saved to "${backupPath}". ` +
				`The original file was not modified.`,
		);
	}
}

module.exports = { importLegacyDatabaseIfNeeded, needsLegacyImport };
