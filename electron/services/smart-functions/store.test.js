import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import {
	listRulesForEnvironment,
	listAllRules,
	getRule,
	createRule,
	updateRule,
	setRuleEnabled,
	deleteRule,
	findByMigratedFrom,
} from "./store.cjs";

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sf-store-test-"));
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

describe("createRule / getRule", () => {
	it("round-trips a rule through the database", async () => {
		const db = await createDb();
		const created = createRule(db, {
			label: "My rule",
			environmentId: "env-a",
			trigger: { type: "session.started" },
			conditions: [{ type: "environment", environmentId: "env-a" }],
			actions: [{ type: "timer", mode: "start" }],
		});

		expect(created.id).toBeTruthy();
		expect(created.label).toBe("My rule");
		expect(created.environmentId).toBe("env-a");
		expect(created.enabled).toBe(true);
		expect(created.trigger).toEqual({ type: "session.started" });

		const fetched = getRule(db, created.id);
		expect(fetched).toEqual(created);
	});

	it("environmentId is nullable -- a global rule", async () => {
		const db = await createDb();
		const created = createRule(db, { label: "Global rule", trigger: { type: "manual" } });
		expect(created.environmentId).toBeNull();
	});

	it("getRule returns null for an unknown id", async () => {
		const db = await createDb();
		expect(getRule(db, "does-not-exist")).toBeNull();
	});
});

describe("listRulesForEnvironment", () => {
	it("returns a specific environment's own rules PLUS every global rule, never another environment's", async () => {
		const db = await createDb();
		createRule(db, { label: "Env A rule", environmentId: "env-a" });
		createRule(db, { label: "Env B rule", environmentId: "env-b" });
		const global = createRule(db, { label: "Global rule" });

		const forA = listRulesForEnvironment(db, "env-a");
		expect(forA.map((r) => r.label).sort()).toEqual(["Env A rule", "Global rule"].sort());
		expect(forA.some((r) => r.label === "Env B rule")).toBe(false);
		expect(forA.some((r) => r.id === global.id)).toBe(true);
	});

	it("with no environmentId, returns only the global rules", async () => {
		const db = await createDb();
		createRule(db, { label: "Env A rule", environmentId: "env-a" });
		createRule(db, { label: "Global rule" });

		const result = listRulesForEnvironment(db, null);
		expect(result.map((r) => r.label)).toEqual(["Global rule"]);
	});
});

describe("listAllRules", () => {
	it("returns every rule regardless of environment", async () => {
		const db = await createDb();
		createRule(db, { label: "A", environmentId: "env-a" });
		createRule(db, { label: "B", environmentId: "env-b" });
		createRule(db, { label: "C" });
		expect(listAllRules(db)).toHaveLength(3);
	});
});

describe("updateRule", () => {
	it("changes only the patched fields, preserving everything else", async () => {
		const db = await createDb();
		const created = createRule(db, {
			label: "Original",
			environmentId: "env-a",
			trigger: { type: "manual" },
			actions: [{ type: "launchApp", command: "a.exe" }],
		});

		const updated = updateRule(db, created.id, { label: "Renamed" });

		expect(updated.label).toBe("Renamed");
		expect(updated.environmentId).toBe("env-a"); // untouched
		expect(updated.actions).toEqual([{ type: "launchApp", command: "a.exe" }]); // untouched
	});

	it("returns null for an unknown id", async () => {
		const db = await createDb();
		expect(updateRule(db, "does-not-exist", { label: "x" })).toBeNull();
	});
});

describe("setRuleEnabled / deleteRule", () => {
	it("toggles enabled without touching anything else", async () => {
		const db = await createDb();
		const created = createRule(db, { label: "Toggle me" });
		expect(created.enabled).toBe(true);

		const disabled = setRuleEnabled(db, created.id, false);
		expect(disabled.enabled).toBe(false);
		expect(disabled.label).toBe("Toggle me");
	});

	it("deleteRule removes the row and reports true; false for an unknown id", async () => {
		const db = await createDb();
		const created = createRule(db, { label: "Delete me" });

		expect(deleteRule(db, created.id)).toBe(true);
		expect(getRule(db, created.id)).toBeNull();
		expect(deleteRule(db, created.id)).toBe(false); // already gone
		expect(deleteRule(db, "never-existed")).toBe(false);
	});
});

describe("findByMigratedFrom", () => {
	it("finds a rule by its migration idempotency key, or null", async () => {
		const db = await createDb();
		const created = createRule(db, { label: "From a scene", source: "migrated-scene", migratedFrom: "layout-1:placement-1" });

		expect(findByMigratedFrom(db, "layout-1:placement-1")).toEqual(created);
		expect(findByMigratedFrom(db, "layout-1:placement-2")).toBeNull();
		expect(findByMigratedFrom(db, null)).toBeNull();
	});
});
