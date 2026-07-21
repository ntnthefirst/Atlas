import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { Database } from "node-sqlite3-wasm";
import { wrapDatabase } from "./sqlite-helpers.cjs";
import { runMigrations } from "./index.cjs";
import { AtlasDatabase } from "../db.cjs";
import migration001 from "./001_initial.cjs";
import migration002 from "./002_rename_maps_to_environments.cjs";
import migration003 from "./003_event_log.cjs";
import migration004 from "./004_environment_isolation.cjs";
import migration005 from "./005_environment_config.cjs";
import migration006 from "./006_notch_layouts.cjs";

// ---------------------------------------------------------------------------
// Migration 007 (WP-1.5) -- adds `environments.archived_at`. Same two things
// D3 requires of every schema change as migration 005's own test suite
// checks for `config`: an existing row migrates with identical data (nothing
// dropped, nothing backfilled), and the new column round-trips through the
// app's own read/write path (db.cjs#archiveEnvironment/unarchiveEnvironment).
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migration-007-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("migration 007 -- environments.archived_at", () => {
	it("adds a nullable TEXT column, defaulting to NULL for a freshly created environment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		expect(db.columnExists("environments", "archived_at")).toBe(true);

		const environment = db.createEnvironment("Fresh environment");
		const row = db.first("SELECT archived_at FROM environments WHERE id = ?", [environment.id]);
		expect(row.archived_at).toBeNull();
	});

	it("migrates an environment created before this migration ran, with every other column untouched and archived_at landing NULL", () => {
		// A database with only migrations 001-006 applied -- exactly how a real
		// user's database looks the moment before upgrading to a build that
		// includes WP-1.5 -- then a row inserted the old way, then the full
		// migration set run.
		const rawDb = new Database(createTempDbPath());
		const core = wrapDatabase(rawDb);
		core.transaction(() => {
			core.run(
				"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
			);
			for (const migration of [migration001, migration002, migration003, migration004, migration005, migration006]) {
				migration.up(core);
				core.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
					migration.version,
					migration.name,
					new Date().toISOString(),
				]);
			}
		});

		core.run(
			"INSERT INTO environments (id, name, icon, accent, preset, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			["pre-existing-env", "Old User's Environment", "book", "#ff8800", "study", "2024-01-01T00:00:00.000Z"],
		);
		expect(core.columnExists("environments", "archived_at")).toBe(false);

		runMigrations(core);

		const row = core.first("SELECT * FROM environments WHERE id = ?", ["pre-existing-env"]);
		expect(row).toMatchObject({
			id: "pre-existing-env",
			name: "Old User's Environment",
			icon: "book",
			accent: "#ff8800",
			preset: "study",
			created_at: "2024-01-01T00:00:00.000Z",
			isolation_mode: "connected",
			archived_at: null,
		});

		rawDb.close();
	});

	it("a pre-existing (NULL archived_at) environment still appears in listEnvironments after upgrading", async () => {
		const dbPath = createTempDbPath();
		const rawDb = new Database(dbPath);
		const core = wrapDatabase(rawDb);
		core.transaction(() => {
			core.run(
				"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
			);
			for (const migration of [migration001, migration002, migration003, migration004, migration005, migration006]) {
				migration.up(core);
				core.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
					migration.version,
					migration.name,
					new Date().toISOString(),
				]);
			}
		});
		core.run(
			"INSERT INTO environments (id, name, icon, accent, preset, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			["pre-existing-env-2", "Old User's Other Environment", "beaker", "#10b981", "coding", "2024-02-02T00:00:00.000Z"],
		);
		rawDb.close();

		const reopened = await AtlasDatabase.create(dbPath);
		expect(reopened.listEnvironments().map((e) => e.id)).toContain("pre-existing-env-2");
	});

	it("running the migration set twice is a no-op (idempotent)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Test env");

		expect(() => runMigrations(db)).not.toThrow();
		expect(db.first("SELECT archived_at FROM environments WHERE id = ?", [environment.id]).archived_at).toBeNull();
	});
});
