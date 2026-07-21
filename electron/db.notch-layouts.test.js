import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { AtlasDatabase } from "./db.cjs";
import { GLOBAL_DEFAULT_NOTCH_LAYOUT_ID } from "./config/notch-layouts.cjs";
import { defaultNotchPreferences } from "./config/notch-prefs.cjs";

// ---------------------------------------------------------------------------
// Per-environment Notch layout storage and resolution (WP-1.3), exercised
// through a real AtlasDatabase (temp file, never the user's real userData --
// see createTempDbPath below).
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-notch-layouts-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("getEffectiveNotchPreferences -- resolution", () => {
	it("a brand-new environment (no override) resolves to the global default", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env A");

		const resolved = db.getEffectiveNotchPreferences(environment.id);

		expect(resolved.usesDefault).toBe(true);
		expect(resolved.layoutId).toBe(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID);
		expect(resolved.preferences).toEqual(defaultNotchPreferences);
	});

	it("null/no environment id resolves straight to the global default", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		db.updateGlobalDefaultNotchLayout({ position: "left" });

		expect(db.getEffectiveNotchPreferences(null).preferences.position).toBe("left");
		expect(db.getEffectiveNotchPreferences(undefined).preferences.position).toBe("left");
	});

	it("an environment with its own layout resolves to that layout, not the default", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env B");
		db.updateGlobalDefaultNotchLayout({ position: "top" });

		const own = db.setEnvironmentNotchLayout(environment.id, { position: "right", locked: true });
		expect(own.usesDefault).toBe(false);

		const resolved = db.getEffectiveNotchPreferences(environment.id);
		expect(resolved.usesDefault).toBe(false);
		expect(resolved.layoutId).toBe(own.layoutId);
		expect(resolved.preferences.position).toBe("right");
		expect(resolved.preferences.locked).toBe(true);

		// The global default is completely unaffected by the override.
		expect(db.getEffectiveNotchPreferences(null).preferences.position).toBe("top");
	});

	it("clearing an override reverts the environment to the (untouched) default", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env C");
		db.setEnvironmentNotchLayout(environment.id, { position: "free" });
		expect(db.getEffectiveNotchPreferences(environment.id).usesDefault).toBe(false);

		const cleared = db.clearEnvironmentNotchLayout(environment.id);

		expect(cleared.usesDefault).toBe(true);
		expect(cleared.layoutId).toBe(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID);
		expect(cleared.preferences.position).toBe(defaultNotchPreferences.position);
	});

	it("falls back to the default when notchLayoutId points at a row that no longer exists", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env D");
		db.setEnvironmentConfig(environment.id, { notchLayoutId: "some-id-that-was-never-created" });

		const resolved = db.getEffectiveNotchPreferences(environment.id);
		expect(resolved.usesDefault).toBe(true);
		expect(resolved.preferences).toEqual(defaultNotchPreferences);
	});

	it("defensively parses a malformed stored layout row rather than throwing", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env E");
		const now = new Date().toISOString();
		db.run("INSERT INTO notch_layouts (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			"corrupt-layout-id",
			"{not valid json at all",
			now,
			now,
		]);
		db.setEnvironmentConfig(environment.id, { notchLayoutId: "corrupt-layout-id" });

		expect(() => db.getEffectiveNotchPreferences(environment.id)).not.toThrow();
		const resolved = db.getEffectiveNotchPreferences(environment.id);
		// It still counts as "has its own layout" (the id IS set and the row DOES
		// exist) -- the row's unparseable contents fall back to schema defaults,
		// they don't make the environment silently inherit the global default.
		expect(resolved.usesDefault).toBe(false);
		expect(resolved.layoutId).toBe("corrupt-layout-id");
		expect(resolved.preferences).toEqual(defaultNotchPreferences);
	});
});

describe("setEnvironmentNotchLayout", () => {
	it("reuses the same layout id across repeated edits instead of orphaning a new row each time", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env F");

		const first = db.setEnvironmentNotchLayout(environment.id, { position: "left" });
		const second = db.setEnvironmentNotchLayout(environment.id, { locked: true });

		expect(second.layoutId).toBe(first.layoutId);
		expect(second.preferences.position).toBe("left"); // preserved from the first edit
		expect(second.preferences.locked).toBe(true);
		expect(db.all("SELECT id FROM notch_layouts").length).toBe(2); // default + this one own row
	});

	it("throws for a nonexistent environment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		expect(() => db.setEnvironmentNotchLayout("no-such-environment", {})).toThrow("Environment not found.");
	});
});

describe("deleteEnvironment -- Notch layout cleanup", () => {
	it("deletes an environment's own layout row when the environment is deleted", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env G");
		const own = db.setEnvironmentNotchLayout(environment.id, { position: "left" });
		expect(db.getNotchLayoutRow(own.layoutId)).not.toBeNull();

		db.deleteEnvironment(environment.id);

		expect(db.getNotchLayoutRow(own.layoutId)).toBeNull();
	});

	it("never deletes the global default row, even if somehow referenced", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env H");
		// Not a realistic state (the default's id is never assigned as an
		// environment's own notchLayoutId in normal operation), but defends the
		// invariant explicitly rather than relying on it never happening.
		db.setEnvironmentConfig(environment.id, { notchLayoutId: GLOBAL_DEFAULT_NOTCH_LAYOUT_ID });

		db.deleteEnvironment(environment.id);

		expect(db.getNotchLayoutRow(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID)).not.toBeNull();
	});

	it("deleting an environment that never had its own layout does not touch the default", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		db.updateGlobalDefaultNotchLayout({ position: "left" });
		const environment = db.createEnvironment("Env I");

		db.deleteEnvironment(environment.id);

		expect(db.getEffectiveNotchPreferences(null).preferences.position).toBe("left");
	});
});
