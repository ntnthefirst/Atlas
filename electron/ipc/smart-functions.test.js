import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasDatabase } from "../db.cjs";
import { register } from "./smart-functions.cjs";
import * as store from "../services/smart-functions/store.cjs";

// ---------------------------------------------------------------------------
// The smartFunctions:* channels (WP-3.1, completed by WP-3.2). Driven against
// a REAL temp-file database rather than a mocked store, because the two things
// worth proving here -- that every read carries a description built from real
// environment names, and that a duplicate is a genuinely independent row --
// are both about what actually lands in the table.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sf-ipc-test-"));
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

function createFakeIpcMain() {
	const handlers = new Map();
	return {
		handle(channel, fn) {
			handlers.set(channel, fn);
		},
		invoke(channel, ...args) {
			const fn = handlers.get(channel);
			if (!fn) {
				throw new Error(`no handler registered for ${channel}`);
			}
			return fn({}, ...args);
		},
	};
}

async function setup() {
	const db = await createDb();
	const environment = db.createEnvironment("Design");
	const engine = { refreshRules: vi.fn(), runManually: vi.fn(), dryRun: vi.fn(() => ({ ok: true })) };
	const ipcMain = createFakeIpcMain();
	register(ipcMain, { getDb: () => db, engine });
	return { db, environment, engine, ipcMain };
}

describe("descriptions on every read", () => {
	it("attaches a plain-language description that names the environment, not its id", async () => {
		const { db, environment, ipcMain } = await setup();
		store.createRule(db, {
			label: "Timer on switch",
			environmentId: null,
			trigger: { type: "environment.switched", environmentId: environment.id },
			actions: [{ type: "timer", mode: "start" }],
		});

		const rules = ipcMain.invoke("smartFunctions:listAll");

		expect(rules[0].description).toBe('When I switch into "Design", start the timer.');
		expect(rules[0].description).not.toContain(environment.id);
	});

	it("carries the description on get, create, update and setEnabled too", async () => {
		const { ipcMain } = await setup();

		const created = ipcMain.invoke("smartFunctions:create", {
			label: "A rule",
			trigger: { type: "session.started" },
			actions: [{ type: "timer", mode: "start" }],
		});
		expect(created.description).toBe("When a session starts, start the timer.");

		expect(ipcMain.invoke("smartFunctions:get", created.id).description).toBe(created.description);
		expect(ipcMain.invoke("smartFunctions:setEnabled", created.id, false).description).toBe(created.description);

		const updated = ipcMain.invoke("smartFunctions:update", created.id, {
			actions: [{ type: "timer", mode: "stop" }],
		});
		expect(updated.description).toBe("When a session starts, stop the timer.");
	});

	// The description is rebuilt on every read rather than stored, so a rename
	// can't leave a stale name in the one place accuracy is the whole point.
	it("reflects an environment rename immediately", async () => {
		const { db, environment, ipcMain } = await setup();
		store.createRule(db, {
			label: "Timer on switch",
			trigger: { type: "environment.switched", environmentId: environment.id },
			actions: [{ type: "timer", mode: "start" }],
		});
		expect(ipcMain.invoke("smartFunctions:listAll")[0].description).toContain("Design");

		db.renameEnvironment(environment.id, "Studio");

		expect(ipcMain.invoke("smartFunctions:listAll")[0].description).toContain("Studio");
	});
});

describe("smartFunctions:duplicate (WP-3.2)", () => {
	it("copies the whole rule under a new id, with a distinguishable name", async () => {
		const { ipcMain } = await setup();
		const original = ipcMain.invoke("smartFunctions:create", {
			label: "Focus setup",
			trigger: { type: "app.launched", processName: "Figma" },
			conditions: [{ type: "app_running", processName: "Figma" }],
			actions: [{ type: "timer", mode: "start" }],
		});

		const copy = ipcMain.invoke("smartFunctions:duplicate", original.id);

		expect(copy.id).not.toBe(original.id);
		expect(copy.label).toBe("Focus setup (copy)");
		expect(copy.trigger).toEqual(original.trigger);
		expect(copy.conditions).toEqual(original.conditions);
		expect(copy.actions).toEqual(original.actions);
	});

	// The copy exists to be changed. A live twin firing the same actions in the
	// meantime is the one thing nobody duplicating a rule wants.
	it("starts the copy turned OFF, whatever the original was", async () => {
		const { ipcMain } = await setup();
		const original = ipcMain.invoke("smartFunctions:create", {
			label: "Focus setup",
			enabled: true,
			trigger: { type: "session.started" },
			actions: [{ type: "timer", mode: "start" }],
		});
		expect(original.enabled).toBe(true);

		expect(ipcMain.invoke("smartFunctions:duplicate", original.id).enabled).toBe(false);
	});

	it("leaves the original completely untouched", async () => {
		const { db, ipcMain } = await setup();
		const original = ipcMain.invoke("smartFunctions:create", {
			label: "Focus setup",
			trigger: { type: "session.started" },
			actions: [{ type: "timer", mode: "start" }],
		});

		ipcMain.invoke("smartFunctions:duplicate", original.id);

		expect(store.getRule(db, original.id)).toMatchObject({ label: "Focus setup", enabled: true });
		expect(store.listAllRules(db)).toHaveLength(2);
	});

	// A migrated scene's `migrated_from` is UNIQUE (migration 011) and is the
	// idempotency key migrate-scenes.cjs relies on -- inheriting it would both
	// collide and make the copy look like the scene it isn't.
	it("does not inherit a migrated scene's identity", async () => {
		const { db, ipcMain } = await setup();
		const migrated = store.createRule(db, {
			label: "From a scene",
			trigger: { type: "manual" },
			actions: [{ type: "timer", mode: "start" }],
			source: "migrated-scene",
			migratedFrom: "layout-1:placement-1",
		});

		const copy = ipcMain.invoke("smartFunctions:duplicate", migrated.id);

		expect(copy.source).toBe("user");
		expect(copy.migratedFrom).toBeNull();
	});

	it("refreshes the engine's rule cache", async () => {
		const { ipcMain, engine } = await setup();
		const original = ipcMain.invoke("smartFunctions:create", {
			label: "A rule",
			trigger: { type: "session.started" },
			actions: [{ type: "timer", mode: "start" }],
		});
		engine.refreshRules.mockClear();

		ipcMain.invoke("smartFunctions:duplicate", original.id);

		expect(engine.refreshRules).toHaveBeenCalledOnce();
	});

	it("refuses an unknown id rather than creating an empty rule", async () => {
		const { db, ipcMain } = await setup();

		expect(() => ipcMain.invoke("smartFunctions:duplicate", "nope")).toThrow(/not found/i);
		expect(store.listAllRules(db)).toHaveLength(0);
	});
});

describe("smartFunctions:dryRun (WP-3.2)", () => {
	it("delegates to the engine, which is the only thing that knows the live context", async () => {
		const { ipcMain, engine } = await setup();

		ipcMain.invoke("smartFunctions:dryRun", "rule-1");

		expect(engine.dryRun).toHaveBeenCalledWith("rule-1");
	});

	it("degrades cleanly when there is no engine at all", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => null, engine: null });

		expect(ipcMain.invoke("smartFunctions:dryRun", "rule-1")).toMatchObject({ ok: false });
	});
});
