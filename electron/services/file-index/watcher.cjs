"use strict";

// ---------------------------------------------------------------------------
// The file index watcher (WP-2.6) -- keeps `files`/`files_fts` (electron/
// migrations/009_file_index.cjs) current between crawls by reacting to live
// filesystem change notifications, instead of the user having to re-run
// "Run a scan now" (electron/services/file-index/crawler.cjs) to pick up
// anything that changed since the last crawl.
//
// -- fs.watch, not chokidar, not a worker thread -----------------------------
// Node's built-in `fs.watch(rootPath, { recursive: true }, ...)` is backed by
// ReadDirectoryChangesW on Windows (this project's only platform, D10) and
// natively supports watching an entire subtree through ONE handle per root
// -- no extra dependency, no per-subdirectory handle to open/track/leak.
// Unlike the crawler, this never runs in a worker thread: there is no
// blocking filesystem WALK here, just short-lived `fs.watch` callbacks and
// an occasional `fs.stat()` once a debounce window elapses -- nothing heavy
// enough to justify a second thread. Every SQLite write this module makes is
// a plain, synchronous call into electron/services/file-index/store.cjs, on
// the SAME connection everything else uses (a worker thread could never
// touch it anyway -- see that module's own header).
//
// -- Debounce/coalesce, resolve-by-stat (not by eventType) -------------------
// `fs.watch`'s own `eventType` ("rename" vs "change") is not reliable enough
// to branch logic on -- a rename fires twice (once for the old name, once
// for the new one) with no guaranteed ordering, and a storm of
// temp-file-then-rename saves (most editors) or create/delete pairs (an
// installer, `npm install`, `git checkout`) would otherwise need
// special-casing for every interleaving. Instead, every event just marks its
// resolved absolute path "dirty" in a `Map` (naturally coalescing repeat
// events for the same path into ONE entry no matter how many times it
// fired), and a single timer -- started on the FIRST event since the last
// flush, never reset by subsequent ones -- fires after `debounceMs` and
// resolves every dirty path exactly once by asking the filesystem what is
// there NOW: `fs.stat` succeeds and is a file -> upsert; throws ENOENT -> the
// path (and anything nested under it, if it was a directory) is gone. This
// is what makes create, modify, delete, AND rename all reduce to the same
// two code paths, and what keeps a continuous storm from postponing the
// flush indefinitely -- the plan's "reflected within 5 seconds" criterion is
// met by `debounceMs` alone, regardless of how long the storm itself runs.
//
// -- Excluded/out-of-depth paths are never even tracked ----------------------
// `isPathAllowed` (electron/services/file-index/crawl-worker.cjs -- shared,
// not duplicated, with the crawler's own walk) is checked at EVENT time, not
// at flush time: an event for a path inside an excluded directory (an
// `npm install` writing tens of thousands of files under an excluded
// `node_modules`) is dropped before it ever enters the dirty set, so an
// excluded subtree costs nothing beyond the one `isPathAllowed` check per
// event -- exactly like the crawler never descending into one.
//
// -- files_fts stays incremental, never rebuilt wholesale --------------------
// Every flush calls store.applyWatcherBatch (NOT store.rebuildFtsIndex,
// which is the crawler's own once-per-run wholesale rebuild) -- see that
// function's header in store.cjs for exactly how it keeps files_fts in step
// one path at a time, and how it also respects the crawler's own `maxFiles`
// cap so a watcher left running indefinitely can't grow the index past what
// the user configured.
//
// -- Opt-in, never automatic -------------------------------------------------
// Exactly like the crawler's own startCrawl(), nothing in this module (or
// main.cjs's boot sequence) ever calls start() on its own -- watching begins
// only from an explicit `fileIndex:startWatch` IPC call (the Settings
// surface's own "Start watching" button), so booting the app (and `npm run
// smoke`/`smoke:windows`) never begins watching the user's real filesystem.
//
// -- Battery-aware posture ----------------------------------------------------
// Mirrors the crawler's own powerMonitor wiring: on battery, the debounce
// window widens (fewer, larger batches -- less wake-up/CPU churn) rather
// than the watcher pausing outright, since a paused watcher would mean a
// silently stale index for however long the laptop stays unplugged.
//
// -- Graceful degradation on a watch failure ---------------------------------
// If a root's `fs.watch` throws when starting, or an already-running watch
// emits an "error" (its underlying handle torn down from outside Node), that
// ONE root's watch is torn down and, if `triggerRecrawl` was wired up
// (main.cjs points it at the crawler's own startCrawl), a fresh crawl is
// kicked off so the index heals itself rather than silently going stale
// forever.
//
// -- The periodic safety net --------------------------------------------------
// Reacting to a surfaced error is not sufficient on its own. `fs.watch`'s
// Windows backing (ReadDirectoryChangesW) has an internal buffer, and when a
// burst overflows it the OS can drop change notifications WITHOUT raising an
// error anybody in userland can observe -- the watch handle stays open and
// healthy-looking while the index quietly drifts out of step with the disk.
// There is no way to detect that from here, so the only honest remedy is not
// to depend on detecting it: while watching is active, a periodic sweep
// re-runs a full crawl on an interval regardless of whether anything looked
// wrong. The crawler is already built to make this cheap and safe to repeat --
// it upserts by path (never duplicating a row) and prunes per-root only for
// roots it actually finished (store.cjs's pruneStaleRows) -- so a redundant
// sweep costs a walk and corrects any drift, while a genuinely needed one is
// the difference between a stale index and a correct one. This is
// IMPLEMENTATION-PLAN.md's WP-2.6 criterion "watcher failure degrades to
// periodic re-crawl rather than a stale index"; the reactive path above
// handles the failures that DO announce themselves, and this handles the ones
// that don't.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { powerMonitor, BrowserWindow } = require("electron");
const { isPathAllowed, toFileRecord } = require("./crawl-worker.cjs");
const store = require("./store.cjs");

const DEFAULT_DEBOUNCE_MS = 1200;
// Wider on battery -- fewer wake-ups/flushes, not a pause (see this file's
// header). Still comfortably inside the "reflected within 5 seconds"
// criterion.
const DEFAULT_BATTERY_DEBOUNCE_MS = 4000;
// How often the safety-net sweep re-crawls while watching is active (see this
// file's header). Four hours is deliberately far longer than the debounce: the
// sweep exists to correct silent drift that has already escaped the event
// stream, not to be the primary path for staying current -- events are, and
// they land within seconds. Short enough that a drifted index self-corrects
// within one working session, long enough that the walk's cost is negligible
// amortised over that window.
const DEFAULT_SAFETY_NET_INTERVAL_MS = 4 * 60 * 60 * 1000;

function idleWatchStatus() {
	return {
		state: "stopped",
		startedAt: null,
		lastEventAt: null,
		lastFlushAt: null,
		pendingCount: 0,
		rootsWatched: 0,
		onBattery: false,
		error: null,
	};
}

function createFileIndexWatcher(deps = {}) {
	const getDb = deps.getDb ?? (() => null);
	// Deliberately shares the CRAWLER's own preferences accessor (roots,
	// exclusions, maxDepth, maxFiles) rather than loading/normalizing its own
	// copy -- see this WP's scope: the watcher must respect the exact same
	// configuration the crawler does, not a second, independently-drifting
	// one. main.cjs wires this to the crawler's own `getPreferences`.
	const getPreferences =
		deps.getPreferences ?? (() => ({ roots: [], exclusions: [], maxDepth: 12, maxFiles: 200_000 }));
	const getEventLog = deps.getEventLog ?? (() => null);
	const power = deps.powerMonitor ?? powerMonitor;
	const createWatch = deps.createWatch ?? ((dirPath, options, listener) => fs.watch(dirPath, options, listener));
	const statPath = deps.stat ?? ((target) => fsp.stat(target));
	const now = deps.now ?? (() => Date.now());
	const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const batteryDebounceMs = deps.batteryDebounceMs ?? DEFAULT_BATTERY_DEBOUNCE_MS;
	// Optional: called when a root's watch fails (see this file's header on
	// "graceful degradation"), and on the periodic safety-net sweep. main.cjs
	// wires this to the crawler's own startCrawl(); left unset in tests that
	// aren't exercising either path.
	const triggerRecrawl = deps.triggerRecrawl ?? null;
	const safetyNetIntervalMs = deps.safetyNetIntervalMs ?? DEFAULT_SAFETY_NET_INTERVAL_MS;
	// Timer seams, so a test can drive the multi-hour sweep interval directly
	// instead of waiting for it (same spirit as `now` and `createWatch` above).
	const setIntervalFn = deps.setInterval ?? setInterval;
	const clearIntervalFn = deps.clearInterval ?? clearInterval;
	const broadcast =
		deps.broadcast ??
		((payload) => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) {
					win.webContents.send("fileIndex:watchStatus", payload);
				}
			}
		});

	let handles = []; // [{ rootId, watcher }]
	let dirty = new Map(); // absolute path -> the root (id/path/environmentId) it was seen under
	let flushTimer = null;
	let safetyNetTimer = null;
	let flushing = Promise.resolve(); // the most recent (or in-flight) flush -- see waitForIdle()
	let exclusionSet = new Set();
	let maxDepth = 12;
	let maxFiles = 200_000;
	let status = idleWatchStatus();

	function getStatus() {
		return { ...status };
	}

	function updateStatus(patch) {
		status = { ...status, ...patch };
		broadcast(getStatus());
	}

	function isWatching() {
		return status.state === "watching";
	}

	function currentOnBatteryState() {
		try {
			return Boolean(power?.isOnBatteryPower?.());
		} catch {
			return false;
		}
	}

	function scheduleFlush() {
		if (flushTimer || !isWatching()) {
			return;
		}
		const delay = status.onBattery ? batteryDebounceMs : debounceMs;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flushing = flushDirty().catch((error) => {
				console.error("[Atlas] file-index watcher: flush failed:", error);
			});
		}, delay);
		if (typeof flushTimer.unref === "function") {
			flushTimer.unref();
		}
	}

	async function flushDirty() {
		if (dirty.size === 0) {
			return;
		}
		const entries = [...dirty.entries()];
		dirty.clear();
		updateStatus({ pendingCount: 0 });

		const upserts = [];
		const removals = [];

		for (const [fullPath, root] of entries) {
			try {
				const stat = await statPath(fullPath);
				if (!stat.isFile()) {
					continue; // a directory event with nothing removed -- nothing of ours to index directly
				}
				upserts.push(toFileRecord(root, fullPath, path.basename(fullPath), stat));
			} catch (error) {
				if (error && error.code === "ENOENT") {
					removals.push(fullPath);
				}
				// Any other error (EPERM/EBUSY mid-write, a race with another
				// process, ...) is dropped for this flush -- editors overwhelmingly
				// fire a follow-up event for the same path, which resolves cleanly
				// on the next one.
			}
		}

		const db = getDb();
		let result = { upserted: 0, removed: 0, skippedAtCap: 0 };
		if (db && (upserts.length > 0 || removals.length > 0)) {
			try {
				result = store.applyWatcherBatch(db, { upserts, removals, maxFiles }, now());
			} catch (error) {
				console.error("[Atlas] file-index watcher: failed to write a batch:", error);
			}
		}

		try {
			getEventLog()?.record?.("file_index.watch_batch", {
				payload: { upserted: result.upserted, removed: result.removed, skippedAtCap: result.skippedAtCap },
			});
		} catch {
			// Never let event-log recording take the flush down.
		}

		updateStatus({ lastFlushAt: now() });
	}

	function handleEvent(root, _eventType, filename) {
		if (!filename) {
			return; // nothing usable to resolve to a path (rare, platform-dependent)
		}
		const fullPath = path.join(root.path, filename.toString());
		if (!isPathAllowed(root.path, fullPath, exclusionSet, maxDepth)) {
			return; // excluded, or past the configured depth cap -- never tracked at all
		}
		dirty.set(fullPath, root);
		updateStatus({ lastEventAt: now(), pendingCount: dirty.size });
		scheduleFlush();
	}

	function onBatteryHandler() {
		updateStatus({ onBattery: true });
	}
	function onAcHandler() {
		updateStatus({ onBattery: false });
	}
	function watchPower() {
		try {
			power?.on?.("on-battery", onBatteryHandler);
			power?.on?.("on-ac", onAcHandler);
		} catch {
			// powerMonitor unavailable (e.g. under test) -- the debounce window
			// simply never widens, which is safe: the watcher still works.
		}
	}
	function unwatchPower() {
		try {
			power?.removeListener?.("on-battery", onBatteryHandler);
			power?.removeListener?.("on-ac", onAcHandler);
		} catch {
			// best-effort
		}
	}

	// One tick of the periodic safety net (see this file's header for why a
	// reactive-only fallback isn't enough). Returns whether it actually kicked
	// off a crawl, purely so a test can assert the skip paths rather than
	// having to infer them.
	function runSafetyNetSweep() {
		if (!isWatching() || !triggerRecrawl) {
			return false;
		}
		// Skip while unplugged rather than pausing the whole net: a full walk is
		// the single most expensive thing this package does, and the sweep is a
		// correction for drift that may not even have happened. Events keep
		// flowing on battery (the debounce merely widens), so skipping a tick
		// costs at most one interval of drift-correction, and the next tick on
		// AC power picks it up.
		if (currentOnBatteryState()) {
			return false;
		}
		try {
			triggerRecrawl();
			getEventLog()?.record?.("file_index.watch_safety_net", {});
			return true;
		} catch (error) {
			console.error("[Atlas] file-index watcher: periodic safety-net re-crawl failed to start:", error);
			return false;
		}
	}

	function startSafetyNet() {
		if (safetyNetTimer || !triggerRecrawl || !(safetyNetIntervalMs > 0)) {
			return;
		}
		safetyNetTimer = setIntervalFn(runSafetyNetSweep, safetyNetIntervalMs);
		// Never let the sweep timer be the reason the process stays alive --
		// stop()/shutdown() clear it on quit, but unref means even a missed
		// teardown can't hold the event loop open.
		safetyNetTimer?.unref?.();
	}

	function stopSafetyNet() {
		if (safetyNetTimer) {
			clearIntervalFn(safetyNetTimer);
			safetyNetTimer = null;
		}
	}

	function stopRoot(rootId, reason) {
		const index = handles.findIndex((entry) => entry.rootId === rootId);
		if (index === -1) {
			return;
		}
		const [entry] = handles.splice(index, 1);
		try {
			entry.watcher.close?.();
		} catch {
			// already closed
		}
		console.error(`[Atlas] file-index watcher: stopped watching root "${rootId}" (${reason}).`);
		if (handles.length === 0) {
			updateStatus({ state: "error", error: `No roots could be watched (${reason}).`, rootsWatched: 0 });
		} else {
			updateStatus({ rootsWatched: handles.length });
		}
		if (triggerRecrawl) {
			try {
				triggerRecrawl();
			} catch (error) {
				console.error("[Atlas] file-index watcher: fallback re-crawl failed to start:", error);
			}
		}
	}

	function start() {
		if (isWatching()) {
			return getStatus();
		}

		const preferences = getPreferences();
		const enabledRoots = (preferences.roots || []).filter((root) => root.enabled);
		if (enabledRoots.length === 0) {
			status = { ...idleWatchStatus(), state: "error", error: "No enabled roots to watch." };
			broadcast(getStatus());
			return getStatus();
		}

		exclusionSet = new Set((preferences.exclusions || []).map((item) => String(item).toLowerCase()));
		maxDepth = preferences.maxDepth;
		maxFiles = preferences.maxFiles;
		dirty.clear();
		handles = [];

		for (const root of enabledRoots) {
			try {
				const watcher = createWatch(root.path, { recursive: true }, (eventType, filename) =>
					handleEvent(root, eventType, filename),
				);
				watcher.on?.("error", (error) => {
					stopRoot(root.id, error instanceof Error ? error.message : String(error));
				});
				handles.push({ rootId: root.id, watcher });
			} catch (error) {
				console.error(`[Atlas] file-index watcher: could not watch root "${root.id}" (${root.path}):`, error);
			}
		}

		if (handles.length === 0) {
			status = { ...idleWatchStatus(), state: "error", error: "None of the enabled roots could be watched." };
			broadcast(getStatus());
			return getStatus();
		}

		status = {
			...idleWatchStatus(),
			state: "watching",
			startedAt: now(),
			rootsWatched: handles.length,
			onBattery: currentOnBatteryState(),
		};
		watchPower();
		startSafetyNet();
		try {
			getEventLog()?.record?.("file_index.watch_started", { payload: { rootsWatched: handles.length } });
		} catch {
			// non-fatal
		}
		broadcast(getStatus());
		return getStatus();
	}

	function stop() {
		for (const { watcher } of handles) {
			try {
				watcher.close?.();
			} catch {
				// already closed
			}
		}
		handles = [];
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		stopSafetyNet();
		dirty.clear();
		unwatchPower();
		const wasWatching = isWatching();
		status = idleWatchStatus();
		if (wasWatching) {
			try {
				getEventLog()?.record?.("file_index.watch_stopped", {});
			} catch {
				// non-fatal
			}
		}
		broadcast(getStatus());
		return getStatus();
	}

	// Releases every OS watch handle and clears the pending timer -- called
	// both by stop() and (via shutdown()) on app quit, so nothing keeps the
	// process alive after `before-quit` (see main.cjs).
	function shutdown() {
		stop();
	}

	return {
		start,
		stop,
		shutdown,
		getStatus,
		isWatching,
		// Test/inspection seam (mirrors EventLog.pendingCount()'s own comment) --
		// lets a test `await` the debounced flush a fake timer just triggered,
		// instead of racing a real setTimeout.
		waitForIdle: () => flushing,
	};
}

module.exports = { createFileIndexWatcher };
