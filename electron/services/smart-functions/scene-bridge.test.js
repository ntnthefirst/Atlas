import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import * as store from "./store.cjs";
import { migrateScenes } from "./migrate-scenes.cjs";
import { findScenePlacement, resolveSceneRule, sceneKeyFor } from "./scene-bridge.cjs";

// ---------------------------------------------------------------------------
// The single execution path for a Notch scene button. Before this module, the
// renderer ran scenes itself and the migrated `smart_functions` rows were
// dormant copies that nothing invoked -- so the assertions that matter here
// are the ones about the two staying in step: a scene edited after migration
// must run its NEW actions, and pressing a button must never produce a second
// rule for the same scene.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-scene-bridge-test-"));
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

const GLOBAL_LAYOUT_ID = "default";

function sceneConfig(overrides = {}) {
	return JSON.stringify({
		label: "Work setup",
		icon: "RocketLaunchIcon",
		apps: ["figma.exe"],
		urls: [],
		timer: "start",
		environmentId: "",
		tasks: [],
		...overrides,
	});
}

// Writes a layout containing one scene placement, straight into the same
// `notch_layouts` row the app resolves from.
function seedSceneLayout(db, { placementId = "scene-1", config = sceneConfig() } = {}) {
	const existing = db.getEffectiveNotchPreferences(null).preferences;
	db.setNotchLayout(GLOBAL_LAYOUT_ID, {
		...existing,
		tabs: [
			{
				id: "tab-1",
				label: "Scenes",
				icon: "RocketLaunchIcon",
				gridCols: 5,
				gridRows: 1,
				placements: [{ id: placementId, widget: "scene", x: 0, y: 0, w: 2, h: 1, config }],
			},
		],
	});
}

describe("sceneKeyFor", () => {
	it("spells the same key migrate-scenes.cjs writes", () => {
		expect(sceneKeyFor("default", "scene-1")).toBe("default:scene-1");
	});
});

describe("findScenePlacement", () => {
	const preferences = {
		tabs: [
			{ placements: [{ id: "a", widget: "timerDisplay" }] },
			{ placements: [{ id: "b", widget: "scene", config: "{}" }] },
		],
	};

	it("finds a scene placement by id", () => {
		expect(findScenePlacement(preferences, "b")?.id).toBe("b");
	});

	it("ignores a placement of the same id that is not a scene", () => {
		expect(findScenePlacement(preferences, "a")).toBeNull();
	});

	it("never throws on a malformed layout", () => {
		expect(findScenePlacement(null, "b")).toBeNull();
		expect(findScenePlacement({}, "b")).toBeNull();
		expect(findScenePlacement({ tabs: "nope" }, "b")).toBeNull();
	});
});

describe("resolveSceneRule", () => {
	it("creates the rule for a scene the boot migration never saw", async () => {
		const db = await createDb();
		seedSceneLayout(db);

		const result = resolveSceneRule(db, { placementId: "scene-1", environmentId: null });

		expect(result.ok).toBe(true);
		expect(result.created).toBe(true);
		expect(result.rule.source).toBe("migrated-scene");
		expect(result.rule.trigger).toEqual({ type: "manual" });
		expect(result.rule.actions).toEqual([
			{ type: "timer", mode: "start" },
			{ type: "launchApp", command: "figma.exe" },
		]);
	});

	it("reuses the rule the boot migration already made, rather than making a second", async () => {
		const db = await createDb();
		seedSceneLayout(db);
		migrateScenes(db);
		expect(store.listAllRules(db)).toHaveLength(1);

		const result = resolveSceneRule(db, { placementId: "scene-1", environmentId: null });

		expect(result.created).toBe(false);
		expect(store.listAllRules(db)).toHaveLength(1);
	});

	// THE divergence this module exists to close: before it, editing a scene
	// left the migrated rule frozen at whatever the boot migration copied.
	it("re-syncs the actions when the scene has been edited since migration", async () => {
		const db = await createDb();
		seedSceneLayout(db);
		migrateScenes(db);

		// The user edits the scene in the Notch editor: different app, timer off.
		seedSceneLayout(db, {
			config: sceneConfig({ label: "Renamed", apps: ["code.exe"], timer: "none" }),
		});

		const result = resolveSceneRule(db, { placementId: "scene-1", environmentId: null });

		expect(result.rule.actions).toEqual([{ type: "launchApp", command: "code.exe" }]);
		expect(result.rule.label).toBe("Renamed");
		// Still one rule -- a re-sync is an update, never a second row.
		expect(store.listAllRules(db)).toHaveLength(1);
	});

	it("keeps the rule id stable across a re-sync, so nothing referencing it breaks", async () => {
		const db = await createDb();
		seedSceneLayout(db);
		const first = resolveSceneRule(db, { placementId: "scene-1", environmentId: null }).rule;

		seedSceneLayout(db, { config: sceneConfig({ apps: ["code.exe"] }) });
		const second = resolveSceneRule(db, { placementId: "scene-1", environmentId: null }).rule;

		expect(second.id).toBe(first.id);
	});

	// `enabled` is a decision about the RULE, made in the Smart Functions
	// panel. Re-syncing must not silently reverse it.
	it("does not re-enable a rule the user turned off", async () => {
		const db = await createDb();
		seedSceneLayout(db);
		const created = resolveSceneRule(db, { placementId: "scene-1", environmentId: null }).rule;
		store.setRuleEnabled(db, created.id, false);

		seedSceneLayout(db, { config: sceneConfig({ apps: ["code.exe"] }) });
		const result = resolveSceneRule(db, { placementId: "scene-1", environmentId: null });

		expect(result.rule.enabled).toBe(false);
		// The edit still landed -- only `enabled` is preserved. (The timer
		// action comes from the fixture's own default, which this edit keeps.)
		expect(result.rule.actions).toEqual([
			{ type: "timer", mode: "start" },
			{ type: "launchApp", command: "code.exe" },
		]);
	});

	it("never writes to notch_layouts -- the scene config is left exactly as it was", async () => {
		const db = await createDb();
		seedSceneLayout(db);
		const before = db.getNotchLayoutRow(GLOBAL_LAYOUT_ID).data;

		resolveSceneRule(db, { placementId: "scene-1", environmentId: null });

		expect(db.getNotchLayoutRow(GLOBAL_LAYOUT_ID).data).toBe(before);
	});

	it("refuses a placement that is no longer on the notch", async () => {
		const db = await createDb();
		seedSceneLayout(db);

		const result = resolveSceneRule(db, { placementId: "scene-gone", environmentId: null });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("not_found");
	});

	// Same rule the migration applies: an empty scene is never stored as a rule
	// that does nothing.
	it("refuses a scene with no actions, and creates no rule for it", async () => {
		const db = await createDb();
		seedSceneLayout(db, {
			config: sceneConfig({ apps: [], urls: [], timer: "none", environmentId: "", tasks: [] }),
		});

		const result = resolveSceneRule(db, { placementId: "scene-1", environmentId: null });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("empty_scene");
		expect(store.listAllRules(db)).toHaveLength(0);
	});

	it("preserves the scene's action ORDER, which is what makes behaviour match", async () => {
		const db = await createDb();
		seedSceneLayout(db, {
			config: sceneConfig({
				environmentId: "env-a",
				timer: "start",
				tasks: [{ title: "Plan the day" }],
				apps: ["figma.exe"],
				urls: ["https://example.com"],
			}),
		});

		const result = resolveSceneRule(db, { placementId: "scene-1", environmentId: null });

		expect(result.rule.actions.map((action) => action.type)).toEqual([
			"switchEnvironment",
			"timer",
			"createTask",
			"launchApp",
			"openUrl",
		]);
	});

	it("degrades cleanly with no db and no placement id", () => {
		expect(resolveSceneRule(null, { placementId: "scene-1" }).ok).toBe(false);
		expect(resolveSceneRule({}, {}).ok).toBe(false);
	});
});
