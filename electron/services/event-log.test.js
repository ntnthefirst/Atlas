import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../db.cjs";
import {
	EventLog,
	pruneEvents,
	listEventsInRange,
	listEventsByType,
	listEventsByEnvironment,
	listEventsFollowing,
} from "./event-log.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS -- importing event-log.cjs across that boundary
// works, while the reverse does not: vitest's CJS entrypoint deliberately
// throws, so a `.cjs` test would need top-level `await import()`, which is
// not valid CommonJS and only survives because the test runner transforms it.

// Every test gets its own throwaway sqlite file under the OS temp dir, never
// anywhere near the user's real Electron userData database -- same pattern as
// db.test.js.
const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-eventlog-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const createDb = () => AtlasDatabase.create(createTempDbPath());

const countEvents = (db) => db.first("SELECT COUNT(*) AS count FROM events").count;

// Bypasses the batched writer entirely, for tests that need rows in the table
// with specific timestamps/ids rather than exercising `record()`.
function seedEvents(db, rows) {
	db.transaction(() => {
		for (const row of rows) {
			db.run(
				`INSERT INTO events (ts, environment_id, type, subject, payload, session_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
				[
					row.ts,
					row.environmentId ?? null,
					row.type ?? "app.focus",
					row.subject ?? null,
					row.payload ?? null,
					row.sessionId ?? null,
				],
			);
		}
	});
}

describe("events table (migration 003)", () => {
	it("creates the table and every documented index", async () => {
		const db = await createDb();
		expect(db.tableExists("events")).toBe(true);

		const indexNames = db
			.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
			.map((row) => row.name);

		expect(indexNames).toEqual(
			expect.arrayContaining(["idx_events_ts", "idx_events_type_ts", "idx_events_environment_ts"]),
		);
	});

	it("allows environment_id and subject to be null but requires ts and type", async () => {
		const db = await createDb();
		db.run("INSERT INTO events (ts, type) VALUES (?, ?)", [new Date().toISOString(), "app.focus"]);
		expect(countEvents(db)).toBe(1);

		expect(() => db.run("INSERT INTO events (environment_id, type) VALUES (?, ?)", ["env-1", "app.focus"])).toThrow();
		expect(() => db.run("INSERT INTO events (ts) VALUES (?)", [new Date().toISOString()])).toThrow();
	});
});

describe("EventLog.record()", () => {
	it("buffers in memory and does not write to disk until flushed", async () => {
		const db = await createDb();
		const log = new EventLog(db);

		log.record("app.focus", { subject: "chrome" });

		expect(log.pendingCount()).toBe(1);
		expect(countEvents(db)).toBe(0);
	});

	it("never throws for a missing or invalid type", async () => {
		const db = await createDb();
		const log = new EventLog(db);

		expect(() => log.record()).not.toThrow();
		expect(() => log.record(undefined)).not.toThrow();
		expect(() => log.record(null)).not.toThrow();
		expect(() => log.record(123)).not.toThrow();
		expect(() => log.record("")).not.toThrow();
		expect(() => log.record("   ")).not.toThrow();

		expect(log.pendingCount()).toBe(0);
	});

	it("never throws even when the payload can't be serialized", async () => {
		const db = await createDb();
		const log = new EventLog(db);
		const circular = {};
		circular.self = circular;

		expect(() => log.record("task.create", { subject: "task-1", payload: circular })).not.toThrow();

		log.flushNow();
		const [row] = db.all("SELECT * FROM events");
		expect(row.payload).toBeNull();
	});

	it("coerces environmentId/subject/sessionId to strings or null, never objects", async () => {
		const db = await createDb();
		const log = new EventLog(db);

		log.record("app.focus", { environmentId: 42, subject: undefined, sessionId: null });
		log.flushNow();

		const [row] = db.all("SELECT * FROM events");
		expect(row.environment_id).toBe("42");
		expect(row.subject).toBeNull();
		expect(row.session_id).toBeNull();
	});
});

describe("EventLog batching", () => {
	it("writes a large number of buffered events in a single transaction", async () => {
		const db = await createDb();
		// Big enough that the buffer cap never triggers an automatic flush --
		// this test is only about what flushNow() itself does.
		const log = new EventLog(db, { maxBufferSize: 100000 });
		const transactionSpy = vi.spyOn(db, "transaction");

		for (let i = 0; i < 1000; i++) {
			log.record("app.focus", { subject: `app-${i % 5}` });
		}
		expect(countEvents(db)).toBe(0);

		log.flushNow();

		expect(countEvents(db)).toBe(1000);
		// The whole batch went through ONE transaction, not one per event --
		// this is the WP-0.5 acceptance criterion: N events, far fewer than N
		// transactions/disk writes.
		expect(transactionSpy).toHaveBeenCalledTimes(1);
	});

	it("auto-flushes once the buffer exceeds its cap, well before N transactions for N events", async () => {
		const db = await createDb();
		const log = new EventLog(db, { maxBufferSize: 10 });
		const transactionSpy = vi.spyOn(db, "transaction");

		for (let i = 0; i < 25; i++) {
			log.record("app.focus", { subject: "chrome" });
		}

		// 25 events over a cap of 10 can trigger at most 2 automatic flushes
		// (at 10 and 20 buffered) -- nowhere near one transaction per event.
		expect(transactionSpy.mock.calls.length).toBeGreaterThan(0);
		expect(transactionSpy.mock.calls.length).toBeLessThan(25);
		expect(countEvents(db)).toBeGreaterThan(0);

		log.flushNow();
		expect(countEvents(db)).toBe(25);
	});

	it("flushNow on an empty buffer does not open a transaction", async () => {
		const db = await createDb();
		const log = new EventLog(db);
		const transactionSpy = vi.spyOn(db, "transaction");

		log.flushNow();

		expect(transactionSpy).not.toHaveBeenCalled();
	});
});

describe("EventLog flush timing (quit and timer)", () => {
	it("flushNow() persists everything currently buffered -- what before-quit calls", async () => {
		const db = await createDb();
		const log = new EventLog(db);

		log.record("session.start", { environmentId: "env-1", sessionId: "sess-1" });
		log.record("session.stop", { environmentId: "env-1", sessionId: "sess-1" });
		expect(countEvents(db)).toBe(0);

		log.flushNow();

		expect(countEvents(db)).toBe(2);
		expect(log.pendingCount()).toBe(0);
	});

	it("the flush timer flushes on its own cadence once started", async () => {
		vi.useFakeTimers();
		try {
			const db = await createDb();
			const log = new EventLog(db, { flushIntervalMs: 50 });
			log.start();

			log.record("app.focus", { subject: "chrome" });
			expect(countEvents(db)).toBe(0);

			vi.advanceTimersByTime(60);

			expect(countEvents(db)).toBe(1);
			log.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stop() clears the timer so it never fires again, without losing buffered events", async () => {
		vi.useFakeTimers();
		try {
			const db = await createDb();
			const log = new EventLog(db, { flushIntervalMs: 50 });
			log.start();
			log.stop();

			log.record("app.focus", { subject: "chrome" });
			vi.advanceTimersByTime(1000);

			expect(countEvents(db)).toBe(0); // timer never fired
			log.flushNow(); // simulates before-quit
			expect(countEvents(db)).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("start() is idempotent -- calling it twice does not double the flush rate", async () => {
		vi.useFakeTimers();
		try {
			const db = await createDb();
			const log = new EventLog(db, { flushIntervalMs: 50 });
			log.start();
			log.start();

			log.record("app.focus", { subject: "chrome" });
			vi.advanceTimersByTime(50);

			expect(countEvents(db)).toBe(1);
			log.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("EventLog flush failure handling", () => {
	it("drops the batch and does not throw when the underlying transaction fails", async () => {
		const db = await createDb();
		const log = new EventLog(db);
		log.record("app.focus", { subject: "chrome" });

		vi.spyOn(db, "transaction").mockImplementation(() => {
			throw new Error("simulated disk failure");
		});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => log.flushNow()).not.toThrow();
		expect(log.pendingCount()).toBe(0); // batch dropped, not retried forever
		expect(consoleSpy).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});
});

describe("pruneEvents() retention", () => {
	it("prunes events older than the retention window, inside a transaction", async () => {
		const db = await createDb();
		const now = Date.now();
		const oldTs = new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString();
		const recentTs = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
		seedEvents(db, [{ ts: oldTs }, { ts: oldTs }, { ts: recentTs }]);

		const transactionSpy = vi.spyOn(db, "transaction");
		const result = pruneEvents(db, { retentionDays: 90, rowCap: 1000000 });

		expect(result.deletedByAge).toBe(2);
		expect(result.deletedByCap).toBe(0);
		expect(countEvents(db)).toBe(1);
		expect(transactionSpy).toHaveBeenCalledTimes(1);
	});

	it("enforces the hard row cap independent of age, dropping the oldest rows first", async () => {
		const db = await createDb();
		const base = Date.now();
		const rows = Array.from({ length: 20 }, (_, i) => ({
			ts: new Date(base + i * 1000).toISOString(),
			subject: `evt-${i}`,
		}));
		seedEvents(db, rows);

		const result = pruneEvents(db, { retentionDays: 100000, rowCap: 5 });

		expect(result.deletedByCap).toBe(15);
		expect(countEvents(db)).toBe(5);

		const remaining = db.all("SELECT subject FROM events ORDER BY ts ASC").map((r) => r.subject);
		expect(remaining).toEqual(["evt-15", "evt-16", "evt-17", "evt-18", "evt-19"]);
	});

	it("seeds 100k events and verifies both the age window and the row cap hold", async () => {
		const db = await createDb();
		const base = Date.now();

		db.transaction(() => {
			for (let i = 0; i < 100000; i++) {
				// Half the rows are well outside a 90-day window, half are recent --
				// spread across distinct milliseconds so ordering is unambiguous.
				const daysAgo = i < 50000 ? 200 : 1;
				db.run("INSERT INTO events (ts, type, subject) VALUES (?, ?, ?)", [
					new Date(base - daysAgo * 24 * 60 * 60 * 1000 + (i % 1000)).toISOString(),
					"app.focus",
					String(i),
				]);
			}
		});
		expect(countEvents(db)).toBe(100000);

		// Age-based pruning alone: the 50k old rows go, the 50k recent rows stay.
		const ageResult = pruneEvents(db, { retentionDays: 90, rowCap: 1000000 });
		expect(ageResult.deletedByAge).toBe(50000);
		expect(countEvents(db)).toBe(50000);

		// Now a tight row cap on top of that.
		const capResult = pruneEvents(db, { retentionDays: 90, rowCap: 1000 });
		expect(capResult.deletedByCap).toBe(49000);
		expect(countEvents(db)).toBe(1000);
	}, 30000);

	it("does nothing when both retentionDays and rowCap are disabled (0)", async () => {
		const db = await createDb();
		seedEvents(db, [{ ts: new Date(0).toISOString() }]);

		const result = pruneEvents(db, { retentionDays: 0, rowCap: 0 });

		expect(result).toEqual({ deletedByAge: 0, deletedByCap: 0 });
		expect(countEvents(db)).toBe(1);
	});

	it("EventLog#pruneNow() uses the instance's configured policy by default", async () => {
		const db = await createDb();
		const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
		seedEvents(db, [{ ts: oldTs }]);

		const log = new EventLog(db, { retentionDays: 30, rowCap: 1000000 });
		const result = log.pruneNow();

		expect(result.deletedByAge).toBe(1);
		expect(countEvents(db)).toBe(0);
	});
});

describe("query helpers", () => {
	function seed(db) {
		const t0 = Date.now();
		const rows = [
			{ ts: new Date(t0).toISOString(), type: "session.start", environmentId: "env-a", sessionId: "s1" },
			{
				ts: new Date(t0 + 1000).toISOString(),
				type: "app.focus",
				environmentId: "env-a",
				sessionId: "s1",
				subject: "chrome",
			},
			{
				ts: new Date(t0 + 2000).toISOString(),
				type: "task.complete",
				environmentId: "env-a",
				sessionId: "s1",
				subject: "task-1",
			},
			{
				ts: new Date(t0 + 3000).toISOString(),
				type: "app.focus",
				environmentId: "env-b",
				sessionId: "s2",
				subject: "code",
			},
			{ ts: new Date(t0 + 4000).toISOString(), type: "session.stop", environmentId: "env-a", sessionId: "s1" },
		];
		seedEvents(db, rows);
		return rows;
	}

	it("listEventsInRange returns events within [start, end) in ascending order", async () => {
		const db = await createDb();
		const rows = seed(db);

		const result = listEventsInRange(db, rows[1].ts, rows[4].ts);

		expect(result.map((e) => e.type)).toEqual(["app.focus", "task.complete", "app.focus"]);
	});

	it("listEventsInRange respects a limit", async () => {
		const db = await createDb();
		const rows = seed(db);

		const result = listEventsInRange(db, rows[0].ts, rows[4].ts, { limit: 2 });

		expect(result).toHaveLength(2);
	});

	it("listEventsByType filters to a single type across the whole table", async () => {
		const db = await createDb();
		seed(db);

		const result = listEventsByType(db, "app.focus");

		expect(result).toHaveLength(2);
		expect(result.every((e) => e.type === "app.focus")).toBe(true);
	});

	it("listEventsByType can additionally be scoped to a time range", async () => {
		const db = await createDb();
		const rows = seed(db);

		const result = listEventsByType(db, "app.focus", { startIso: rows[3].ts });

		expect(result).toHaveLength(1);
		expect(result[0].subject).toBe("code");
	});

	it("listEventsByEnvironment filters to one environment", async () => {
		const db = await createDb();
		seed(db);

		const result = listEventsByEnvironment(db, "env-b");

		expect(result).toHaveLength(1);
		expect(result[0].subject).toBe("code");
	});

	it("listEventsByEnvironment returns nothing for an unknown environment", async () => {
		const db = await createDb();
		seed(db);

		expect(listEventsByEnvironment(db, "env-does-not-exist")).toEqual([]);
	});

	it("listEventsFollowing returns every later event within the time window, in order", async () => {
		const db = await createDb();
		seed(db);

		const anchor = db.first("SELECT id FROM events WHERE type = 'session.start'");
		const following = listEventsFollowing(db, anchor.id, { withinMinutes: 60 });

		expect(following.map((e) => e.type)).toEqual(["app.focus", "task.complete", "app.focus", "session.stop"]);
	});

	it("listEventsFollowing excludes events outside the time window", async () => {
		const db = await createDb();
		const t0 = Date.now();
		seedEvents(db, [
			{ ts: new Date(t0).toISOString(), type: "session.start" },
			{ ts: new Date(t0 + 5 * 60000).toISOString(), type: "app.focus", subject: "inside-window" },
			{ ts: new Date(t0 + 60 * 60000).toISOString(), type: "app.focus", subject: "outside-window" },
		]);

		const anchor = db.first("SELECT id FROM events WHERE type = 'session.start'");
		const following = listEventsFollowing(db, anchor.id, { withinMinutes: 10 });

		expect(following).toHaveLength(1);
		expect(following[0].subject).toBe("inside-window");
	});

	it("listEventsFollowing can filter to specific event types", async () => {
		const db = await createDb();
		seed(db);

		const anchor = db.first("SELECT id FROM events WHERE type = 'session.start'");
		const following = listEventsFollowing(db, anchor.id, { withinMinutes: 60, types: ["task.complete"] });

		expect(following).toHaveLength(1);
		expect(following[0].type).toBe("task.complete");
	});

	it("listEventsFollowing breaks same-timestamp ties by insertion order (id), never returning the anchor itself", async () => {
		const db = await createDb();
		const sharedTs = new Date().toISOString();
		seedEvents(db, [
			{ ts: sharedTs, type: "session.start" },
			{ ts: sharedTs, type: "app.focus", subject: "same-millisecond" },
		]);

		const anchor = db.first("SELECT id FROM events WHERE type = 'session.start'");
		const following = listEventsFollowing(db, anchor.id, { withinMinutes: 1 });

		expect(following).toHaveLength(1);
		expect(following[0].subject).toBe("same-millisecond");
	});

	it("listEventsFollowing returns an empty array for an id that doesn't exist", async () => {
		const db = await createDb();
		seed(db);

		expect(listEventsFollowing(db, 999999)).toEqual([]);
	});

	it("payload round-trips through JSON for every helper", async () => {
		const db = await createDb();
		const log = new EventLog(db);
		log.record("task.create", { environmentId: "env-a", subject: "task-9", payload: { foo: "bar", n: 1 } });
		log.flushNow();

		const [event] = listEventsByType(db, "task.create");
		expect(event.payload).toEqual({ foo: "bar", n: 1 });
	});

	it("a null payload column parses back to null, not an error", async () => {
		const db = await createDb();
		seedEvents(db, [{ ts: new Date().toISOString(), type: "session.start" }]);

		const [event] = listEventsByType(db, "session.start");
		expect(event.payload).toBeNull();
	});
});
