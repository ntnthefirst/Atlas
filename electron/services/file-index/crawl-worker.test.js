import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { runCrawl, shouldExcludeName, toFileRecord } from "./crawl-worker.cjs";

// ---------------------------------------------------------------------------
// The filesystem walk (WP-2.5) -- runCrawl() itself is exercised directly
// (fast, deterministic, no real worker thread), against real SCRATCH temp
// directories (never anything under %APPDATA%/Atlas or Atlas-Dev). One
// integration test at the bottom spins an actual `Worker` against this exact
// file to prove the parentPort message wiring works end-to-end.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-crawl-worker-test-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function writeFile(root, relativePath, content = "x") {
	const full = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

async function collectCrawl(overrides) {
	const batches = [];
	const progressEvents = [];
	const rootsDone = [];
	const result = await runCrawl({
		roots: overrides.roots,
		exclusions: overrides.exclusions ?? [],
		maxDepth: overrides.maxDepth ?? 12,
		maxFiles: overrides.maxFiles ?? 200_000,
		batchSize: overrides.batchSize ?? 1000,
		isCancelled: overrides.isCancelled ?? (() => false),
		isThrottled: overrides.isThrottled ?? (() => false),
		onBatch: (rootId, files) => {
			batches.push({ rootId, files });
		},
		onProgress: (progress) => progressEvents.push(progress),
		onRootDone: (rootId) => rootsDone.push(rootId),
	});
	const allFiles = batches.flatMap((b) => b.files);
	return { result, batches, allFiles, progressEvents, rootsDone };
}

describe("shouldExcludeName", () => {
	it("matches case-insensitively by exact directory name", () => {
		const set = new Set(["node_modules", ".git"]);
		expect(shouldExcludeName("node_modules", set)).toBe(true);
		expect(shouldExcludeName("Node_Modules", set)).toBe(true);
		expect(shouldExcludeName(".GIT", set)).toBe(true);
		expect(shouldExcludeName("src", set)).toBe(false);
	});
});

describe("toFileRecord", () => {
	it("builds a record with a lowercased, dotless extension and the root's environmentId", () => {
		const record = toFileRecord(
			{ id: "root-1", environmentId: "env-1" },
			"C:\\a\\Report.PDF",
			"Report.PDF",
			{ size: 42, mtimeMs: 1_700_000_000_000 },
		);
		expect(record).toMatchObject({
			path: "C:\\a\\Report.PDF",
			name: "Report.PDF",
			ext: "pdf",
			size: 42,
			root: "root-1",
			environmentId: "env-1",
		});
	});

	it("uses null ext for an extensionless file", () => {
		const record = toFileRecord({ id: "root-1" }, "C:\\a\\README", "README", { size: 1, mtimeMs: 0 });
		expect(record.ext).toBeNull();
		expect(record.environmentId).toBeNull();
	});
});

describe("runCrawl", () => {
	it("finds every file under a root and reports it finished", async () => {
		const dir = makeTempDir();
		writeFile(dir, "a.txt");
		writeFile(dir, "sub/b.txt");
		writeFile(dir, "sub/deeper/c.txt");

		const { result, allFiles, rootsDone } = await collectCrawl({ roots: [{ id: "r1", path: dir }] });

		expect(result.cancelled).toBe(false);
		expect(result.truncated).toBe(false);
		expect(rootsDone).toEqual(["r1"]);
		expect(allFiles.map((f) => f.name).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
		expect(allFiles.every((f) => f.root === "r1")).toBe(true);
	});

	it("skips excluded directory names entirely, including everything beneath them", async () => {
		const dir = makeTempDir();
		writeFile(dir, "keep.txt");
		writeFile(dir, "node_modules/pkg/index.js");
		writeFile(dir, "node_modules/pkg/nested/deep.js");

		const { allFiles } = await collectCrawl({
			roots: [{ id: "r1", path: dir }],
			exclusions: ["node_modules"],
		});

		expect(allFiles.map((f) => f.name)).toEqual(["keep.txt"]);
	});

	it("does not descend past maxDepth", async () => {
		const dir = makeTempDir();
		writeFile(dir, "top.txt"); // in the root itself (depth 0)
		writeFile(dir, "a/mid.txt"); // "a" is depth 1 -- allowed when maxDepth=1
		writeFile(dir, "a/b/deep.txt"); // "b" would be depth 2 -- NOT pushed when maxDepth=1

		const { allFiles } = await collectCrawl({ roots: [{ id: "r1", path: dir }], maxDepth: 1 });

		expect(allFiles.map((f) => f.name).sort()).toEqual(["mid.txt", "top.txt"]);
	});

	it("truncates the whole crawl once the global maxFiles cap is hit, and does not report that root finished", async () => {
		const dir = makeTempDir();
		for (let i = 0; i < 10; i += 1) {
			writeFile(dir, `file-${i}.txt`);
		}

		const { result, allFiles, rootsDone } = await collectCrawl({ roots: [{ id: "r1", path: dir }], maxFiles: 3 });

		expect(result.truncated).toBe(true);
		expect(result.cancelled).toBe(false);
		expect(allFiles.length).toBeLessThanOrEqual(3);
		expect(rootsDone).toEqual([]); // never finished -- must not be pruned (see crawler.cjs)
	});

	it("stops immediately when isCancelled() is already true, reporting no root as finished", async () => {
		const dir = makeTempDir();
		writeFile(dir, "a.txt");

		const { result, rootsDone } = await collectCrawl({
			roots: [{ id: "r1", path: dir }],
			isCancelled: () => true,
		});

		expect(result.cancelled).toBe(true);
		expect(rootsDone).toEqual([]);
	});

	it("a root finished before cancellation IS reported done; a later, interrupted root is not", async () => {
		const dirA = makeTempDir();
		writeFile(dirA, "a.txt");
		const dirB = makeTempDir();
		writeFile(dirB, "b1.txt");
		writeFile(dirB, "sub/b2.txt");

		// Cancel is driven off onRootDone rather than a file count, so the
		// signal is deterministic regardless of directory iteration order:
		// root-a finishes, flips the flag, and root-b's walk (already in
		// progress or about to start) sees isCancelled() true on its very next
		// check.
		let cancelled = false;
		const batches = [];
		const rootsDoneFinal = [];
		const finalResult = await runCrawl({
			roots: [
				{ id: "root-a", path: dirA },
				{ id: "root-b", path: dirB },
			],
			exclusions: [],
			maxDepth: 12,
			maxFiles: 200_000,
			batchSize: 1000,
			isCancelled: () => cancelled,
			onBatch: (rootId, files) => batches.push({ rootId, files }),
			onProgress: () => {},
			onRootDone: (rootId) => {
				rootsDoneFinal.push(rootId);
				if (rootId === "root-a") {
					cancelled = true; // simulate a user cancel arriving right after root-a finishes
				}
			},
		});

		expect(finalResult.cancelled).toBe(true);
		expect(rootsDoneFinal).toEqual(["root-a"]);
		// root-b's files must never have been reported as its own finished batch
		expect(batches.some((b) => b.rootId === "root-b")).toBe(false);
	});

	it("never spans a batch across two roots", async () => {
		const dirA = makeTempDir();
		writeFile(dirA, "a1.txt");
		writeFile(dirA, "a2.txt");
		const dirB = makeTempDir();
		writeFile(dirB, "b1.txt");

		const { batches, allFiles } = await collectCrawl({
			roots: [
				{ id: "root-a", path: dirA },
				{ id: "root-b", path: dirB },
			],
			batchSize: 1000, // large enough that both roots' files would fit in one batch if merged
		});

		// Guards against a vacuous pass: if nothing ever got flushed at all (the
		// exact shape of a "forgot to flush at end-of-root" bug), the loop below
		// would trivially succeed over zero batches. Every file must actually
		// have arrived through some batch.
		expect(batches.length).toBeGreaterThan(0);
		expect(allFiles).toHaveLength(3);
		for (const batch of batches) {
			expect(new Set(batch.files.map((f) => f.root)).size).toBe(1);
		}
	});

	it("skips symlinked entries rather than following them", async () => {
		const dir = makeTempDir();
		writeFile(dir, "real/file.txt");
		try {
			fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link-to-real"), "junction");
		} catch {
			// Creating a junction/symlink can require elevated privileges in some
			// CI sandboxes -- if it fails, skip this assertion rather than fail
			// the whole suite on an environment limitation unrelated to the code
			// under test.
			return;
		}

		const { allFiles } = await collectCrawl({ roots: [{ id: "r1", path: dir }] });
		expect(allFiles.map((f) => f.name)).toEqual(["file.txt"]);
	});
});

// -- Real worker-thread integration test -------------------------------------
// Proves the actual `new Worker(crawl-worker.cjs)` wiring (workerData in,
// parentPort messages out, "cancel"/"throttle" control messages in) works
// end-to-end -- not just the pure runCrawl() function every test above calls
// directly.
describe("crawl-worker.cjs as a real worker thread", () => {
	it("streams batch/progress/root-done/done messages for a real directory", async () => {
		const dir = makeTempDir();
		writeFile(dir, "one.txt");
		writeFile(dir, "sub/two.txt");

		const workerPath = path.join(__dirname, "crawl-worker.cjs");
		const worker = new Worker(workerPath, {
			workerData: {
				roots: [{ id: "r1", path: dir, environmentId: null }],
				exclusions: [],
				maxDepth: 12,
				maxFiles: 1000,
				batchSize: 1000,
			},
		});

		const messages = await new Promise((resolve, reject) => {
			const collected = [];
			const timeout = setTimeout(() => {
				worker.terminate();
				reject(new Error("crawl worker did not finish in time"));
			}, 10_000);
			worker.on("message", (message) => {
				collected.push(message);
				if (message.type === "done" || message.type === "error") {
					clearTimeout(timeout);
					resolve(collected);
				}
			});
			worker.on("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
		await worker.terminate();

		const batchMessages = messages.filter((m) => m.type === "batch");
		const rootDoneMessages = messages.filter((m) => m.type === "root-done");
		const doneMessage = messages.find((m) => m.type === "done");

		const files = batchMessages.flatMap((m) => m.files);
		expect(files.map((f) => f.name).sort()).toEqual(["one.txt", "two.txt"]);
		expect(rootDoneMessages.map((m) => m.root)).toEqual(["r1"]);
		expect(doneMessage).toMatchObject({ cancelled: false, truncated: false });
	}, 15_000);
});
