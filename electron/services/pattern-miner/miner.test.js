import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { createPatternMiner } from "./miner.cjs";
import { mineSequentialPatterns } from "./algorithm.cjs";
import { listFindingsForEnvironment, getFindingEvidence } from "./store.cjs";

// ---------------------------------------------------------------------------
// The main-thread mining orchestrator (WP-3.3) -- driven entirely through an
// INJECTED fake worker (a plain EventEmitter, exactly like crawler.test.js's
// own FakeWorker for the file-index crawler) so these tests are fast/
// deterministic and never spin a real OS thread. mine-worker.test.js is what
// proves the real worker-thread wiring itself works end-to-end.
//
// The fake worker below calls the REAL `mineSequentialPatterns` per
// completed bucket (asynchronously, via queueMicrotask, to mirror a real
// postMessage's async delivery) -- so these tests exercise miner.cjs's own
// paging/sequencing/write logic against genuine mining output, not a stub
// that just echoes back canned findings.
//
// Every scratch path here is a temp file, never %APPDATA%/Atlas or Atlas-Dev.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pattern-miner-test-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

class FakeWorker extends EventEmitter {
	constructor() {
		super();
		this.posted = [];
		this.terminated = false;
		this.pending = new Map();
		this.thresholds = {};
	}
	postMessage(message) {
		this.posted.push(message);
		if (message.type === "config") {
			this.thresholds = message.thresholds || {};
			return;
		}
		if (message.type === "events") {
			const key = message.environmentId ?? null;
			const existing = this.pending.get(key) ?? [];
			existing.push(...message.events);
			this.pending.set(key, existing);
			if (message.isLast) {
				const events = this.pending.get(key) ?? [];
				this.pending.delete(key);
				const findings = mineSequentialPatterns(events, this.thresholds);
				queueMicrotask(() => this.emit("message", { type: "bucket-done", environmentId: key, findings }));
			}
			return;
		}
		if (message.type === "run-complete") {
			queueMicrotask(() => this.emit("message", { type: "done" }));
		}
	}
	terminate() {
		this.terminated = true;
	}
}

async function createDb() {
	const dir = makeTempDir();
	return AtlasDatabase.create(path.join(dir, "atlas.db"));
}

function insertEvent(db, { ts, environmentId = null, type, subject = null }) {
	db.run("INSERT INTO events (ts, environment_id, type, subject, payload, session_id) VALUES (?, ?, ?, ?, NULL, NULL)", [
		ts,
		environmentId,
		type,
		subject,
	]);
}

function isoAt(baseMs, offsetMs) {
	return new Date(baseMs + offsetMs).toISOString();
}

// Seeds a genuine, detectable pattern (A=app.focus/Editor, B=app.focus/Server)
// repeated across `days` days, plus enough unrelated noise events that
// `minBucketEvents` is comfortably satisfied. Wrapped in ONE transaction --
// node-sqlite3-wasm is dramatically slower per unbatched write (see event-
// log.cjs's own header), and this project's own discipline is "all bulk
// writes inside db.transaction()", including in tests.
function seedDetectablePattern(db, { environmentId = null, days = 40, dayStartMs } = {}) {
	db.transaction(() => {
		seedDetectablePatternUnbatched(db, { environmentId, days, dayStartMs });
	});
}

function seedDetectablePatternUnbatched(db, { environmentId = null, days = 40, dayStartMs } = {}) {
	const base = dayStartMs ?? Date.parse("2026-01-01T00:00:00.000Z");
	for (let day = 0; day < days; day += 1) {
		const dayBase = base + day * 24 * 60 * 60 * 1000;
		insertEvent(db, { ts: isoAt(dayBase, 0), environmentId, type: "app.focus", subject: "Editor" });
		insertEvent(db, { ts: isoAt(dayBase, 5 * 60 * 1000), environmentId, type: "app.focus", subject: "Server" });
		for (let n = 0; n < 4; n += 1) {
			insertEvent(db, {
				ts: isoAt(dayBase, (n + 1) * 60 * 60 * 1000),
				environmentId,
				type: "noise",
				subject: `n${n}`,
			});
		}
	}
}

function createTestMiner(overrides = {}) {
	const dir = makeTempDir();
	const prefsPath = path.join(dir, "pattern-miner-prefs.json");
	let lastWorker = null;
	const createWorker = overrides.createWorker ?? (() => (lastWorker = new FakeWorker()));

	const miner = createPatternMiner({
		getPrefsPath: () => prefsPath,
		createWorker,
		getDb: overrides.getDb ?? (() => null),
		getEventLog: overrides.getEventLog ?? (() => null),
		eventsPageSize: overrides.eventsPageSize,
		runTimeoutMs: overrides.runTimeoutMs,
	});

	return { miner, getWorker: () => lastWorker, prefsPath };
}

describe("createPatternMiner -- preferences", () => {
	it("loadPreferences() falls back to defaults when nothing is persisted yet", () => {
		const { miner } = createTestMiner();
		const prefs = miner.loadPreferences();
		expect(prefs.windowMinutes).toBeGreaterThan(0);
		expect(prefs.minOccurrences).toBeGreaterThanOrEqual(2);
	});

	it("setPreferences() persists to disk and round-trips through loadPreferences()", () => {
		const { miner, prefsPath } = createTestMiner();
		miner.setPreferences({ minOccurrences: 9 });
		expect(fs.existsSync(prefsPath)).toBe(true);

		const reloaded = miner.loadPreferences();
		expect(reloaded.minOccurrences).toBe(9);
	});

	it("clamps a nonsensical patch rather than persisting it verbatim", () => {
		const { miner } = createTestMiner();
		const prefs = miner.setPreferences({ minConfidence: 50, windowMinutes: -5 });
		expect(prefs.minConfidence).toBeLessThanOrEqual(1);
		expect(prefs.windowMinutes).toBeGreaterThan(0);
	});
});

describe("createPatternMiner -- runNow() never starts on its own", () => {
	it("does nothing at construction time -- no worker until runNow() is called", () => {
		const { getWorker } = createTestMiner();
		expect(getWorker()).toBeNull();
	});
});

describe("createPatternMiner -- mining lifecycle", () => {
	it("completes with an idle-ish result when there are no events at all", async () => {
		const db = await createDb();
		const { miner, getWorker } = createTestMiner({ getDb: () => db });

		const result = await miner.runNow();
		expect(result.ok).toBe(true);
		expect(getWorker()).toBeNull(); // never even spawned -- nothing to mine
		expect(miner.getStatus().state).toBe("completed");
	});

	it("returns an error result (not a throw) when the database isn't ready", async () => {
		const { miner } = createTestMiner({ getDb: () => null });
		const result = await miner.runNow();
		expect(result.ok).toBe(false);
		expect(miner.getStatus().state).toBe("idle");
	});

	it("mines a seeded pattern end-to-end and persists it via the real store", async () => {
		const db = await createDb();
		seedDetectablePattern(db, { environmentId: "env-a", days: 40 });
		const { miner, getWorker } = createTestMiner({ getDb: () => db });

		const result = await miner.runNow();

		expect(result.ok).toBe(true);
		expect(result.environmentsMined).toBe(1);
		expect(result.findingsCreated).toBe(1);
		expect(getWorker()).not.toBeNull();
		expect(getWorker().terminated).toBe(true); // cleaned up after the run

		const findings = listFindingsForEnvironment(db, "env-a");
		expect(findings.length).toBe(1);
		expect(findings[0].trigger).toEqual({ type: "app.focus", subject: "Editor" });
		expect(findings[0].follow).toEqual({ type: "app.focus", subject: "Server" });
		expect(findings[0].occurrences).toBeGreaterThanOrEqual(9); // real, non-vacuous count

		const evidence = getFindingEvidence(db, findings[0].id);
		expect(evidence.length).toBe(findings[0].occurrences);
	});

	it("re-running mining on the same data UPDATES the existing finding rather than duplicating it", async () => {
		const db = await createDb();
		seedDetectablePattern(db, { environmentId: "env-a", days: 40 });
		const { miner } = createTestMiner({ getDb: () => db });

		await miner.runNow();
		const firstPass = listFindingsForEnvironment(db, "env-a");
		expect(firstPass.length).toBe(1);

		await miner.runNow();
		const secondPass = listFindingsForEnvironment(db, "env-a");
		expect(secondPass.length).toBe(1); // still exactly one row, not two
		expect(secondPass[0].id).toBe(firstPass[0].id);
	});

	it("pages a bucket across MULTIPLE worker messages when it exceeds the page size", async () => {
		const db = await createDb();
		seedDetectablePattern(db, { environmentId: "env-a", days: 40 }); // 6 events/day * 40 = 240 events
		const { miner, getWorker } = createTestMiner({ getDb: () => db, eventsPageSize: 25 });

		await miner.runNow();

		const worker = getWorker();
		const eventMessages = worker.posted.filter((m) => m.type === "events");
		expect(eventMessages.length).toBeGreaterThan(1); // proves genuine chunking happened
		expect(eventMessages[eventMessages.length - 1].isLast).toBe(true);
		expect(eventMessages.slice(0, -1).every((m) => m.isLast === false)).toBe(true);

		const totalEventsSent = eventMessages.reduce((sum, m) => sum + m.events.length, 0);
		expect(totalEventsSent).toBe(240);
	});

	it("mines every environment bucket in its own turn and tags findings correctly", async () => {
		const db = await createDb();
		seedDetectablePattern(db, { environmentId: "env-a", days: 40 });
		seedDetectablePattern(db, { environmentId: "env-b", days: 40 });
		const { miner } = createTestMiner({ getDb: () => db });

		const result = await miner.runNow();
		expect(result.environmentsMined).toBe(2);
		expect(result.findingsCreated).toBe(2);

		expect(listFindingsForEnvironment(db, "env-a").length).toBe(1);
		expect(listFindingsForEnvironment(db, "env-b").length).toBe(1);
	});

	it("collapses concurrent runNow() calls into a single in-flight run", async () => {
		const db = await createDb();
		seedDetectablePattern(db, { environmentId: "env-a", days: 40 });
		const { miner } = createTestMiner({ getDb: () => db });

		const [a, b] = await Promise.all([miner.runNow(), miner.runNow()]);
		expect(a).toBe(b); // same settled result object -- one real run, not two
		expect(listFindingsForEnvironment(db, "env-a").length).toBe(1);
	});

	it("shutdown() terminates an in-flight worker", async () => {
		const db = await createDb();
		seedDetectablePattern(db, { environmentId: "env-a", days: 40 });
		const { miner, getWorker } = createTestMiner({ getDb: () => db });

		const runPromise = miner.runNow();
		// Give the run a moment to spawn its worker, then shut it down mid-flight.
		await new Promise((resolve) => setImmediate(resolve));
		miner.shutdown();
		expect(getWorker()?.terminated).toBe(true);

		await runPromise.catch(() => {}); // the in-flight run may reject/short-circuit -- that's fine, this test only cares that shutdown() actually terminated the worker
	});
});
