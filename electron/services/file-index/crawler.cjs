"use strict";

// ---------------------------------------------------------------------------
// The file index crawler -- main-thread orchestrator (WP-2.5).
//
// Owns the crawl's persisted preferences (roots/exclusions/caps, see
// electron/config/file-index-prefs.cjs) and the one live crawl run at a time:
// spawns the worker thread (electron/services/file-index/crawl-worker.cjs),
// turns its streamed messages into transactional writes (electron/services/
// file-index/store.cjs), tracks progress, and answers cancel requests.
//
// -- Factory, not a bare singleton -------------------------------------------
// `createFileIndexCrawler(deps)` mirrors electron/services/environment-
// hotkey.cjs's `createEnvironmentHotkeyManager(deps)`: every Electron/fs
// touchpoint (`getPrefsPath`, `createWorker`, `powerMonitor`, `broadcast`) is
// injectable, defaulting to the real thing only when not supplied. That is
// what lets crawler.test.js drive this whole module -- batches arriving,
// progress, cancellation, a worker that exits without ever saying "done" --
// with a fake in-process "worker" object instead of a real OS thread, so the
// tests are fast and deterministic. main.cjs calls this once, with no
// arguments, exactly like it does for the hotkey managers.
//
// -- Never opens a worker until asked ----------------------------------------
// `startCrawl()` is the only thing that creates a Worker; nothing in this
// module (or main.cjs's boot sequence) calls it automatically. Booting the
// app only loads preferences from disk (a small JSON file) -- it never
// crawls anything on its own. This matters for `npm run smoke`/`smoke:
// windows`, which boot the real app against the real Atlas-Dev userData
// directory: an autostart crawl would mean every local smoke-test run
// silently walks the developer's actual Desktop/Documents/Downloads. A crawl
// only ever starts from an explicit `fileIndex:startCrawl` IPC call (the
// Settings surface's "Run a scan now" button).
//
// -- Message handling --------------------------------------------------------
//   "batch"      -> one transactional write via store.upsertFilesBatch().
//                    Deliberately does NOT touch `status.filesScanned` itself
//                    -- "progress" messages (emitted by the worker on its own
//                    cadence, see crawl-worker.cjs) are the single source of
//                    truth for those counters, so a batch's arrival time
//                    relative to a progress tick can never double-count or
//                    under-count.
//   "progress"   -> updates the live counters the Settings surface polls/
//                    subscribes to.
//   "root-done"  -> the ONE moment a root's stale rows get pruned
//                    (store.pruneStaleRows) -- see migration 009's header and
//                    crawl-worker.cjs's header for why this only ever fires
//                    for a root the worker fully finished walking this run.
//   "done"       -> rebuilds the FTS5 index once (store.rebuildFtsIndex) and
//                    marks the run finished (completed/cancelled/truncated).
//   "error"      -> same finish path as "done", tagged with the error instead.
//
// -- Battery-aware throttling -------------------------------------------------
// `powerMonitor.isOnBatteryPower()` seeds the worker's throttle state the
// moment it's created; the `on-battery`/`on-ac` events keep it live for the
// rest of the run via a `{ type: "throttle" }` control message (see
// crawl-worker.cjs). A powerMonitor that doesn't support these (or isn't
// wired up at all, e.g. in a test) simply means throttling never engages --
// safe, not a crash -- the crawl still completes, just without slowing down
// for battery.
// ---------------------------------------------------------------------------

const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const { app, powerMonitor, BrowserWindow } = require("electron");
const {
	FILE_INDEX_PREFS_FILE,
	defaultFileIndexPreferences,
	normalizeFileIndexPreferences,
} = require("../../config/file-index-prefs.cjs");
const store = require("./store.cjs");

const WORKER_PATH = path.join(__dirname, "crawl-worker.cjs");
// Matches crawl-worker.cjs's own DEFAULT_BATCH_SIZE -- kept as a literal
// (not a shared import) since this is the "how many rows per DB transaction"
// knob, a main-thread/store concern, while the worker's constant is a
// filesystem-walk default; the two happening to agree today is not a
// coupling either side depends on.
const BATCH_SIZE = 1000;

function idleStatus() {
	return {
		state: "idle",
		startedAt: null,
		finishedAt: null,
		filesScanned: 0,
		dirsScanned: 0,
		currentRoot: null,
		truncated: false,
		cancelled: false,
		error: null,
	};
}

function createFileIndexCrawler(deps = {}) {
	const resolvePrefsPath = deps.getPrefsPath ?? (() => path.join(app.getPath("userData"), FILE_INDEX_PREFS_FILE));
	const createWorker = deps.createWorker ?? ((workerData) => new Worker(WORKER_PATH, { workerData }));
	const getDb = deps.getDb ?? (() => null);
	const getEventLog = deps.getEventLog ?? (() => null);
	const homeDir = deps.homeDir; // undefined -> file-index-prefs.cjs falls back to os.homedir()
	const power = deps.powerMonitor ?? powerMonitor;
	const broadcast =
		deps.broadcast ??
		((payload) => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) {
					win.webContents.send("fileIndex:progress", payload);
				}
			}
		});

	let preferences = defaultFileIndexPreferences(homeDir);
	let worker = null;
	let status = idleStatus();
	let runStartedAtMs = 0;

	function getStatus() {
		return { ...status };
	}

	function updateStatus(patch) {
		status = { ...status, ...patch };
		broadcast(getStatus());
	}

	function loadPreferences() {
		try {
			const raw = fs.readFileSync(resolvePrefsPath(), "utf8");
			preferences = normalizeFileIndexPreferences(JSON.parse(raw), { homeDir });
		} catch {
			preferences = defaultFileIndexPreferences(homeDir);
		}
		return preferences;
	}

	function persist() {
		try {
			fs.writeFileSync(resolvePrefsPath(), JSON.stringify(preferences, null, 2), "utf8");
		} catch {
			// Non-blocking: preferences still apply for the rest of this session
			// even if they can't be written to disk.
		}
	}

	function getPreferences() {
		return preferences;
	}

	function setPreferences(patch) {
		preferences = normalizeFileIndexPreferences({ ...preferences, ...(patch || {}) }, { homeDir });
		persist();
		return preferences;
	}

	function isBusy() {
		return status.state === "running";
	}

	function cleanupWorker() {
		if (worker) {
			try {
				worker.removeAllListeners?.();
			} catch {
				// best-effort
			}
			try {
				worker.terminate?.();
			} catch {
				// already exited
			}
		}
		worker = null;
	}

	function finishRun({ cancelled, truncated, error = null }) {
		const db = getDb();
		if (db && !error) {
			try {
				store.rebuildFtsIndex(db);
			} catch (err) {
				console.error("[Atlas] file-index: failed to rebuild the search index:", err);
			}
		}
		try {
			getEventLog()?.record?.("file_index.crawl_completed", {
				payload: { filesScanned: status.filesScanned, cancelled, truncated, error },
			});
		} catch {
			// Never let event-log recording take the finish path down.
		}
		updateStatus({
			state: error ? "error" : cancelled ? "cancelled" : "completed",
			finishedAt: Date.now(),
			cancelled,
			truncated,
			error,
		});
		cleanupWorker();
	}

	function handleMessage(message) {
		if (!message || typeof message !== "object") {
			return;
		}

		if (message.type === "batch") {
			const db = getDb();
			if (db) {
				try {
					store.upsertFilesBatch(db, message.files, runStartedAtMs);
				} catch (error) {
					console.error("[Atlas] file-index: failed to write a crawl batch:", error);
				}
			}
			return;
		}

		if (message.type === "progress") {
			updateStatus({
				filesScanned: message.filesScanned,
				dirsScanned: message.dirsScanned,
				currentRoot: message.root,
			});
			return;
		}

		if (message.type === "root-done") {
			const db = getDb();
			if (db) {
				try {
					store.pruneStaleRows(db, message.root, runStartedAtMs);
				} catch (error) {
					console.error(`[Atlas] file-index: failed to prune stale rows for root "${message.root}":`, error);
				}
			}
			return;
		}

		if (message.type === "done") {
			updateStatus({ filesScanned: message.filesScanned, dirsScanned: message.dirsScanned });
			finishRun({ cancelled: Boolean(message.cancelled), truncated: Boolean(message.truncated) });
			return;
		}

		if (message.type === "error") {
			finishRun({ cancelled: false, truncated: false, error: message.message || "Crawl failed." });
		}
	}

	function currentOnBatteryState() {
		try {
			return Boolean(power?.isOnBatteryPower?.());
		} catch {
			return false;
		}
	}

	function applyThrottleState(onBattery) {
		try {
			worker?.postMessage?.({ type: "throttle", onBattery: Boolean(onBattery) });
		} catch {
			// worker may already have exited -- nothing to throttle
		}
	}

	function onBatteryHandler() {
		applyThrottleState(true);
	}
	function onAcHandler() {
		applyThrottleState(false);
	}

	function watchPower() {
		try {
			power?.on?.("on-battery", onBatteryHandler);
			power?.on?.("on-ac", onAcHandler);
		} catch {
			// powerMonitor unavailable (e.g. under test) -- throttling simply
			// never engages, which is safe: the crawl still runs to completion.
		}
	}

	function startCrawl() {
		if (isBusy()) {
			return getStatus();
		}
		const enabledRoots = preferences.roots.filter((root) => root.enabled);
		if (enabledRoots.length === 0) {
			return getStatus();
		}

		runStartedAtMs = Date.now();
		status = { ...idleStatus(), state: "running", startedAt: runStartedAtMs };
		broadcast(getStatus());

		worker = createWorker({
			roots: enabledRoots.map((root) => ({ id: root.id, path: root.path, environmentId: root.environmentId })),
			exclusions: preferences.exclusions,
			maxDepth: preferences.maxDepth,
			maxFiles: preferences.maxFiles,
			batchSize: BATCH_SIZE,
		});

		worker.on("message", handleMessage);
		worker.on("error", (error) => {
			console.error("[Atlas] file-index crawl worker error:", error);
			finishRun({ cancelled: false, truncated: false, error: error instanceof Error ? error.message : String(error) });
		});
		worker.on("exit", (code) => {
			if (isBusy()) {
				// Exited without ever sending "done"/"error" -- treat as a failure
				// rather than leaving getStatus() stuck reporting "running" forever.
				finishRun({
					cancelled: false,
					truncated: false,
					error: `Crawl worker exited unexpectedly (code ${code}).`,
				});
			}
		});

		applyThrottleState(currentOnBatteryState());
		return getStatus();
	}

	function cancelCrawl() {
		if (!isBusy() || !worker) {
			return getStatus();
		}
		try {
			worker.postMessage({ type: "cancel" });
		} catch {
			// worker may already be gone -- the "exit" handler above covers that
		}
		return getStatus();
	}

	function shutdown() {
		try {
			power?.removeListener?.("on-battery", onBatteryHandler);
			power?.removeListener?.("on-ac", onAcHandler);
		} catch {
			// best-effort
		}
		cleanupWorker();
	}

	watchPower();

	return {
		loadPreferences,
		getPreferences,
		setPreferences,
		startCrawl,
		cancelCrawl,
		getStatus,
		shutdown,
	};
}

module.exports = { createFileIndexCrawler };
