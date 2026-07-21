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

// ---------------------------------------------------------------------------
// Migration 006 (WP-1.3) -- adds the `notch_layouts` table. As with every
// other migration, D3 requires that an existing user's database upgrades
// with nothing dropped: this one only ever CREATEs a brand new table, so
// there is no pre-existing column or row it could possibly disturb.
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migration-006-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("migration 006 -- notch_layouts", () => {
	it("creates the table with the expected columns on a fresh database", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		expect(db.tableExists("notch_layouts")).toBe(true);
		for (const column of ["id", "data", "created_at", "updated_at"]) {
			expect(db.columnExists("notch_layouts", column)).toBe(true);
		}
	});

	it("migrates a database that only has migrations 001-005 applied, adding the table with no data loss elsewhere", () => {
		// Exactly how a real user's database looks the moment before upgrading
		// to a build that includes WP-1.3.
		const rawDb = new Database(createTempDbPath());
		const core = wrapDatabase(rawDb);
		core.transaction(() => {
			core.run(
				"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
			);
			for (const migration of [migration001, migration002, migration003, migration004, migration005]) {
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
		expect(core.tableExists("notch_layouts")).toBe(false);

		runMigrations(core);

		expect(core.tableExists("notch_layouts")).toBe(true);
		// The pre-existing environment row is completely untouched.
		const row = core.first("SELECT * FROM environments WHERE id = ?", ["pre-existing-env"]);
		expect(row).toMatchObject({
			id: "pre-existing-env",
			name: "Old User's Environment",
			icon: "book",
			accent: "#ff8800",
			preset: "study",
		});

		rawDb.close();
	});

	it("running the migration set twice is a no-op (idempotent)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		expect(() => runMigrations(db)).not.toThrow();
		expect(db.tableExists("notch_layouts")).toBe(true);
	});

	it("supports the upsert (ON CONFLICT DO UPDATE) db.cjs relies on for saving a layout", async () => {
		// A fresh AtlasDatabase already auto-seeds the "default" row (WP-1.3's
		// notch-layout-seed.cjs, run from the constructor) -- use a different id
		// here so this test's own manual first INSERT is exercising a genuinely
		// new row, not colliding with that seed.
		const db = await AtlasDatabase.create(createTempDbPath());
		const now = new Date().toISOString();
		db.run("INSERT INTO notch_layouts (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			"upsert-test-row",
			JSON.stringify({ position: "top" }),
			now,
			now,
		]);
		expect(() =>
			db.run(
				`INSERT INTO notch_layouts (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
				["upsert-test-row", JSON.stringify({ position: "left" }), now, now],
			),
		).not.toThrow();
		const row = db.first("SELECT data FROM notch_layouts WHERE id = ?", ["upsert-test-row"]);
		expect(JSON.parse(row.data)).toEqual({ position: "left" });
		// Still exactly one row for this id -- the upsert updated in place, it
		// did not insert a duplicate.
		expect(db.all("SELECT id FROM notch_layouts WHERE id = ?", ["upsert-test-row"]).length).toBe(1);
	});
});
