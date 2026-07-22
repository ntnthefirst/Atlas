import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { Database } from "node-sqlite3-wasm";
import { wrapDatabase } from "./sqlite-helpers.cjs";
import { runMigrations, MIGRATIONS } from "./index.cjs";
import { AtlasDatabase } from "../db.cjs";

// ---------------------------------------------------------------------------
// Migration 011 (WP-3.1) -- the smart_functions table.
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migration-011-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("migration 011 -- smart_functions table", () => {
	it("is registered in the MIGRATIONS array as version 11", () => {
		const migration = MIGRATIONS.find((m) => m.name === "011_smart_functions");
		expect(migration).toBeDefined();
		expect(migration.version).toBe(11);
	});

	it("a freshly created database has the table, its columns, and the environment index", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		expect(db.tableExists("smart_functions")).toBe(true);

		for (const column of [
			"id",
			"environment_id",
			"label",
			"enabled",
			"trigger",
			"conditions",
			"actions",
			"source",
			"migrated_from",
			"created_at",
			"updated_at",
		]) {
			expect(db.columnExists("smart_functions", column)).toBe(true);
		}

		const indexNames = db
			.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'smart_functions'")
			.map((row) => row.name);
		expect(indexNames).toContain("idx_smart_functions_environment_id");
	});

	it("environment_id is nullable (global rule) and migrated_from enforces uniqueness", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const now = new Date().toISOString();

		db.run(
			`INSERT INTO smart_functions (id, environment_id, label, trigger, conditions, actions, migrated_from, created_at, updated_at)
			 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
			["sf-1", "Global rule", JSON.stringify({ type: "manual" }), "[]", "[]", "layout-1:placement-1", now, now],
		);
		expect(db.first("SELECT * FROM smart_functions WHERE id = ?", ["sf-1"]).environment_id).toBeNull();

		expect(() =>
			db.run(
				`INSERT INTO smart_functions (id, label, trigger, conditions, actions, migrated_from, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["sf-2", "Duplicate migration source", JSON.stringify({ type: "manual" }), "[]", "[]", "layout-1:placement-1", now, now],
			),
		).toThrow();
	});

	it("applies cleanly on top of a database that only has migrations 001-010 (the real upgrade path)", () => {
		const rawDb = new Database(createTempDbPath());
		const core = wrapDatabase(rawDb);
		const earlierMigrations = MIGRATIONS.filter((m) => m.version <= 10);

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
		expect(core.tableExists("smart_functions")).toBe(false);

		runMigrations(core);

		expect(core.tableExists("smart_functions")).toBe(true);
		const appliedVersions = core.all("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version);
		expect(appliedVersions).toContain(11);

		rawDb.close();
	});
});
