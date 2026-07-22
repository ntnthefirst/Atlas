import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { createFindingLifecycleManager } from "./finding-lifecycle-manager.cjs";
import * as patternMinerStore from "./store.cjs";

const tmpDirs = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-finding-lifecycle-manager-test-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function createTestManager(overrides = {}) {
	const dir = makeTempDir();
	const prefsPath = path.join(dir, "finding-lifecycle-prefs.json");
	const manager = createFindingLifecycleManager({
		getPrefsPath: () => prefsPath,
		getDb: overrides.getDb ?? (() => null),
		now: overrides.now,
	});
	return { manager, prefsPath, dir };
}

describe("createFindingLifecycleManager -- preferences", () => {
	it("loadPreferences() falls back to defaults when nothing is persisted yet", () => {
		const { manager } = createTestManager();
		const prefs = manager.loadPreferences();
		expect(prefs.baseBackoffHours).toBeGreaterThan(0);
		expect(prefs.expiryDays).toBeGreaterThan(0);
	});

	it("setPreferences() persists to disk and round-trips through loadPreferences()", () => {
		const { manager, prefsPath } = createTestManager();
		manager.setPreferences({ expiryDays: 5 });
		expect(fs.existsSync(prefsPath)).toBe(true);

		const reloaded = manager.loadPreferences();
		expect(reloaded.expiryDays).toBe(5);
	});

	it("clamps a nonsensical patch rather than persisting it verbatim", () => {
		const { manager } = createTestManager();
		const prefs = manager.setPreferences({ backoffMultiplier: 1, maxBackoffDays: -5 });
		expect(prefs.backoffMultiplier).toBeGreaterThan(1);
		expect(prefs.maxBackoffDays).toBeGreaterThan(0);
	});
});

describe("createFindingLifecycleManager -- delegation, and never running without a db", () => {
	it("every operation returns a graceful failure when the database isn't ready yet, rather than throwing", () => {
		const { manager } = createTestManager({ getDb: () => null });
		expect(manager.markSuggested("f1")).toEqual({ ok: false, error: expect.any(String) });
		expect(manager.acceptFinding("f1")).toEqual({ ok: false, error: expect.any(String) });
		expect(manager.ignoreFinding("f1")).toEqual({ ok: false, error: expect.any(String) });
		expect(manager.resurfaceDueFindings()).toEqual({ resurfacedCount: 0, findingIds: [] });
		expect(manager.sweepExpiredFindings()).toEqual({ expiredCount: 0, findingIds: [] });
	});

	it("acceptFinding/ignoreFinding operate against a real db once one is available", async () => {
		const dbPath = path.join(makeTempDir(), "atlas.db");
		const db = await AtlasDatabase.create(dbPath);
		const { manager } = createTestManager({ getDb: () => db, now: () => Date.parse("2026-01-01T00:00:00Z") });

		patternMinerStore.upsertFindings(db, [
			{
				environmentId: "env-a",
				patternType: "sequential_co_occurrence",
				trigger: { type: "app.focus", subject: "Editor" },
				follow: { type: "app.focus", subject: "Server" },
				windowMinutes: 30,
				occurrences: 12,
				trials: 15,
				confidence: 0.8,
				baselineProbability: 0.1,
				lift: 8,
				pValue: 0.0001,
				evidence: [{ triggerEventId: 1, followEventId: 2 }],
			},
		]);
		const finding = patternMinerStore.listFindingsForEnvironment(db, "env-a")[0];

		const result = manager.acceptFinding(finding.id);
		expect(result.ok).toBe(true);
		expect(result.rule.environmentId).toBe("env-a");
	});

	it("ignoreFinding uses the manager's OWN persisted preferences for the back-off window", async () => {
		const dbPath = path.join(makeTempDir(), "atlas.db");
		const db = await AtlasDatabase.create(dbPath);
		const now = Date.parse("2026-01-01T00:00:00Z");
		const { manager } = createTestManager({ getDb: () => db, now: () => now });
		manager.setPreferences({ baseBackoffHours: 1 }); // much shorter than the 24h default

		patternMinerStore.upsertFindings(db, [
			{
				environmentId: "env-a",
				patternType: "sequential_co_occurrence",
				trigger: { type: "app.focus", subject: "Editor" },
				follow: { type: "app.focus", subject: "Server" },
				windowMinutes: 30,
				occurrences: 12,
				trials: 15,
				confidence: 0.8,
				baselineProbability: 0.1,
				lift: 8,
				pValue: 0.0001,
				evidence: [{ triggerEventId: 1, followEventId: 2 }],
			},
		]);
		const finding = patternMinerStore.listFindingsForEnvironment(db, "env-a")[0];

		const result = manager.ignoreFinding(finding.id);
		expect(result.ok).toBe(true);
		const windowMs = Date.parse(result.suppressedUntil) - now;
		expect(windowMs).toBe(60 * 60 * 1000); // exactly 1 hour, the configured value
	});
});
