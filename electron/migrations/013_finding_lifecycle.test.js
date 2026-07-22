import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { Database } from "node-sqlite3-wasm";
import { wrapDatabase } from "./sqlite-helpers.cjs";
import { runMigrations, MIGRATIONS } from "./index.cjs";
import { AtlasDatabase } from "../db.cjs";

// ---------------------------------------------------------------------------
// Migration 013 (WP-3.4) -- the finding lifecycle columns on `findings`:
// ignore_count, suppressed_until, suggested_at, decided_at, accepted_rule_id.
// See this migration's own header for what each column means and why it's
// safe to ADD COLUMN rather than rebuild the table.
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migration-013-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("migration 013 -- finding lifecycle columns", () => {
	it("is registered in the MIGRATIONS array as version 13", () => {
		const migration = MIGRATIONS.find((m) => m.name === "013_finding_lifecycle");
		expect(migration).toBeDefined();
		expect(migration.version).toBe(13);
	});

	it("a freshly created database has every lifecycle column on findings, with the documented defaults", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const columns = db.all("PRAGMA table_info(findings)");
		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

		expect(byName.ignore_count).toBeDefined();
		expect(byName.ignore_count.notnull).toBe(1);
		expect(byName.suppressed_until).toBeDefined();
		expect(byName.suggested_at).toBeDefined();
		expect(byName.decided_at).toBeDefined();
		expect(byName.accepted_rule_id).toBeDefined();

		const indexNames = db
			.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'findings'")
			.map((row) => row.name);
		expect(indexNames).toContain("idx_findings_accepted_rule_id");
	});

	it("existing findings rows default ignore_count to 0 and every new column to NULL", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO findings
				(id, environment_id, pattern_type, trigger_type, follow_type, window_minutes,
				 occurrences, trials, confidence, baseline_probability, lift, p_value, created_at, updated_at)
			 VALUES ('f1', 'env-a', 'sequential_co_occurrence', 'app.focus', 'app.focus', 30, 5, 10, 0.5, 0.1, 5, 0.001, ?, ?)`,
			[now, now],
		);
		const row = db.first("SELECT * FROM findings WHERE id = 'f1'");
		expect(row.ignore_count).toBe(0);
		expect(row.suppressed_until).toBeNull();
		expect(row.suggested_at).toBeNull();
		expect(row.decided_at).toBeNull();
		expect(row.accepted_rule_id).toBeNull();
	});

	it("applies cleanly on top of a database that only has migrations 001-012 (the real upgrade path)", () => {
		const rawDb = new Database(createTempDbPath());
		const core = wrapDatabase(rawDb);
		const earlierMigrations = MIGRATIONS.filter((m) => m.version <= 12);

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

		expect(core.columnExists("findings", "ignore_count")).toBe(false);

		runMigrations(core);

		expect(core.columnExists("findings", "ignore_count")).toBe(true);
		expect(core.columnExists("findings", "accepted_rule_id")).toBe(true);
		const appliedVersions = core.all("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version);
		expect(appliedVersions).toContain(13);

		rawDb.close();
	});

	it("running the migration twice does not throw (idempotent ADD COLUMN guard)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const migration = MIGRATIONS.find((m) => m.name === "013_finding_lifecycle");
		expect(() => migration.up(db)).not.toThrow();
	});
});
