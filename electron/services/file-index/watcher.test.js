import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { createFileIndexWatcher } from "./watcher.cjs";
import { searchFiles } from "./store.cjs";

// ---------------------------------------------------------------------------
// The file index watcher (WP-2.6) -- the debounce/coalesce timer is driven
// through injected FAKE `createWatch`/`stat` functions plus vitest's fake
// timers (never a real fs.watch handle or a real setTimeout), so these tests
// are fast and deterministic. One integration test at the bottom spins a
// REAL `fs.watch({ recursive: true })` against a real scratch temp directory
// to prove the actual OS-level wiring works end-to-end, mirroring
// crawl-worker.test.js's own real-Worker integration test.
//
// Every scratch path here is a temp file/directory, never %APPDATA%/Atlas or
// Atlas-Dev. Every watcher created is stopped in afterEach, so no test can
// leak an open handle (or a real Worker/timer) into the rest of the suite.
// ---------------------------------------------------------------------------

const tmpDirs = [];
const activeWatchers = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-watcher-test-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const watcher of activeWatchers.splice(0)) {
		try {
			watcher.stop();
		} catch {
			// best-effort
		}
	}
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function createDb() {
	const dir = makeTempDir();
	return AtlasDatabase.create(path.join(dir, "atlas.db"));
}

function enoent(target) {
	const error = new Error(`ENOENT: no such file or directory, stat '${target}'`);
	error.code = "ENOENT";
	return error;
}

function fakeFileStat({ size = 10, mtimeMs = 1_700_000_000_000 } = {}) {
	return { isFile: () => true, isDirectory: () => false, size, mtimeMs };
}

function fakeDirStat() {
	return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
}

// Stands in for `fs.watch()` -- records every root it was asked to watch
// (each with its own listener + a `.close()` spy) instead of touching the
// real filesystem.
function createFakeWatchFactory() {
	const created = [];
	const createWatch = (dirPath, options, listener) => {
		const watcher = new EventEmitter();
		watcher.close = vi.fn();
		created.push({ dirPath, options, listener, watcher });
		return watcher;
	};
	return { createWatch, created };
}

function defaultPreferences(overrides = {}) {
	return {
		roots: [{ id: "r1", label: "Root", path: "C:\\root", environmentId: null, enabled: true }],
		exclusions: ["node_modules"],
		maxDepth: 12,
		maxFiles: 200_000,
		...overrides,
	};
}

function createTestWatcher({ statMap = new Map(), preferences = defaultPreferences(), ...overrides } = {}) {
	const fake = overrides.createWatch ? { createWatch: overrides.createWatch, created: [] } : createFakeWatchFactory();
	const statFn =
		overrides.stat ??
		(async (target) => {
			if (statMap.has(target)) {
				return statMap.get(target);
			}
			throw enoent(target);
		});

	const watcher = createFileIndexWatcher({
		getDb: overrides.getDb ?? (() => null),
		getPreferences: overrides.getPreferences ?? (() => preferences),
		getEventLog: overrides.getEventLog ?? (() => null),
		createWatch: fake.createWatch,
		stat: statFn,
		broadcast: overrides.broadcast ?? (() => {}),
		powerMonitor:
			overrides.powerMonitor ?? { isOnBatteryPower: () => false, on: () => {}, removeListener: () => {} },
		debounceMs: overrides.debounceMs ?? 100,
		batteryDebounceMs: overrides.batteryDebounceMs ?? 500,
		triggerRecrawl: overrides.triggerRecrawl,
		safetyNetIntervalMs: overrides.safetyNetIntervalMs,
		setInterval: overrides.setInterval,
		clearInterval: overrides.clearInterval,
	});
	activeWatchers.push(watcher);
	return { watcher, created: fake.created, statMap };
}

// The safety-net interval is four hours in production, so these drive it
// through injected setInterval/clearInterval seams and call the captured
// callback directly -- the point under test is the SCHEDULING and the guards,
// not setInterval itself.
function createSafetyNetHarness(overrides = {}) {
	const intervals = [];
	const clearIntervalSpy = vi.fn();
	const triggerRecrawl = overrides.triggerRecrawl ?? vi.fn();
	const { watcher } = createTestWatcher({
		triggerRecrawl: "triggerRecrawl" in overrides ? overrides.triggerRecrawl : triggerRecrawl,
		safetyNetIntervalMs: overrides.safetyNetIntervalMs ?? 60_000,
		setInterval: (callback, ms) => {
			const handle = { callback, ms, unref: vi.fn() };
			intervals.push(handle);
			return handle;
		},
		clearInterval: clearIntervalSpy,
		powerMonitor: overrides.powerMonitor,
	});
	return { watcher, intervals, clearIntervalSpy, triggerRecrawl };
}

describe("createFileIndexWatcher -- the periodic safety-net re-crawl", () => {
	// Windows can drop change notifications without surfacing an error, so the
	// reactive fallback in stopRoot() can never see that failure. The whole
	// point of this timer is that it does not wait to be told something broke.
	it("schedules a sweep on the configured interval when watching starts", () => {
		const { watcher, intervals } = createSafetyNetHarness({ safetyNetIntervalMs: 60_000 });
		expect(intervals).toHaveLength(0);
		watcher.start();
		expect(intervals).toHaveLength(1);
		expect(intervals[0].ms).toBe(60_000);
		// Must never be the reason the app can't quit.
		expect(intervals[0].unref).toHaveBeenCalled();
	});

	it("a sweep kicks off a full re-crawl", () => {
		const { watcher, intervals, triggerRecrawl } = createSafetyNetHarness();
		watcher.start();
		expect(triggerRecrawl).not.toHaveBeenCalled();
		const fired = intervals[0].callback();
		expect(fired).toBe(true);
		expect(triggerRecrawl).toHaveBeenCalledTimes(1);
	});

	it("stop() clears the sweep, and a late tick after stop() re-crawls nothing", () => {
		const { watcher, intervals, clearIntervalSpy, triggerRecrawl } = createSafetyNetHarness();
		watcher.start();
		const handle = intervals[0];
		watcher.stop();
		expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
		// Even if a tick still lands (a timer that already fired, a stale
		// reference), it must not start a crawl for a watcher that is stopped.
		expect(handle.callback()).toBe(false);
		expect(triggerRecrawl).not.toHaveBeenCalled();
	});

	it("skips the sweep while on battery rather than starting the most expensive walk in the package", () => {
		const { watcher, intervals, triggerRecrawl } = createSafetyNetHarness({
			powerMonitor: { isOnBatteryPower: () => true, on: () => {}, removeListener: () => {} },
		});
		watcher.start();
		expect(intervals[0].callback()).toBe(false);
		expect(triggerRecrawl).not.toHaveBeenCalled();
	});

	it("schedules nothing at all when no re-crawl hook is wired up", () => {
		const { watcher, intervals } = createSafetyNetHarness({ triggerRecrawl: undefined });
		watcher.start();
		expect(intervals).toHaveLength(0);
	});
});

describe("createFileIndexWatcher -- lifecycle", () => {
	it("start() reports state='error' when there are no enabled roots", () => {
		const { watcher } = createTestWatcher({ preferences: defaultPreferences({ roots: [] }) });
		const status = watcher.start();
		expect(status.state).toBe("error");
		expect(status.error).toMatch(/no enabled roots/i);
	});

	it("start() opens exactly one watch per enabled root and reports state='watching'", () => {
		const { watcher, created } = createTestWatcher({
			preferences: defaultPreferences({
				roots: [
					{ id: "r1", path: "C:\\a", environmentId: null, enabled: true },
					{ id: "r2", path: "C:\\b", environmentId: null, enabled: true },
					{ id: "r3", path: "C:\\c", environmentId: null, enabled: false },
				],
			}),
		});
		const status = watcher.start();
		expect(status.state).toBe("watching");
		expect(status.rootsWatched).toBe(2);
		expect(created).toHaveLength(2); // the disabled root was never watched
	});

	it("start() is idempotent -- calling it twice does not open a second watch", () => {
		const { watcher, created } = createTestWatcher();
		watcher.start();
		watcher.start();
		expect(created).toHaveLength(1);
	});

	it("stop() closes every open watch handle", () => {
		const { watcher, created } = createTestWatcher();
		watcher.start();
		watcher.stop();
		expect(created[0].watcher.close).toHaveBeenCalledTimes(1);
		expect(watcher.getStatus().state).toBe("stopped");
	});

	it("stop() clears any pending debounce timer so a scheduled flush never fires and never writes", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([["C:\\root\\a.txt", fakeFileStat()]]);
		const { watcher, created } = createTestWatcher({ getDb: () => db, statMap });
		watcher.start();
		created[0].listener("change", "a.txt");
		expect(watcher.getStatus().pendingCount).toBe(1);

		watcher.stop();
		vi.advanceTimersByTime(10_000); // long past the debounce window
		await watcher.waitForIdle();

		expect(db.all("SELECT * FROM files")).toHaveLength(0);
	});

	it("shutdown() is a safe alias for stop() (called on app quit)", () => {
		const { watcher, created } = createTestWatcher();
		watcher.start();
		watcher.shutdown();
		expect(created[0].watcher.close).toHaveBeenCalledTimes(1);
	});
});

describe("createFileIndexWatcher -- debounce and coalescing", () => {
	it("coalesces repeated events for the SAME path into exactly one upsert", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([["C:\\root\\a.txt", fakeFileStat()]]);
		const { watcher, created } = createTestWatcher({ getDb: () => db, statMap });
		watcher.start();

		created[0].listener("change", "a.txt");
		created[0].listener("rename", "a.txt");
		created[0].listener("change", "a.txt");
		expect(watcher.getStatus().pendingCount).toBe(1); // one dirty PATH, not three events

		vi.advanceTimersByTime(100);
		await watcher.waitForIdle();

		expect(db.all("SELECT path FROM files")).toHaveLength(1);
	});

	it("a storm of events does not postpone the flush past debounceMs -- the timer starts on the FIRST event, not the last", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([
			["C:\\root\\a.txt", fakeFileStat()],
			["C:\\root\\b.txt", fakeFileStat()],
		]);
		const { watcher, created } = createTestWatcher({ getDb: () => db, statMap, debounceMs: 100 });
		watcher.start();

		created[0].listener("change", "a.txt");
		vi.advanceTimersByTime(50); // halfway through the window
		created[0].listener("change", "b.txt"); // a NEW event -- must NOT reset the timer
		vi.advanceTimersByTime(50); // total elapsed since the FIRST event: 100ms

		await watcher.waitForIdle();

		// Both files landed in the single flush the first event's timer scheduled.
		expect(db.all("SELECT path FROM files ORDER BY path").map((r) => r.path)).toEqual([
			"C:\\root\\a.txt",
			"C:\\root\\b.txt",
		]);
	});

	it("widens the debounce window while on battery, instead of pausing outright", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([["C:\\root\\a.txt", fakeFileStat()]]);
		const { watcher, created } = createTestWatcher({
			getDb: () => db,
			statMap,
			debounceMs: 100,
			batteryDebounceMs: 500,
			powerMonitor: { isOnBatteryPower: () => true, on: () => {}, removeListener: () => {} },
		});
		watcher.start();
		expect(watcher.getStatus().onBattery).toBe(true);

		created[0].listener("change", "a.txt");
		vi.advanceTimersByTime(100); // the non-battery debounce window
		await watcher.waitForIdle();
		expect(db.all("SELECT * FROM files")).toHaveLength(0); // not yet -- battery widens it

		vi.advanceTimersByTime(400); // now past the battery window (500ms total)
		await watcher.waitForIdle();
		expect(db.all("SELECT * FROM files")).toHaveLength(1);
	});
});

describe("createFileIndexWatcher -- excluded/out-of-depth paths are never tracked", () => {
	it("an event for a path under an excluded directory name never reaches the dirty set at all", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const { watcher, created } = createTestWatcher({ getDb: () => db }); // default exclusions include node_modules
		watcher.start();

		created[0].listener("change", "node_modules\\pkg\\index.js");
		expect(watcher.getStatus().pendingCount).toBe(0);

		vi.advanceTimersByTime(200);
		await watcher.waitForIdle();
		expect(db.all("SELECT * FROM files")).toHaveLength(0);
	});

	it("an event for a path past maxDepth is dropped the same way the crawler would never have descended that far", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([["C:\\root\\a\\b\\deep.txt", fakeFileStat()]]);
		const { watcher, created } = createTestWatcher({
			getDb: () => db,
			statMap,
			preferences: defaultPreferences({ maxDepth: 1, exclusions: [] }),
		});
		watcher.start();

		created[0].listener("change", "a\\b\\deep.txt");
		expect(watcher.getStatus().pendingCount).toBe(0);

		vi.advanceTimersByTime(200);
		await watcher.waitForIdle();
		expect(db.all("SELECT * FROM files")).toHaveLength(0);
	});
});

describe("createFileIndexWatcher -- resolve-by-stat (create/modify/delete/rename)", () => {
	it("a create/modify event upserts the file into files AND files_fts", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([["C:\\root\\report.pdf", fakeFileStat({ size: 4096 })]]);
		const { watcher, created } = createTestWatcher({ getDb: () => db, statMap });
		watcher.start();

		created[0].listener("rename", "report.pdf");
		vi.advanceTimersByTime(100);
		await watcher.waitForIdle();

		expect(db.first("SELECT size FROM files WHERE path = ?", ["C:\\root\\report.pdf"]).size).toBe(4096);
		expect(searchFiles(db, "report", null, 10).map((r) => r.path)).toEqual(["C:\\root\\report.pdf"]);
	});

	it("a delete event (stat fails with ENOENT) removes the file from files AND files_fts", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([["C:\\root\\gone.txt", fakeFileStat()]]);
		const { watcher, created } = createTestWatcher({ getDb: () => db, statMap });
		watcher.start();

		created[0].listener("rename", "gone.txt");
		vi.advanceTimersByTime(100);
		await watcher.waitForIdle();
		expect(db.all("SELECT * FROM files")).toHaveLength(1);

		statMap.delete("C:\\root\\gone.txt"); // simulates the file having been deleted
		created[0].listener("rename", "gone.txt");
		vi.advanceTimersByTime(100);
		await watcher.waitForIdle();

		expect(db.all("SELECT * FROM files WHERE path = ?", ["C:\\root\\gone.txt"])).toHaveLength(0);
		expect(searchFiles(db, "gone", null, 10)).toEqual([]);
	});

	it("a rename (old path gone, new path present) resolves to a delete of the old path and an insert of the new one", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([["C:\\root\\old-name.txt", fakeFileStat()]]);
		const { watcher, created } = createTestWatcher({ getDb: () => db, statMap });
		watcher.start();
		created[0].listener("rename", "old-name.txt");
		vi.advanceTimersByTime(100);
		await watcher.waitForIdle();
		expect(db.all("SELECT * FROM files")).toHaveLength(1);

		// The rename: the old path is gone, the new path now exists. Both events
		// typically arrive together in one Windows notification pair.
		statMap.delete("C:\\root\\old-name.txt");
		statMap.set("C:\\root\\new-name.txt", fakeFileStat());
		created[0].listener("rename", "old-name.txt");
		created[0].listener("rename", "new-name.txt");
		vi.advanceTimersByTime(100);
		await watcher.waitForIdle();

		expect(db.all("SELECT path FROM files").map((r) => r.path)).toEqual(["C:\\root\\new-name.txt"]);
	});

	it("a directory-level event (stat says isDirectory) is not indexed as a file", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([["C:\\root\\subdir", fakeDirStat()]]);
		const { watcher, created } = createTestWatcher({ getDb: () => db, statMap });
		watcher.start();

		created[0].listener("rename", "subdir");
		vi.advanceTimersByTime(100);
		await watcher.waitForIdle();

		expect(db.all("SELECT * FROM files")).toHaveLength(0);
	});
});

describe("createFileIndexWatcher -- environment scoping", () => {
	it("a watched file inherits environment_id from the ROOT it was found under, not re-derived per file", async () => {
		vi.useFakeTimers();
		const db = await createDb();
		const statMap = new Map([["C:\\root\\scoped.txt", fakeFileStat()]]);
		const { watcher, created } = createTestWatcher({
			getDb: () => db,
			statMap,
			preferences: defaultPreferences({
				roots: [{ id: "r1", path: "C:\\root", environmentId: "env-a", enabled: true }],
			}),
		});
		watcher.start();

		created[0].listener("change", "scoped.txt");
		vi.advanceTimersByTime(100);
		await watcher.waitForIdle();

		const row = db.first("SELECT environment_id FROM files WHERE path = ?", ["C:\\root\\scoped.txt"]);
		expect(row.environment_id).toBe("env-a");
	});
});

describe("createFileIndexWatcher -- graceful degradation on watch failure", () => {
	it("a root's watch emitting 'error' at runtime tears down just that root and triggers the fallback re-crawl", () => {
		const triggerRecrawl = vi.fn();
		const { watcher, created } = createTestWatcher({
			triggerRecrawl,
			preferences: defaultPreferences({
				roots: [{ id: "r1", path: "C:\\root", environmentId: null, enabled: true }],
			}),
		});
		watcher.start();

		created[0].watcher.emit("error", new Error("handle lost"));

		expect(created[0].watcher.close).toHaveBeenCalledTimes(1);
		expect(triggerRecrawl).toHaveBeenCalledTimes(1);
		const status = watcher.getStatus();
		expect(status.state).toBe("error");
		expect(status.rootsWatched).toBe(0);
	});

	it("one root failing leaves the other roots still watched", () => {
		const { watcher, created } = createTestWatcher({
			preferences: defaultPreferences({
				roots: [
					{ id: "r1", path: "C:\\a", environmentId: null, enabled: true },
					{ id: "r2", path: "C:\\b", environmentId: null, enabled: true },
				],
			}),
		});
		watcher.start();
		created[0].watcher.emit("error", new Error("handle lost"));

		const status = watcher.getStatus();
		expect(status.state).toBe("watching");
		expect(status.rootsWatched).toBe(1);
	});
});

// -- Real fs.watch integration test ------------------------------------------
// Proves the actual `fs.watch(root, { recursive: true }, ...)` wiring (this
// project's own choice, see watcher.cjs's header) works end-to-end on
// Windows -- not just the injected-fake tests above. Polls with real timers
// (a real debounce window, deliberately short) rather than asserting
// immediately, since real filesystem notifications are not synchronous.
describe("watcher.cjs against a real fs.watch", () => {
	it("reflects a real create, then a real delete, of a file under a real temp root", async () => {
		const dir = makeTempDir();
		const db = await createDb();
		const { watcher } = createTestWatcher({
			getDb: () => db,
			createWatch: (dirPath, options, listener) => fs.watch(dirPath, options, listener),
			stat: (target) => fs.promises.stat(target),
			debounceMs: 150,
			preferences: defaultPreferences({ roots: [{ id: "r1", path: dir, environmentId: null, enabled: true }] }),
		});
		const status = watcher.start();
		expect(status.state).toBe("watching");

		const filePath = path.join(dir, "created-by-test.txt");
		fs.writeFileSync(filePath, "hello");

		await waitUntil(() => db.all("SELECT * FROM files").length === 1, 10_000);
		expect(db.first("SELECT path FROM files").path).toBe(filePath);

		fs.unlinkSync(filePath);

		await waitUntil(() => db.all("SELECT * FROM files").length === 0, 10_000);
	}, 20_000);
});

function waitUntil(predicate, timeoutMs) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - start > timeoutMs) {
				reject(new Error("waitUntil() timed out"));
				return;
			}
			setTimeout(tick, 100);
		};
		tick();
	});
}
