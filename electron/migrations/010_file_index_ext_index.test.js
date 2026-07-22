import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { Database } from "node-sqlite3-wasm";
import { wrapDatabase } from "./sqlite-helpers.cjs";
import { runMigrations, MIGRATIONS } from "./index.cjs";
import { AtlasDatabase } from "../db.cjs";

// ---------------------------------------------------------------------------
// Migration 010 (WP-2.7) -- an index on files.ext, backing the `ext:<value>`
// launcher search filter (electron/services/file-index/store.cjs's
// buildExtClause()).
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migration-010-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("migration 010 -- files.ext index", () => {
	it("is registered in the MIGRATIONS array as version 10", () => {
		const migration = MIGRATIONS.find((m) => m.name === "010_file_index_ext_index");
		expect(migration).toBeDefined();
		expect(migration.version).toBe(10);
	});

	it("a freshly created database has idx_files_ext on the files table", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const indexNames = db
			.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'files'")
			.map((row) => row.name);
		expect(indexNames).toContain("idx_files_ext");
	});

	it("applies cleanly on top of a database that only has migrations 001-009 (the real upgrade path)", () => {
		const rawDb = new Database(createTempDbPath());
		const core = wrapDatabase(rawDb);
		const earlierMigrations = MIGRATIONS.filter((m) => m.version <= 9);

		core.run(
			`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
		);
		core.transaction(() => {
			for (const migration of earlierMigrations) {
				migration.up(core);
				core.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
					migration.version,
					migration.name,
					new Date().toISOString(),
				]);
			}
		});
		const beforeIndexes = core
			.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'files'")
			.map((row) => row.name);
		expect(beforeIndexes).not.toContain("idx_files_ext");

		runMigrations(core);

		const afterIndexes = core
			.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'files'")
			.map((row) => row.name);
		expect(afterIndexes).toContain("idx_files_ext");
		const appliedVersions = core.all("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version);
		expect(appliedVersions).toContain(10);

		rawDb.close();
	});
});
