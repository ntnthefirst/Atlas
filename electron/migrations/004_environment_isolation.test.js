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

// ---------------------------------------------------------------------------
// Migration 004 (WP-0.8) -- adds `environments.isolation_mode`. The two
// things D3 requires of every schema change: existing rows migrate with
// identical data and no surprise behaviour change, and the new constraint
// actually constrains (a CHECK that doesn't reject a bad value is not a
// constraint, just a comment).
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migration-004-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("migration 004 -- environments.isolation_mode", () => {
	it("adds the column with a NOT NULL DEFAULT of 'connected'", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		expect(db.columnExists("environments", "isolation_mode")).toBe(true);

		const environment = db.createEnvironment("Fresh environment");
		expect(db.getEnvironmentIsolationMode(environment.id)).toBe("connected");
	});

	it("migrates an environment created before this migration ran to 'connected', with the row otherwise untouched", () => {
		// Build a database that only has migrations 001-003 applied, exactly as
		// a real user's database would look the moment before upgrading to a
		// build that includes WP-0.8 -- then insert a row the old way (no
		// isolation_mode column exists yet), then run the full migration set.
		const rawDb = new Database(createTempDbPath());
		const core = wrapDatabase(rawDb);
		core.transaction(() => {
			core.run(
				"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
			);
			for (const migration of [migration001, migration002, migration003]) {
				migration.up(core);
				core.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
					migration.version,
					migration.name,
					new Date().toISOString(),
				]);
			}
		});

		core.run("INSERT INTO environments (id, name, created_at) VALUES (?, ?, ?)", [
			"pre-existing-env",
			"Old User's Environment",
			"2024-01-01T00:00:00.000Z",
		]);
		expect(core.columnExists("environments", "isolation_mode")).toBe(false);

		// Now bring it up to date, the same way AtlasDatabase.create() does on
		// every boot.
		runMigrations(core);

		const row = core.first("SELECT * FROM environments WHERE id = ?", ["pre-existing-env"]);
		expect(row).toMatchObject({
			id: "pre-existing-env",
			name: "Old User's Environment",
			created_at: "2024-01-01T00:00:00.000Z",
			isolation_mode: "connected",
		});

		rawDb.close();
	});

	it("rejects any value other than 'connected' or 'enclosed' -- the CHECK constraint actually constrains", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Test env");

		expect(() => db.run("UPDATE environments SET isolation_mode = 'invisible' WHERE id = ?", [environment.id])).toThrow(
			/CHECK constraint failed/i,
		);
		expect(() => db.run("UPDATE environments SET isolation_mode = NULL WHERE id = ?", [environment.id])).toThrow();

		// Untouched by the rejected writes.
		expect(db.getEnvironmentIsolationMode(environment.id)).toBe("connected");
	});

	it("running the migration set twice is a no-op (idempotent)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Test env");

		// AtlasDatabase.create() already ran every migration once; simulate a
		// second boot against the same (already current) database. AtlasDatabase
		// itself exposes run/all/first/tableExists/columnExists/transaction, the
		// same shape runMigrations() expects, so it can be passed directly.
		expect(() => runMigrations(db)).not.toThrow();
		expect(db.getEnvironmentIsolationMode(environment.id)).toBe("connected");
	});
});
