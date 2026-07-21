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

// ---------------------------------------------------------------------------
// Migration 005 (WP-1.1) -- adds `environments.config`. As with migration
// 004, the two things D3 requires of every schema change: existing rows
// migrate with identical data (nothing dropped, nothing backfilled in SQL),
// and the new column actually round-trips through the app's own read path
// once application code (db.cjs#getEnvironmentConfig) resolves the NULL a
// pre-existing row gets into sensible, non-destructive defaults.
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migration-005-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("migration 005 -- environments.config", () => {
	it("adds a nullable TEXT column, defaulting to NULL for a freshly created environment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		expect(db.columnExists("environments", "config")).toBe(true);

		const environment = db.createEnvironment("Fresh environment");
		const row = db.first("SELECT config FROM environments WHERE id = ?", [environment.id]);
		expect(row.config).toBeNull();
	});

	it("migrates an environment created before this migration ran, with every other column untouched and config landing NULL (never a backfilled blob)", () => {
		// Build a database that only has migrations 001-004 applied -- exactly
		// how a real user's database looks the moment before upgrading to a
		// build that includes WP-1.1 -- then insert a row the old way (no
		// `config` column exists yet), then run the full migration set.
		const rawDb = new Database(createTempDbPath());
		const core = wrapDatabase(rawDb);
		core.transaction(() => {
			core.run(
				"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
			);
			for (const migration of [migration001, migration002, migration003, migration004]) {
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
		expect(core.columnExists("environments", "config")).toBe(false);

		// Now bring it up to date, the same way AtlasDatabase.create() does on
		// every boot.
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
			config: null,
		});

		rawDb.close();
	});

	it("resolves a NULL config into defaults seeded from the row's own icon/accent/preset once opened through AtlasDatabase, never resetting the accent", async () => {
		const dbPath = createTempDbPath();
		const rawDb = new Database(dbPath);
		const core = wrapDatabase(rawDb);
		core.transaction(() => {
			core.run(
				"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
			);
			for (const migration of [migration001, migration002, migration003, migration004]) {
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

		// Reopen exactly as the real app would on the next launch -- through
		// AtlasDatabase.create(), the same path that runs migration 005 and
		// leaves `config` at NULL for this pre-existing row.
		const reopened = await AtlasDatabase.create(dbPath);
		expect(reopened.first("SELECT config FROM environments WHERE id = ?", ["pre-existing-env-2"]).config).toBeNull();

		const config = reopened.getEnvironmentConfig("pre-existing-env-2");
		expect(config.appearance.accent).toBe("#10b981");
		expect(config.version).toBe(1);
	});

	it("running the migration set twice is a no-op (idempotent)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Test env");

		expect(() => runMigrations(db)).not.toThrow();
		expect(db.first("SELECT config FROM environments WHERE id = ?", [environment.id]).config).toBeNull();
	});
});
