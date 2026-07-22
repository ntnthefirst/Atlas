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
	countEventsBySubject,
	listDistinctEventEnvironmentIds,
	listEventsForMining,
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

describe("EventLog.subscribe() (WP-3.1 -- the smart functions engine's trigger source)", () => {
	it("notifies a subscriber synchronously, with the RAW (unserialized) payload, the instant record() is called", async () => {
		const db = await createDb();
		const log = new EventLog(db);
		const seen = [];
		log.subscribe((event) => seen.push(event));

		log.record("session.start", { environmentId: "env-a", sessionId: "sess-1", payload: { foo: "bar" } });

		// Synchronous: no flush, no await, nothing async between record() and
		// the listener firing -- this is what "event-driven, not polling" rests
		// on for every trigger type that rides the event log.
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ type: "session.start", environmentId: "env-a", sessionId: "sess-1" });
		expect(seen[0].payload).toEqual({ foo: "bar" }); // a plain object, not a JSON string
	});

	it("notifies every registered subscriber, in registration order", async () => {
		const db = await createDb();
		const log = new EventLog(db);
		const order = [];
		log.subscribe(() => order.push("first"));
		log.subscribe(() => order.push("second"));

		log.record("app.focus", { subject: "chrome" });

		expect(order).toEqual(["first", "second"]);
	});

	it("the returned unsubscribe function stops further notifications for that listener only", async () => {
		const db = await createDb();
		const log = new EventLog(db);
		const seenA = [];
		const seenB = [];
		const unsubscribeA = log.subscribe((event) => seenA.push(event));
		log.subscribe((event) => seenB.push(event));

		log.record("app.focus", { subject: "chrome" });
		unsubscribeA();
		log.record("app.focus", { subject: "code" });

		expect(seenA).toHaveLength(1); // stopped after unsubscribing
		expect(seenB).toHaveLength(2); // never unsubscribed
	});

	it("a throwing subscriber never breaks record() or any OTHER subscriber", async () => {
		const db = await createDb();
		const log = new EventLog(db);
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const seen = [];
		log.subscribe(() => {
			throw new Error("a badly behaved listener");
		});
		log.subscribe((event) => seen.push(event));

		expect(() => log.record("app.focus", { subject: "chrome" })).not.toThrow();
		expect(seen).toHaveLength(1); // the second listener still ran
		expect(log.pendingCount()).toBe(1); // and the event still got buffered
		consoleSpy.mockRestore();
	});

	it("record() calls with an invalid/missing type never notify subscribers -- nothing was actually recorded", async () => {
		const db = await createDb();
		const log = new EventLog(db);
		const seen = [];
		log.subscribe((event) => seen.push(event));

		log.record();
		log.record("");
		log.record("   ");

		expect(seen).toEqual([]);
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

describe("countEventsBySubject() (WP-2.2 -- launcher frecency)", () => {
	it("aggregates count and most-recent timestamp per subject, for one type", async () => {
		const db = await createDb();
		const t0 = Date.now();
		seedEvents(db, [
			{ ts: new Date(t0).toISOString(), type: "launcher.execute", environmentId: "env-a", subject: "actions::open-settings" },
			{
				ts: new Date(t0 + 1000).toISOString(),
				type: "launcher.execute",
				environmentId: "env-a",
				subject: "actions::open-settings",
			},
			{
				ts: new Date(t0 + 2000).toISOString(),
				type: "launcher.execute",
				environmentId: "env-a",
				subject: "actions::new-task",
			},
		]);

		const rows = countEventsBySubject(db, "launcher.execute", "env-a");
		const bySubject = Object.fromEntries(rows.map((r) => [r.subject, r]));

		expect(bySubject["actions::open-settings"].count).toBe(2);
		expect(bySubject["actions::open-settings"].lastTs).toBe(new Date(t0 + 1000).toISOString());
		expect(bySubject["actions::new-task"].count).toBe(1);
	});

	it("only counts events of the requested type", async () => {
		const db = await createDb();
		seedEvents(db, [
			{ ts: new Date().toISOString(), type: "launcher.execute", environmentId: "env-a", subject: "actions::x" },
			{ ts: new Date().toISOString(), type: "launcher.query", environmentId: "env-a", subject: "actions::x" },
		]);

		const rows = countEventsBySubject(db, "launcher.execute", "env-a");
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(1);
	});

	it("is scoped per environment -- the same subject in two environments never mixes counts", async () => {
		const db = await createDb();
		seedEvents(db, [
			{ ts: new Date().toISOString(), type: "launcher.execute", environmentId: "env-a", subject: "actions::x" },
			{ ts: new Date().toISOString(), type: "launcher.execute", environmentId: "env-a", subject: "actions::x" },
			{ ts: new Date().toISOString(), type: "launcher.execute", environmentId: "env-b", subject: "actions::x" },
		]);

		const envA = countEventsBySubject(db, "launcher.execute", "env-a");
		const envB = countEventsBySubject(db, "launcher.execute", "env-b");

		expect(envA.find((r) => r.subject === "actions::x").count).toBe(2);
		expect(envB.find((r) => r.subject === "actions::x").count).toBe(1);
	});

	it("excludes rows with a null subject", async () => {
		const db = await createDb();
		seedEvents(db, [{ ts: new Date().toISOString(), type: "launcher.execute", environmentId: "env-a", subject: null }]);

		expect(countEventsBySubject(db, "launcher.execute", "env-a")).toEqual([]);
	});

	it("refuses to run unscoped -- throws without an environmentId", async () => {
		const db = await createDb();
		expect(() => countEventsBySubject(db, "launcher.execute", null)).toThrow(/requires an environmentId/i);
		expect(() => countEventsBySubject(db, "launcher.execute", undefined)).toThrow(/requires an environmentId/i);
	});
});

describe("listDistinctEventEnvironmentIds (WP-3.3)", () => {
	it("returns every environment id that has recorded an event, including the null bucket", async () => {
		const db = await createDb();
		seedEvents(db, [
			{ ts: "2026-01-01T00:00:00.000Z", environmentId: "env-a" },
			{ ts: "2026-01-01T00:01:00.000Z", environmentId: "env-b" },
			{ ts: "2026-01-01T00:02:00.000Z", environmentId: null },
		]);

		const ids = listDistinctEventEnvironmentIds(db);
		expect(new Set(ids)).toEqual(new Set(["env-a", "env-b", null]));
	});

	it("never repeats an id -- DISTINCT, not every row", async () => {
		const db = await createDb();
		seedEvents(db, [
			{ ts: "2026-01-01T00:00:00.000Z", environmentId: "env-a" },
			{ ts: "2026-01-01T00:01:00.000Z", environmentId: "env-a" },
			{ ts: "2026-01-01T00:02:00.000Z", environmentId: "env-a" },
		]);
		expect(listDistinctEventEnvironmentIds(db)).toEqual(["env-a"]);
	});

	it("returns an empty array when the table has no rows at all", async () => {
		const db = await createDb();
		expect(listDistinctEventEnvironmentIds(db)).toEqual([]);
	});
});

describe("listEventsForMining (WP-3.3)", () => {
	it("scopes strictly to one environment, never leaking another's rows", async () => {
		const db = await createDb();
		seedEvents(db, [
			{ ts: "2026-01-01T00:00:00.000Z", environmentId: "env-a", type: "app.focus", subject: "A" },
			{ ts: "2026-01-01T00:01:00.000Z", environmentId: "env-b", type: "app.focus", subject: "B" },
		]);

		const rows = listEventsForMining(db, "env-a", {});
		expect(rows.length).toBe(1);
		expect(rows[0].subject).toBe("A");
	});

	it("selects only id/ts/type/subject -- never payload/session_id/environment_id", async () => {
		const db = await createDb();
		seedEvents(db, [
			{
				ts: "2026-01-01T00:00:00.000Z",
				environmentId: "env-a",
				type: "app.focus",
				subject: "A",
				payload: JSON.stringify({ secret: "never sent to a worker" }),
				sessionId: "session-1",
			},
		]);

		const [row] = listEventsForMining(db, "env-a", {});
		expect(Object.keys(row).sort()).toEqual(["id", "subject", "ts", "type"]);
	});

	it("treats a null/falsy environmentId as the dedicated 'no environment' bucket", async () => {
		const db = await createDb();
		seedEvents(db, [
			{ ts: "2026-01-01T00:00:00.000Z", environmentId: null, type: "app.focus", subject: "global" },
			{ ts: "2026-01-01T00:01:00.000Z", environmentId: "env-a", type: "app.focus", subject: "scoped" },
		]);

		const rows = listEventsForMining(db, null, {});
		expect(rows.length).toBe(1);
		expect(rows[0].subject).toBe("global");
	});

	it("pages forward correctly via the (afterTs, afterId) cursor, with no gaps and no repeats", async () => {
		const db = await createDb();
		const rows = [];
		for (let i = 0; i < 25; i += 1) {
			rows.push({
				ts: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60000).toISOString(),
				environmentId: "env-a",
				type: "app.focus",
				subject: `s${i}`,
			});
		}
		seedEvents(db, rows);

		const pages = [];
		let afterTs = "";
		let afterId = 0;
		for (let guard = 0; guard < 100; guard += 1) {
			const page = listEventsForMining(db, "env-a", { afterTs, afterId, limit: 7 });
			if (page.length === 0) {
				break;
			}
			pages.push(page);
			const last = page[page.length - 1];
			afterTs = last.ts;
			afterId = last.id;
			if (page.length < 7) {
				break;
			}
		}

		expect(pages.length).toBe(4); // 25 rows at 7/page: 7, 7, 7, 4
		const allSubjects = pages.flatMap((page) => page.map((row) => row.subject));
		expect(allSubjects).toEqual(rows.map((_, i) => `s${i}`)); // exact order, no gaps, no repeats
		expect(new Set(allSubjects).size).toBe(25); // never repeated across pages
	});
});
