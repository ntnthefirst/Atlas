import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { Database } from "node-sqlite3-wasm";
import { wrapDatabase } from "./sqlite-helpers.cjs";
import { runMigrations, MIGRATIONS } from "./index.cjs";
import { AtlasDatabase } from "../db.cjs";

// ---------------------------------------------------------------------------
// Migration 009 (WP-2.5) -- the `files` table and its FTS5 companion
// `files_fts`. Both are brand new tables (nothing to migrate data INTO), so
// this suite checks: the schema shape a fresh database ends up with, that it
// applies cleanly on top of a database that only had migrations 001-008
// (exactly how a real upgrading user's database looks), and that FTS5 itself
// is actually usable against the created virtual table -- the WP's own
// "confirmed available" claim, pinned down as a real assertion rather than
// only a comment.
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migration-009-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("migration 009 -- files / files_fts", () => {
	it("is registered in the MIGRATIONS array as version 9", () => {
		const migration = MIGRATIONS.find((m) => m.name === "009_file_index");
		expect(migration).toBeDefined();
		expect(migration.version).toBe(9);
	});

	it("a freshly created database has the files table with every WP-2.5 column", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		expect(db.tableExists("files")).toBe(true);
		for (const column of ["path", "name", "ext", "size", "mtime", "environment_id", "root", "last_seen_at"]) {
			expect(db.columnExists("files", column)).toBe(true);
		}
	});

	it("enforces path as the primary key (a second insert with the same path upserts, never duplicates)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const insert = () =>
			db.run(
				"INSERT INTO files (path, name, ext, size, mtime, environment_id, root, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size",
				["C:\\a.txt", "a.txt", "txt", 1, 1, null, "root-1", 1],
			);
		insert();
		insert();
		expect(db.all("SELECT * FROM files")).toHaveLength(1);
	});

	it("creates files_fts as a working FTS5 virtual table (prefix MATCH + rank)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		db.run(
			"INSERT INTO files (path, name, ext, size, mtime, environment_id, root, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["C:\\Quarterly-Report.pdf", "Quarterly-Report.pdf", "pdf", 1, 1, null, "root-1", 1],
		);
		db.run("INSERT INTO files_fts (name, path) SELECT name, path FROM files");

		const rows = db.all("SELECT path, rank FROM files_fts WHERE files_fts MATCH ? ORDER BY rank", ["quarter*"]);
		expect(rows).toHaveLength(1);
		expect(rows[0].path).toBe("C:\\Quarterly-Report.pdf");
	});

	it("applies cleanly on top of a database that only has migrations 001-008 (the real upgrade path)", () => {
		const rawDb = new Database(createTempDbPath());
		const core = wrapDatabase(rawDb);
		const earlierMigrations = MIGRATIONS.filter((m) => m.version <= 8);

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
		expect(core.tableExists("files")).toBe(false);

		// Now run the full migration set, exactly like AtlasDatabase.create()
		// does on every real boot -- this must apply 009 (and nothing else,
		// since 001-008 are already recorded as applied) without touching any
		// pre-existing table's data.
		runMigrations(core);

		expect(core.tableExists("files")).toBe(true);
		expect(core.tableExists("files_fts")).toBe(true);
		const appliedVersions = core.all("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version);
		expect(appliedVersions).toContain(9);

		rawDb.close();
	});

	it("has the environment_id and (root, last_seen_at) indexes the store's own queries rely on", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const indexNames = db
			.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'files'")
			.map((row) => row.name);
		expect(indexNames).toContain("idx_files_environment_id");
		expect(indexNames).toContain("idx_files_root_last_seen");
		expect(indexNames).toContain("idx_files_name");
	});
});
