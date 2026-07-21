import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { readLegacyNotchPreferences, seedGlobalDefaultNotchLayoutIfNeeded } from "./notch-layout-seed.cjs";
import { GLOBAL_DEFAULT_NOTCH_LAYOUT_ID } from "../config/notch-layouts.cjs";
import { defaultNotchPreferences, NOTCH_PREFS_FILE } from "../config/notch-prefs.cjs";
import { AtlasDatabase } from "../db.cjs";

// ---------------------------------------------------------------------------
// The one-time seed of the global default Notch layout from the pre-existing
// flat notch-preferences.json file (WP-1.3). THE RISK THAT MATTERS MOST for
// this whole work package: an existing user's carefully configured Notch
// must become the new default UNTOUCHED. Every test here is either proving
// that promise or proving the "never overwrite, never destroy" half of it.
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-notch-seed-test-"));
	tmpDirs.push(dir);
	return dir;
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// A minimal in-memory "core" -- just enough of the run/first contract the
// seed function needs -- so these tests can exercise the seeding logic
// without a real sqlite connection.
function createFakeNotchLayoutsCore() {
	const rows = new Map();
	return {
		rows,
		first(sql, params = []) {
			if (sql.startsWith("SELECT id FROM notch_layouts")) {
				const row = rows.get(params[0]);
				return row ? { id: row.id } : null;
			}
			return null;
		},
		run(sql, params = []) {
			if (sql.startsWith("INSERT INTO notch_layouts")) {
				const [id, data, created_at, updated_at] = params;
				rows.set(id, { id, data, created_at, updated_at });
			}
		},
	};
}

describe("readLegacyNotchPreferences", () => {
	it("returns schema defaults when no legacy file exists", () => {
		const dir = createTempDir();
		const dbPath = path.join(dir, "atlas.db");
		expect(readLegacyNotchPreferences(dbPath)).toEqual(defaultNotchPreferences);
	});

	it("reads and parses a realistic, non-default legacy file exactly", () => {
		const dir = createTempDir();
		const dbPath = path.join(dir, "atlas.db");
		const realistic = {
			...defaultNotchPreferences,
			position: "free",
			x: 640,
			y: 12,
			idleOpacity: "solid",
			locked: true,
			tabs: [
				{
					id: "custom-tab",
					label: "My Stuff",
					icon: "StarIcon",
					gridCols: 6,
					gridRows: 2,
					placements: [{ id: "p1", widget: "timerDisplay", x: 0, y: 0, w: 2, h: 1 }],
				},
			],
		};
		fs.writeFileSync(path.join(dir, NOTCH_PREFS_FILE), JSON.stringify(realistic, null, 2), "utf8");

		expect(readLegacyNotchPreferences(dbPath)).toEqual(realistic);
	});

	it("falls back to schema defaults for a corrupt/unreadable legacy file, never throwing", () => {
		const dir = createTempDir();
		const dbPath = path.join(dir, "atlas.db");
		fs.writeFileSync(path.join(dir, NOTCH_PREFS_FILE), "{not valid json at all", "utf8");

		expect(() => readLegacyNotchPreferences(dbPath)).not.toThrow();
		expect(readLegacyNotchPreferences(dbPath)).toEqual(defaultNotchPreferences);
	});
});

describe("seedGlobalDefaultNotchLayoutIfNeeded", () => {
	it("seeds the default row from an existing legacy file", () => {
		const dir = createTempDir();
		const dbPath = path.join(dir, "atlas.db");
		const realistic = { ...defaultNotchPreferences, position: "left", idleOpacity: "solid" };
		fs.writeFileSync(path.join(dir, NOTCH_PREFS_FILE), JSON.stringify(realistic), "utf8");

		const core = createFakeNotchLayoutsCore();
		const seeded = seedGlobalDefaultNotchLayoutIfNeeded(core, dbPath);

		expect(seeded).toBe(true);
		const row = core.rows.get(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID);
		expect(row).toBeDefined();
		expect(JSON.parse(row.data)).toEqual(realistic);
	});

	it("seeds schema defaults when there is no legacy file (a fresh install)", () => {
		const dir = createTempDir();
		const dbPath = path.join(dir, "atlas.db");

		const core = createFakeNotchLayoutsCore();
		seedGlobalDefaultNotchLayoutIfNeeded(core, dbPath);

		const row = core.rows.get(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID);
		expect(JSON.parse(row.data)).toEqual(defaultNotchPreferences);
	});

	it("is a no-op when a default row already exists -- never overwrites a later user edit with a stale legacy file", () => {
		const dir = createTempDir();
		const dbPath = path.join(dir, "atlas.db");
		fs.writeFileSync(
			path.join(dir, NOTCH_PREFS_FILE),
			JSON.stringify({ ...defaultNotchPreferences, position: "left" }),
			"utf8",
		);

		const core = createFakeNotchLayoutsCore();
		const alreadyThere = { position: "right", edited: true };
		core.run("INSERT INTO notch_layouts (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			GLOBAL_DEFAULT_NOTCH_LAYOUT_ID,
			JSON.stringify(alreadyThere),
			"2024-01-01T00:00:00.000Z",
			"2024-01-01T00:00:00.000Z",
		]);

		const seeded = seedGlobalDefaultNotchLayoutIfNeeded(core, dbPath);

		expect(seeded).toBe(false);
		expect(JSON.parse(core.rows.get(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID).data)).toEqual(alreadyThere);
	});
});

describe("seedGlobalDefaultNotchLayoutIfNeeded -- through a real AtlasDatabase", () => {
	const tmpDbDirs = [];
	afterEach(() => {
		while (tmpDbDirs.length > 0) {
			fs.rmSync(tmpDbDirs.pop(), { recursive: true, force: true });
		}
	});
	const createTempDbPath = () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-notch-seed-db-test-"));
		tmpDbDirs.push(dir);
		return path.join(dir, "atlas.db");
	};

	it("populates the notch_layouts table on first boot against a directory with an existing notch-preferences.json", async () => {
		const dbPath = createTempDbPath();
		const realistic = {
			...defaultNotchPreferences,
			position: "free",
			x: 200,
			y: 40,
			idleOpacity: "solid",
		};
		fs.writeFileSync(path.join(path.dirname(dbPath), NOTCH_PREFS_FILE), JSON.stringify(realistic), "utf8");

		const db = await AtlasDatabase.create(dbPath);
		const row = db.first("SELECT data FROM notch_layouts WHERE id = ?", [GLOBAL_DEFAULT_NOTCH_LAYOUT_ID]);
		expect(row).toBeDefined();
		expect(JSON.parse(row.data)).toEqual(realistic);

		// The legacy file itself must still be there -- never deleted by the
		// migration/seed step.
		expect(fs.existsSync(path.join(path.dirname(dbPath), NOTCH_PREFS_FILE))).toBe(true);
	});

	it("does not re-seed (and so cannot clobber a later edit) on a second AtlasDatabase.create() against the same path", async () => {
		const dbPath = createTempDbPath();
		fs.writeFileSync(
			path.join(path.dirname(dbPath), NOTCH_PREFS_FILE),
			JSON.stringify({ ...defaultNotchPreferences, position: "left" }),
			"utf8",
		);

		const first = await AtlasDatabase.create(dbPath);
		// Simulate the user editing their (now-seeded) default layout.
		first.setNotchLayout(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID, { ...defaultNotchPreferences, position: "right" });

		const second = await AtlasDatabase.create(dbPath);
		const row = second.first("SELECT data FROM notch_layouts WHERE id = ?", [GLOBAL_DEFAULT_NOTCH_LAYOUT_ID]);
		expect(JSON.parse(row.data).position).toBe("right");
	});
});
