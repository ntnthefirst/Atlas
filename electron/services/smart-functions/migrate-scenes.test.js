import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { GLOBAL_DEFAULT_NOTCH_LAYOUT_ID } from "../../config/notch-layouts.cjs";
import { parseSceneConfigForMigration, sceneHasActions, sceneToActions, migrateScenes } from "./migrate-scenes.cjs";
import { listAllRules, findByMigratedFrom } from "./store.cjs";

// ---------------------------------------------------------------------------
// Scene -> smart function migration (WP-3.1). Uses a real AtlasDatabase so
// the scene lives inside a real `notch_layouts.data` blob, exactly where
// src/scenes.ts says it does -- never a hand-rolled row shape that might
// drift from what db.cjs#setNotchLayout actually normalizes and stores.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migrate-scenes-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const createDb = () => AtlasDatabase.create(createTempDbPath());

function sceneTab(sceneConfig, placementId = "scene-1") {
	return {
		id: "scenes-tab",
		label: "Scenes",
		icon: "RocketLaunchIcon",
		gridCols: 5,
		gridRows: 1,
		placements: [{ id: placementId, widget: "scene", x: 0, y: 0, w: 1, h: 1, config: JSON.stringify(sceneConfig) }],
	};
}

const fullScene = {
	label: "Deep work",
	icon: "RocketLaunchIcon",
	apps: ["code.exe", "  "], // a blank entry mixed in on purpose -- must be dropped, not migrated as an action
	urls: ["https://example.com"],
	timer: "start",
	environmentId: "",
	tasks: [{ title: "Write the spec", column: "todo" }, { title: "   " }], // blank task title must be dropped
};

describe("parseSceneConfigForMigration (mirrors src/scenes.ts#parseSceneConfig)", () => {
	it("parses a well-formed config", () => {
		const scene = parseSceneConfigForMigration(JSON.stringify(fullScene));
		expect(scene.label).toBe("Deep work");
		expect(scene.apps).toEqual(["code.exe", "  "]);
		expect(scene.timer).toBe("start");
	});

	it("falls back to inert defaults for malformed JSON -- never throws", () => {
		const scene = parseSceneConfigForMigration("{not valid json");
		expect(scene).toEqual({ label: "New scene", icon: "RocketLaunchIcon", apps: [], urls: [], timer: "none", environmentId: "", tasks: [] });
	});

	it("falls back to inert defaults for missing/undefined config", () => {
		expect(parseSceneConfigForMigration(undefined).apps).toEqual([]);
		expect(parseSceneConfigForMigration("").apps).toEqual([]);
	});
});

describe("sceneHasActions / sceneToActions", () => {
	it("an inert scene (no apps/urls/tasks/timer/environment) has no actions", () => {
		const inert = { label: "Empty", icon: "x", apps: [], urls: [], timer: "none", environmentId: "", tasks: [] };
		expect(sceneHasActions(inert)).toBe(false);
		expect(sceneToActions(inert)).toEqual([]);
	});

	it("converts every field into its action, in runScene's own order, dropping blanks", () => {
		expect(sceneHasActions(fullScene)).toBe(true);
		expect(sceneToActions(fullScene)).toEqual([
			{ type: "timer", mode: "start" },
			{ type: "createTask", title: "Write the spec", column: "todo" },
			{ type: "launchApp", command: "code.exe" },
			{ type: "openUrl", url: "https://example.com" },
		]);
	});

	it("switchEnvironment comes first when the scene has one", () => {
		const scene = { ...fullScene, environmentId: "env-a" };
		expect(sceneToActions(scene)[0]).toEqual({ type: "switchEnvironment", environmentId: "env-a" });
	});
});

describe("migrateScenes -- end to end against a real database", () => {
	it("migrates a scene placement on the global default layout into a global (environmentId: null) smart function", async () => {
		const db = await createDb();
		db.updateGlobalDefaultNotchLayout({ tabs: [sceneTab(fullScene)] });

		const result = migrateScenes(db);

		expect(result.migrated).toBe(1);
		expect(result.alreadyMigrated).toBe(0);

		const rules = listAllRules(db);
		expect(rules).toHaveLength(1);
		expect(rules[0].label).toBe("Deep work");
		expect(rules[0].source).toBe("migrated-scene");
		expect(rules[0].environmentId).toBeNull();
		expect(rules[0].trigger).toEqual({ type: "manual" });
		expect(rules[0].migratedFrom).toBe(`${GLOBAL_DEFAULT_NOTCH_LAYOUT_ID}:scene-1`);
	});

	it("scopes the migrated rule to the SINGLE environment that owns a non-shared layout", async () => {
		const db = await createDb();
		const environment = db.createEnvironment("Design");
		db.setEnvironmentNotchLayout(environment.id, { tabs: [sceneTab(fullScene)] });

		migrateScenes(db);

		const [rule] = listAllRules(db);
		expect(rule.environmentId).toBe(environment.id);
	});

	it("is idempotent -- re-running it never duplicates an already-migrated scene", async () => {
		const db = await createDb();
		db.updateGlobalDefaultNotchLayout({ tabs: [sceneTab(fullScene)] });

		const first = migrateScenes(db);
		const second = migrateScenes(db);

		expect(first.migrated).toBe(1);
		expect(second.migrated).toBe(0);
		expect(second.alreadyMigrated).toBe(1);
		expect(listAllRules(db)).toHaveLength(1); // still exactly one, not two
	});

	it("never touches the original placement -- the scene config in notch_layouts is untouched after migration", async () => {
		const db = await createDb();
		const before = JSON.stringify(sceneTab(fullScene));
		db.updateGlobalDefaultNotchLayout({ tabs: [sceneTab(fullScene)] });
		const rowBefore = db.getNotchLayoutRow(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID);

		migrateScenes(db);

		const rowAfter = db.getNotchLayoutRow(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID);
		expect(rowAfter.data).toBe(rowBefore.data);
		expect(JSON.parse(rowAfter.data).tabs[0].placements[0].config).toBe(JSON.stringify(fullScene));
		void before;
	});

	it("a scene with no actions at all is skipped, not migrated as an empty rule", async () => {
		const db = await createDb();
		const inert = { label: "Empty", icon: "x", apps: [], urls: [], timer: "none", environmentId: "", tasks: [] };
		db.updateGlobalDefaultNotchLayout({ tabs: [sceneTab(inert)] });

		const result = migrateScenes(db);

		expect(result.migrated).toBe(0);
		expect(result.skipped).toBe(1);
		expect(listAllRules(db)).toHaveLength(0);
	});

	it("a layout row whose data fails to parse is skipped, never thrown, and every other layout still migrates", async () => {
		const db = await createDb();
		db.updateGlobalDefaultNotchLayout({ tabs: [sceneTab(fullScene)] });
		db.run("INSERT INTO notch_layouts (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			"corrupted-layout",
			"{not valid json at all",
			new Date().toISOString(),
			new Date().toISOString(),
		]);

		expect(() => migrateScenes(db)).not.toThrow();
		const result = migrateScenes(db);
		// Second call: the good layout is already migrated, the corrupted one is
		// (still) skipped -- proving the corrupted row didn't take the whole
		// pass down with it on either run.
		expect(result.alreadyMigrated).toBe(1);
		expect(listAllRules(db)).toHaveLength(1);
	});

	it("a non-scene widget placement is never migrated", async () => {
		const db = await createDb();
		db.updateGlobalDefaultNotchLayout({
			tabs: [
				{
					id: "tab-1",
					label: "Tab",
					icon: "RocketLaunchIcon",
					gridCols: 5,
					gridRows: 1,
					placements: [{ id: "p1", widget: "timerDisplay", x: 0, y: 0, w: 1, h: 1 }],
				},
			],
		});

		const result = migrateScenes(db);
		expect(result.migrated).toBe(0);
		expect(listAllRules(db)).toHaveLength(0);
	});

	it("findByMigratedFrom locates the exact migrated rule by its layout:placement key", async () => {
		const db = await createDb();
		db.updateGlobalDefaultNotchLayout({ tabs: [sceneTab(fullScene)] });
		migrateScenes(db);

		const found = findByMigratedFrom(db, `${GLOBAL_DEFAULT_NOTCH_LAYOUT_ID}:scene-1`);
		expect(found).toBeTruthy();
		expect(found.label).toBe("Deep work");
	});
});
