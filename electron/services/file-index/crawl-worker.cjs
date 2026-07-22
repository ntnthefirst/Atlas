"use strict";

// ---------------------------------------------------------------------------
// The file index crawler's filesystem walk (WP-2.5) -- runs inside a
// worker_threads Worker, never on the main thread.
//
// -- Worker-thread walk, main-thread writes -----------------------------
// This file NEVER requires db.cjs, node-sqlite3-wasm, or anything that opens
// a database connection -- required by the single-connection constraint
// (node-sqlite3-wasm has exactly one connection, owned by the main process,
// no WAL). `runCrawl()` below only ever touches the filesystem and reports
// what it found through plain callback functions; electron/services/
// file-index/crawler.cjs (the main-thread half) is what turns those callbacks
// into `parentPort.postMessage()` calls when this file is loaded as a real
// Worker (see the bottom of this file), and turns the batches it receives
// back into transactional writes via store.cjs.
//
// -- Testable without spinning a real worker thread -------------------------
// `runCrawl()`, `shouldExcludeName()`, and `toFileRecord()` are plain,
// exported, `require()`-able functions that take every dependency (the root
// list, the exclusion set, cancellation/throttle checks, and callbacks) as
// plain parameters -- crawl-worker.test.js exercises them directly, against
// real scratch temp directories, with no Worker involved at all. The only
// code that behaves differently depending on which thread it's running on is
// the block at the very bottom of this file, guarded by `!isMainThread`: it
// wires `runCrawl()` up to `workerData`/`parentPort`, and only that block
// ever runs when this file is spun up via `new Worker(__filename)`. A second,
// narrower test spins one real Worker against this exact file to prove that
// wiring itself (message shapes, cancel/throttle control messages) actually
// works end-to-end.
//
// -- Depth, exclusions, and the file-count cap -------------------------------
// Depth is relative to each root (the root itself is depth 0); a directory
// whose name matches `exclusions` (case-insensitive, exact name -- see
// file-index-prefs.cjs's header for why this is name-based, not glob/path
// based) is skipped without ever being opened, so nothing below it (however
// deep) is ever visited or counted against the depth/file caps. `maxFiles` is
// a budget for the ENTIRE crawl run (every enabled root combined, see
// crawler.cjs); crossing it stops the walk of whichever root is currently in
// progress immediately (the crawl is marked `truncated`, and that root is NOT
// reported as finished -- see this file's header on `onRootDone` below for
// why that matters for pruning).
//
// -- Symlinks are never followed -------------------------------------------
// `dirent.isSymbolicLink()` entries (files or directories) are skipped
// entirely -- Windows junctions/reparse points can otherwise turn a crawl
// into an infinite loop (a symlink pointing back at an ancestor directory),
// and a filename index has no need to walk into a location a root doesn't
// actually contain.
//
// -- Cancellation and battery throttling -------------------------------------
// `isCancelled()`/`isThrottled()` are polled between filesystem operations,
// not on a timer of their own -- the worker thread's event loop only
// processes an incoming `parentPort` message between `await` points, so
// `yieldTick()` (an unconditional `setImmediate`, plus an extra delay when
// throttled) runs after every directory specifically to give a pending
// cancel/throttle control message a chance to be processed promptly, not just
// to avoid hogging the CPU.
// ---------------------------------------------------------------------------

const fsp = require("node:fs/promises");
const path = require("node:path");
const { parentPort, workerData, isMainThread } = require("node:worker_threads");

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_FILES = 200_000;
// How often (in files scanned) a progress message is emitted WITHIN a single
// large directory -- without this, one directory containing 100k files would
// report no progress at all until it finished (see this WP's "show real
// progress" gotcha).
const PROGRESS_EVERY_FILES = 200;
// Extra per-directory delay applied only while `isThrottled()` reports true
// (on battery power, see crawler.cjs) -- deliberately small: this is a
// slow-down, not a pause, so a crawl on battery still finishes, just with a
// gentler CPU/disk duty cycle.
const THROTTLE_DELAY_MS = 40;

function shouldExcludeName(name, exclusionSet) {
	return exclusionSet.has(String(name).toLowerCase());
}

// Shared with the watcher (WP-2.6, electron/services/file-index/watcher.cjs)
// -- the single-PATH version of the exact same exclusion-name and depth
// rules walkRoot() enforces while walking a directory tree, so a filesystem
// CHANGE event for a path the crawler would never have visited in the first
// place (inside an excluded directory, or past `maxDepth`) is never written
// to the index by the watcher either -- one predicate, not two copies of the
// same policy that could quietly drift apart.
//
// `rootPath`/`fullPath` are both absolute. Every path segment between the
// root and `fullPath` (including `fullPath`'s own final segment, exactly
// like walkRoot() checking `shouldExcludeName(dirent.name, ...)` on both
// directories and files alike) is checked against `exclusionSet`; and the
// number of directories separating `fullPath` from `rootPath` must not
// exceed `maxDepth` -- mirroring walkRoot()'s own `depth + 1 <= ctx.maxDepth`
// guard on ever descending into a subdirectory in the first place.
function isPathAllowed(rootPath, fullPath, exclusionSet, maxDepth) {
	const relative = path.relative(rootPath, fullPath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		return false; // outside the root entirely, or exactly the root itself
	}
	const segments = relative.split(path.sep).filter(Boolean);
	if (segments.length === 0) {
		return false;
	}
	if (segments.some((segment) => shouldExcludeName(segment, exclusionSet))) {
		return false;
	}
	// segments.length - 1 is how many directories separate `fullPath` from
	// `rootPath` -- exactly the depth walkRoot() would have had to descend to
	// reach the directory this path lives in.
	return segments.length - 1 <= maxDepth;
}

function toFileRecord(root, fullPath, name, stat) {
	const ext = path.extname(name).slice(1).toLowerCase() || null;
	const mtimeMs = Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : 0;
	return {
		path: fullPath,
		name,
		ext,
		size: Number.isFinite(stat?.size) ? stat.size : 0,
		mtime: Math.round(mtimeMs),
		environmentId: root.environmentId ?? null,
		root: root.id,
	};
}

// Walks exactly one root to completion, cancellation, or the global
// `maxFiles` cap. Returns "completed" | "cancelled" | "truncated". Always
// flushes whatever is pending for THIS root before returning (a `finally`,
// not just the happy path) -- a batch must never span two roots, since every
// batch is tagged with a single `root` id (see `ctx.flush`).
async function walkRoot(root, ctx) {
	const stack = [{ dir: root.path, depth: 0 }];

	try {
		while (stack.length > 0) {
			if (ctx.isCancelled()) {
				return "cancelled";
			}

			const { dir, depth } = stack.pop();
			let dirHandle;
			try {
				dirHandle = await fsp.opendir(dir);
			} catch {
				continue; // unreadable (permissions, race with deletion, ...) -- skip, not fatal
			}
			ctx.counts.dirsScanned += 1;

			try {
				for await (const dirent of dirHandle) {
					if (ctx.isCancelled()) {
						return "cancelled";
					}
					if (dirent.isSymbolicLink()) {
						continue;
					}
					if (shouldExcludeName(dirent.name, ctx.exclusionSet)) {
						continue;
					}

					const fullPath = path.join(dir, dirent.name);

					if (dirent.isDirectory()) {
						if (depth + 1 <= ctx.maxDepth) {
							stack.push({ dir: fullPath, depth: depth + 1 });
						}
						continue;
					}
					if (!dirent.isFile()) {
						continue; // devices/sockets/fifos/etc. -- not a "file" this index cares about
					}
					if (ctx.counts.filesScanned >= ctx.maxFiles) {
						return "truncated";
					}

					let stat;
					try {
						stat = await fsp.stat(fullPath);
					} catch {
						continue; // race: deleted/moved between readdir and stat
					}

					ctx.pushPending(toFileRecord(root, fullPath, dirent.name, stat));
					ctx.counts.filesScanned += 1;

					if (ctx.pendingSize() >= ctx.batchSize) {
						await ctx.flush(root.id);
					}
					if (ctx.counts.filesScanned % PROGRESS_EVERY_FILES === 0) {
						ctx.onProgress({
							root: root.id,
							filesScanned: ctx.counts.filesScanned,
							dirsScanned: ctx.counts.dirsScanned,
						});
					}
				}
			} finally {
				try {
					await dirHandle.close();
				} catch {
					// already closed by the for-await loop's own completion
				}
			}

			ctx.onProgress({ root: root.id, filesScanned: ctx.counts.filesScanned, dirsScanned: ctx.counts.dirsScanned });
			await ctx.yieldTick();
		}

		return "completed";
	} finally {
		await ctx.flush(root.id);
	}
}

// The pure crawl loop -- see this file's header for the testability story.
// `roots` is `Array<{ id, path, environmentId }>` (already filtered to
// enabled roots by crawler.cjs); `exclusions` is a plain string array.
async function runCrawl({
	roots,
	exclusions,
	maxDepth = DEFAULT_MAX_DEPTH,
	maxFiles = DEFAULT_MAX_FILES,
	batchSize = DEFAULT_BATCH_SIZE,
	isCancelled = () => false,
	isThrottled = () => false,
	onBatch,
	onProgress = () => {},
	onRootDone = () => {},
}) {
	const exclusionSet = new Set((exclusions || []).map((item) => String(item).toLowerCase()));
	const counts = { filesScanned: 0, dirsScanned: 0 };
	let pending = [];

	const ctx = {
		exclusionSet,
		maxDepth,
		maxFiles,
		batchSize,
		isCancelled,
		isThrottled,
		onProgress,
		counts,
		pushPending: (record) => pending.push(record),
		pendingSize: () => pending.length,
		flush: async (rootId) => {
			if (pending.length === 0) {
				return;
			}
			const batch = pending;
			pending = [];
			await onBatch?.(rootId, batch);
		},
		yieldTick: async () => {
			await new Promise((resolve) => setImmediate(resolve));
			if (isThrottled()) {
				await new Promise((resolve) => setTimeout(resolve, THROTTLE_DELAY_MS));
			}
		},
	};

	const finishedRoots = [];
	let cancelled = false;
	let truncated = false;

	for (const root of Array.isArray(roots) ? roots : []) {
		if (isCancelled()) {
			cancelled = true;
			break;
		}

		const outcome = await walkRoot(root, ctx);

		if (outcome === "cancelled") {
			cancelled = true;
			break;
		}
		if (outcome === "truncated") {
			truncated = true;
			break;
		}
		finishedRoots.push(root.id);
		onRootDone(root.id);
	}

	return { cancelled, truncated, finishedRoots, filesScanned: counts.filesScanned, dirsScanned: counts.dirsScanned };
}

// -- Real worker-thread entry point ------------------------------------------
// Only runs when this file is loaded as an actual `new Worker(__filename)`
// (see crawler.cjs) -- `require("./crawl-worker.cjs")` from anywhere else
// (this file's own unit tests, or crawler.cjs importing `runCrawl` for
// composing a fake worker) leaves `isMainThread` true and `parentPort` null,
// so none of this block ever executes there.
if (!isMainThread && parentPort) {
	let cancelled = false;
	let throttled = false;

	parentPort.on("message", (message) => {
		if (!message || typeof message !== "object") {
			return;
		}
		if (message.type === "cancel") {
			cancelled = true;
		} else if (message.type === "throttle") {
			throttled = Boolean(message.onBattery);
		}
	});

	const { roots, exclusions, maxDepth, maxFiles, batchSize } = workerData || {};

	runCrawl({
		roots,
		exclusions,
		maxDepth,
		maxFiles,
		batchSize,
		isCancelled: () => cancelled,
		isThrottled: () => throttled,
		onBatch: async (rootId, files) => {
			parentPort.postMessage({ type: "batch", root: rootId, files });
		},
		onProgress: (progress) => {
			parentPort.postMessage({ type: "progress", ...progress });
		},
		onRootDone: (rootId) => {
			parentPort.postMessage({ type: "root-done", root: rootId });
		},
	})
		.then((result) => {
			parentPort.postMessage({ type: "done", ...result });
		})
		.catch((error) => {
			parentPort.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
		});
}

module.exports = {
	runCrawl,
	shouldExcludeName,
	isPathAllowed,
	toFileRecord,
	DEFAULT_BATCH_SIZE,
	DEFAULT_MAX_DEPTH,
	DEFAULT_MAX_FILES,
};
