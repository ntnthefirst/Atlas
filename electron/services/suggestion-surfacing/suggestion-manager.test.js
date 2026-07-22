import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { createSuggestionManager } from "./suggestion-manager.cjs";
import { createFindingLifecycleManager } from "../pattern-miner/finding-lifecycle-manager.cjs";
import * as patternMinerStore from "../pattern-miner/store.cjs";
import { buildFindingRuleLabel } from "../pattern-miner/finding-translator.cjs";

// Calendar-day rate limiting (rate-limit.cjs's own isSameCalendarDay) compares
// LOCAL days, so every fixture timestamp below is built from local date/time
// components rather than parsed from a UTC "Z" ISO string -- see rate-
// limit.test.js's own `localTime` for why parsing a fixed UTC instant would
// be timezone-dependent flakiness here.
function localTime(year, month, day, hour = 0, minute = 0) {
	return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const tmpDirs = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-suggestion-manager-test-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// A translatable trigger/follow pair (see selection.test.js's own base
// fixture for why session.start/session.stop needs no `subject` to satisfy
// finding-translator.cjs's builders).
function seedFinding(db, overrides = {}) {
	patternMinerStore.upsertFindings(db, [
		{
			environmentId: "env-a",
			patternType: "sequential_co_occurrence",
			trigger: { type: "session.start", subject: null },
			follow: { type: "session.stop", subject: null },
			windowMinutes: 30,
			occurrences: 12,
			trials: 15,
			confidence: 0.8,
			baselineProbability: 0.1,
			lift: 8,
			pValue: 0.0001,
			evidence: [{ triggerEventId: 1, followEventId: 2 }],
			...overrides,
		},
	]);
	const list = patternMinerStore.listFindingsForEnvironment(db, overrides.environmentId ?? "env-a");
	return list[list.length - 1];
}

async function createTestDb() {
	const dbPath = path.join(makeTempDir(), "atlas.db");
	return AtlasDatabase.create(dbPath);
}

function createTestLifecycleManager(db, nowFn) {
	const dir = makeTempDir();
	return createFindingLifecycleManager({
		getPrefsPath: () => path.join(dir, "finding-lifecycle-prefs.json"),
		getDb: () => db,
		now: nowFn,
	});
}

function createTestSuggestionManager(overrides = {}) {
	const dir = makeTempDir();
	const prefsPath = overrides.prefsPath ?? path.join(dir, "suggestion-prefs.json");
	const manager = createSuggestionManager({
		getPrefsPath: () => prefsPath,
		getDb: overrides.getDb ?? (() => null),
		now: overrides.now,
		sessionStartMs: overrides.sessionStartMs,
		lifecycleManager: overrides.lifecycleManager,
		getEventLog: overrides.getEventLog,
	});
	return { manager, prefsPath, dir };
}

describe("createSuggestionManager -- preferences", () => {
	it("loadPreferences() falls back to defaults when nothing is persisted yet", () => {
		const { manager } = createTestSuggestionManager();
		const prefs = manager.loadPreferences();
		expect(prefs.enabled).toBe(true);
		expect(prefs.maxPerSession).toBe(1);
	});

	it("setPreferences() persists to disk and round-trips through loadPreferences()", () => {
		const { manager, prefsPath } = createTestSuggestionManager();
		manager.setPreferences({ maxPerDay: 5 });
		expect(fs.existsSync(prefsPath)).toBe(true);
		expect(manager.loadPreferences().maxPerDay).toBe(5);
	});

	it("clamps a nonsensical patch rather than persisting it verbatim", () => {
		const { manager } = createTestSuggestionManager();
		const prefs = manager.setPreferences({ maxPerSession: 999, maxPerDay: -5 });
		expect(prefs.maxPerSession).toBeLessThanOrEqual(10);
		expect(prefs.maxPerDay).toBeGreaterThanOrEqual(1);
	});
});

describe("createSuggestionManager -- never runs without a db", () => {
	it("returns null gracefully when the database isn't ready yet, rather than throwing", () => {
		const { manager } = createTestSuggestionManager({ getDb: () => null });
		expect(manager.getSuggestionToSurface("env-a")).toBeNull();
	});

	it("returns null with no active environment, without ever touching the db", () => {
		const getDb = vi.fn(() => null);
		const { manager } = createTestSuggestionManager({ getDb });
		expect(manager.getSuggestionToSurface(null)).toBeNull();
		expect(getDb).not.toHaveBeenCalled();
	});
});

describe("createSuggestionManager -- the global 'stop suggesting things' switch", () => {
	it("when off: no suggestion surfaces, markSuggested is never called, getDb is never even called -- proven with a fixture that would otherwise definitely produce one", async () => {
		const db = await createTestDb();
		const finding = seedFinding(db);
		expect(finding.status).toBe("new"); // sanity: this WOULD be surfaceable if enabled

		const getDb = vi.fn(() => db);
		const markSuggested = vi.fn(() => ({ ok: true, finding }));
		const getPreferences = vi.fn(() => ({ expiryDays: 14 }));
		const lifecycleManager = { markSuggested, getPreferences };
		const eventLog = { record: vi.fn() };

		const { manager } = createTestSuggestionManager({
			getDb,
			lifecycleManager,
			getEventLog: () => eventLog,
		});
		manager.setPreferences({ enabled: false });

		const result = manager.getSuggestionToSurface("env-a");

		expect(result).toBeNull();
		expect(getDb).not.toHaveBeenCalled();
		expect(markSuggested).not.toHaveBeenCalled();
		expect(eventLog.record).not.toHaveBeenCalled();
	});

	it("re-enabling it makes the SAME still-eligible finding surface again", async () => {
		const db = await createTestDb();
		const finding = seedFinding(db);
		const lifecycleManager = createTestLifecycleManager(db, () => localTime(2026, 1, 10, 12, 0));

		const { manager } = createTestSuggestionManager({
			getDb: () => db,
			lifecycleManager,
			now: () => localTime(2026, 1, 10, 12, 0),
		});
		manager.setPreferences({ enabled: false });
		expect(manager.getSuggestionToSurface("env-a")).toBeNull();

		manager.setPreferences({ enabled: true });
		const result = manager.getSuggestionToSurface("env-a");
		expect(result?.id).toBe(finding.id);
	});
});

describe("createSuggestionManager -- surfacing an eligible finding", () => {
	it("returns a sanitized suggestion and marks the finding 'suggested' through the real lifecycle manager", async () => {
		const db = await createTestDb();
		const finding = seedFinding(db);
		const lifecycleManager = createTestLifecycleManager(db, () => localTime(2026, 1, 10, 12, 0));
		const eventLog = { record: vi.fn() };

		const { manager } = createTestSuggestionManager({
			getDb: () => db,
			lifecycleManager,
			now: () => localTime(2026, 1, 10, 12, 0),
			getEventLog: () => eventLog,
		});

		const result = manager.getSuggestionToSurface("env-a");

		expect(result).toEqual({
			id: finding.id,
			environmentId: "env-a",
			patternType: "sequential_co_occurrence",
			description: buildFindingRuleLabel({ ...finding, status: "suggested" }),
			confidence: 0.8,
			occurrences: 12,
			suggestedAt: expect.any(String),
		});

		const persisted = patternMinerStore.getFinding(db, finding.id);
		expect(persisted.status).toBe("suggested");

		expect(eventLog.record).toHaveBeenCalledWith(
			"suggestion.shown",
			expect.objectContaining({ environmentId: "env-a", subject: finding.id }),
		);
	});

	it("never surfaces a finding from a different environment than requested", async () => {
		const db = await createTestDb();
		seedFinding(db, { environmentId: "env-b" });
		const lifecycleManager = createTestLifecycleManager(db, () => localTime(2026, 1, 10, 12, 0));
		const { manager } = createTestSuggestionManager({
			getDb: () => db,
			lifecycleManager,
			now: () => localTime(2026, 1, 10, 12, 0),
		});

		expect(manager.getSuggestionToSurface("env-a")).toBeNull();
	});
});

describe("createSuggestionManager -- rate limits", () => {
	it("enforces the default one-per-session cap: a second eligible finding in the SAME session is not surfaced", async () => {
		const db = await createTestDb();
		const first = seedFinding(db);
		patternMinerStore.upsertFindings(db, [
			{
				environmentId: "env-a",
				patternType: "sequential_co_occurrence",
				trigger: { type: "session.start", subject: "second" },
				follow: { type: "session.stop", subject: null },
				windowMinutes: 30,
				occurrences: 20,
				trials: 25,
				confidence: 0.9,
				baselineProbability: 0.1,
				lift: 9,
				pValue: 0.0001,
				evidence: [],
			},
		]);

		const now = localTime(2026, 1, 10, 12, 0);
		const lifecycleManager = createTestLifecycleManager(db, () => now);
		const { manager } = createTestSuggestionManager({ getDb: () => db, lifecycleManager, now: () => now });

		const shown = manager.getSuggestionToSurface("env-a");
		expect(shown?.id).toBe(first.id);

		// A second, still-genuinely-eligible finding exists (different trigger
		// subject, still "new") -- denied purely by the session cap, not because
		// nothing else qualified.
		const secondAttempt = manager.getSuggestionToSurface("env-a");
		expect(secondAttempt).toBeNull();
	});

	it("a fresh manager instance (new session, same day) may surface again even though the daily count already reflects a prior session's suggestion", async () => {
		const db = await createTestDb();
		const first = seedFinding(db);
		patternMinerStore.upsertFindings(db, [
			{
				environmentId: "env-a",
				patternType: "sequential_co_occurrence",
				trigger: { type: "session.start", subject: "second" },
				follow: { type: "session.stop", subject: null },
				windowMinutes: 30,
				occurrences: 20,
				trials: 25,
				confidence: 0.9,
				baselineProbability: 0.1,
				lift: 9,
				pValue: 0.0001,
				evidence: [],
			},
		]);

		const morning = localTime(2026, 1, 10, 8, 0);
		const afternoon = localTime(2026, 1, 10, 15, 0); // same calendar day, later

		// "Session" 1: shows the first finding, then starts a new manager to
		// simulate a restart.
		const lifecycleManager1 = createTestLifecycleManager(db, () => morning);
		const { manager: manager1 } = createTestSuggestionManager({
			getDb: () => db,
			lifecycleManager: lifecycleManager1,
			now: () => morning,
			sessionStartMs: morning,
		});
		manager1.setPreferences({ maxPerDay: 3 }); // wide enough that the daily cap alone won't block session 2
		expect(manager1.getSuggestionToSurface("env-a")?.id).toBe(first.id);

		// "Session" 2: a brand new manager instance, later the same day --
		// its own per-session count is zero, so the SECOND finding may surface.
		const lifecycleManager2 = createTestLifecycleManager(db, () => afternoon);
		const { manager: manager2 } = createTestSuggestionManager({
			getDb: () => db,
			lifecycleManager: lifecycleManager2,
			now: () => afternoon,
			sessionStartMs: afternoon,
		});
		manager2.setPreferences({ maxPerDay: 3 });

		const secondShown = manager2.getSuggestionToSurface("env-a");
		expect(secondShown).not.toBeNull();
		expect(secondShown?.id).not.toBe(first.id);
	});

	it("the global per-day cap still denies a fresh session once today's total is reached, independent of the session cap", async () => {
		const db = await createTestDb();
		const first = seedFinding(db);
		patternMinerStore.upsertFindings(db, [
			{
				environmentId: "env-a",
				patternType: "sequential_co_occurrence",
				trigger: { type: "session.start", subject: "second" },
				follow: { type: "session.stop", subject: null },
				windowMinutes: 30,
				occurrences: 20,
				trials: 25,
				confidence: 0.9,
				baselineProbability: 0.1,
				lift: 9,
				pValue: 0.0001,
				evidence: [],
			},
		]);

		const morning = localTime(2026, 1, 10, 8, 0);
		const afternoon = localTime(2026, 1, 10, 15, 0);

		const lifecycleManager1 = createTestLifecycleManager(db, () => morning);
		const { manager: manager1, prefsPath } = createTestSuggestionManager({
			getDb: () => db,
			lifecycleManager: lifecycleManager1,
			now: () => morning,
			sessionStartMs: morning,
		});
		manager1.setPreferences({ maxPerDay: 1 }); // the whole day's budget is ONE suggestion, persisted to prefsPath
		expect(manager1.getSuggestionToSurface("env-a")?.id).toBe(first.id);

		// New "session", same day -- a brand new manager instance pointed at the
		// SAME prefs file (exactly what a real restart reloads), so its
		// maxPerDay: 1 comes from disk, not from re-calling setPreferences. Its
		// own session cap is fresh (0 this session) but the GLOBAL daily cap is
		// already spent, and must deny regardless.
		const lifecycleManager2 = createTestLifecycleManager(db, () => afternoon);
		const { manager: manager2 } = createTestSuggestionManager({
			getDb: () => db,
			lifecycleManager: lifecycleManager2,
			now: () => afternoon,
			sessionStartMs: afternoon,
			prefsPath,
		});
		manager2.loadPreferences();

		expect(manager2.getSuggestionToSurface("env-a")).toBeNull();
	});
});
