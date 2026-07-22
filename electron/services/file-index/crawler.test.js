import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { createFileIndexCrawler } from "./crawler.cjs";
import { getIndexStats } from "./store.cjs";

// ---------------------------------------------------------------------------
// The main-thread crawl orchestrator (WP-2.5) -- driven entirely through an
// INJECTED fake worker (a plain EventEmitter standing in for a real
// worker_threads Worker), so these tests are fast/deterministic and never
// spin a real OS thread. crawl-worker.test.js is what proves the real
// worker-thread wiring itself works.
//
// Every scratch path here (`getPrefsPath`) is a temp file, never
// %APPDATA%/Atlas or Atlas-Dev.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-crawler-test-"));
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
	}
	postMessage(message) {
		this.posted.push(message);
	}
	terminate() {
		this.terminated = true;
	}
}

async function createDb() {
	const dir = makeTempDir();
	return AtlasDatabase.create(path.join(dir, "atlas.db"));
}

function createTestCrawler(overrides = {}) {
	const dir = makeTempDir();
	const prefsPath = path.join(dir, "file-index-prefs.json");
	let lastWorker = null;
	const createWorker = overrides.createWorker ?? (() => (lastWorker = new FakeWorker()));

	const crawler = createFileIndexCrawler({
		getPrefsPath: () => prefsPath,
		createWorker,
		getDb: overrides.getDb ?? (() => null),
		getEventLog: overrides.getEventLog ?? (() => null),
		broadcast: overrides.broadcast ?? (() => {}),
		powerMonitor: overrides.powerMonitor ?? { isOnBatteryPower: () => false, on: () => {}, removeListener: () => {} },
		homeDir: "C:\\Users\\tester",
	});

	return { crawler, getWorker: () => lastWorker, prefsPath };
}

describe("createFileIndexCrawler -- preferences", () => {
	it("loadPreferences() falls back to defaults when nothing is persisted yet", () => {
		const { crawler } = createTestCrawler();
		const prefs = crawler.loadPreferences();
		expect(prefs.roots.length).toBeGreaterThan(0);
	});

	it("setPreferences() persists to disk and round-trips through loadPreferences()", () => {
		const { crawler, prefsPath } = createTestCrawler();
		crawler.setPreferences({ maxDepth: 3 });
		expect(fs.existsSync(prefsPath)).toBe(true);

		const reloaded = crawler.loadPreferences();
		expect(reloaded.maxDepth).toBe(3);
	});
});

describe("createFileIndexCrawler -- crawl lifecycle", () => {
	it("does nothing if there are no enabled roots", () => {
		const { crawler, getWorker } = createTestCrawler();
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\x", environmentId: null, enabled: false }] });
		const status = crawler.startCrawl();
		expect(status.state).toBe("idle");
		expect(getWorker()).toBeNull();
	});

	it("startCrawl() spawns a worker with the enabled roots/exclusions/caps and reports state=running", () => {
		const { crawler, getWorker } = createTestCrawler();
		crawler.setPreferences({
			roots: [
				{ id: "r1", path: "C:\\a", environmentId: null, enabled: true },
				{ id: "r2", path: "C:\\b", environmentId: null, enabled: false },
			],
			exclusions: ["node_modules"],
			maxDepth: 4,
			maxFiles: 10,
		});

		const status = crawler.startCrawl();
		expect(status.state).toBe("running");
		expect(getWorker()).not.toBeNull();
	});

	it("routes a 'batch' message into a transactional write via store.upsertFilesBatch", async () => {
		const db = await createDb();
		const { crawler, getWorker } = createTestCrawler({ getDb: () => db });
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\a", environmentId: null, enabled: true }] });
		crawler.startCrawl();

		getWorker().emit("message", {
			type: "batch",
			root: "r1",
			files: [{ path: "C:\\a\\f.txt", name: "f.txt", ext: "txt", size: 1, mtime: 1, environmentId: null, root: "r1" }],
		});

		expect(db.all("SELECT * FROM files")).toHaveLength(1);
	});

	it("'root-done' prunes stale rows for exactly that root", async () => {
		const db = await createDb();
		const { crawler, getWorker } = createTestCrawler({ getDb: () => db });
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\a", environmentId: null, enabled: true }] });

		// Seed a stale row that predates this run.
		db.run(
			"INSERT INTO files (path, name, ext, size, mtime, environment_id, root, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["C:\\a\\stale.txt", "stale.txt", "txt", 1, 1, null, "r1", 1],
		);

		crawler.startCrawl();
		const worker = getWorker();
		worker.emit("message", { type: "root-done", root: "r1" });

		expect(db.all("SELECT * FROM files WHERE path = ?", ["C:\\a\\stale.txt"])).toHaveLength(0);
	});

	it("'done' rebuilds the FTS index and marks the run completed", async () => {
		const db = await createDb();
		const { crawler, getWorker } = createTestCrawler({ getDb: () => db });
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\a", environmentId: null, enabled: true }] });
		crawler.startCrawl();

		getWorker().emit("message", {
			type: "batch",
			root: "r1",
			files: [{ path: "C:\\a\\f.txt", name: "f.txt", ext: "txt", size: 1, mtime: 1, environmentId: null, root: "r1" }],
		});
		getWorker().emit("message", { type: "done", cancelled: false, truncated: false, filesScanned: 1, dirsScanned: 1 });

		const status = crawler.getStatus();
		expect(status.state).toBe("completed");
		expect(status.filesScanned).toBe(1);

		// FTS rebuilt: the file is now actually findable.
		const ftsRows = db.all("SELECT path FROM files_fts WHERE files_fts MATCH 'f*'");
		expect(ftsRows).toHaveLength(1);
	});

	it("a worker that exits without ever sending 'done' is treated as an error, not stuck 'running' forever", () => {
		const { crawler, getWorker } = createTestCrawler();
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\a", environmentId: null, enabled: true }] });
		crawler.startCrawl();

		getWorker().emit("exit", 1);

		const status = crawler.getStatus();
		expect(status.state).toBe("error");
		expect(status.error).toMatch(/exited unexpectedly/i);
	});

	it("cancelCrawl() posts a cancel message to the worker", () => {
		const { crawler, getWorker } = createTestCrawler();
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\a", environmentId: null, enabled: true }] });
		crawler.startCrawl();
		crawler.cancelCrawl();

		expect(getWorker().posted).toContainEqual({ type: "cancel" });
	});

	it("cancelCrawl() is a no-op when nothing is running", () => {
		const { crawler } = createTestCrawler();
		const status = crawler.cancelCrawl();
		expect(status.state).toBe("idle");
	});

	it("startCrawl() is a no-op while a crawl is already running (does not spawn a second worker)", () => {
		let createCount = 0;
		const { crawler } = createTestCrawler({
			createWorker: () => {
				createCount += 1;
				return new FakeWorker();
			},
		});
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\a", environmentId: null, enabled: true }] });
		crawler.startCrawl();
		crawler.startCrawl();
		expect(createCount).toBe(1);
	});

	it("seeds throttle state from powerMonitor.isOnBatteryPower() when a crawl starts", () => {
		const { crawler, getWorker } = createTestCrawler({
			powerMonitor: { isOnBatteryPower: () => true, on: () => {}, removeListener: () => {} },
		});
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\a", environmentId: null, enabled: true }] });
		crawler.startCrawl();
		expect(getWorker().posted).toContainEqual({ type: "throttle", onBattery: true });
	});

	it("broadcasts status on every state change", () => {
		const broadcastCalls = [];
		const { crawler, getWorker } = createTestCrawler({ broadcast: (status) => broadcastCalls.push(status.state) });
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\a", environmentId: null, enabled: true }] });
		crawler.startCrawl();
		getWorker().emit("message", { type: "done", cancelled: false, truncated: false, filesScanned: 0, dirsScanned: 0 });

		expect(broadcastCalls).toContain("running");
		expect(broadcastCalls).toContain("completed");
	});
});

describe("createFileIndexCrawler -- getIndexStats integration", () => {
	it("a completed crawl's writes are visible through store.getIndexStats", async () => {
		const db = await createDb();
		const { crawler, getWorker } = createTestCrawler({ getDb: () => db });
		crawler.setPreferences({ roots: [{ id: "r1", path: "C:\\a", environmentId: null, enabled: true }] });
		crawler.startCrawl();
		getWorker().emit("message", {
			type: "batch",
			root: "r1",
			files: [{ path: "C:\\a\\f.txt", name: "f.txt", ext: "txt", size: 1, mtime: 1, environmentId: null, root: "r1" }],
		});
		getWorker().emit("message", { type: "done", cancelled: false, truncated: false, filesScanned: 1, dirsScanned: 1 });

		expect(getIndexStats(db).totalFiles).toBe(1);
	});
});
