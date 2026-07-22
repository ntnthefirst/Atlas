"use strict";

// ---------------------------------------------------------------------------
// The pattern miner -- main-thread orchestrator (WP-3.3). Mirrors
// electron/services/file-index/crawler.cjs almost exactly: owns the miner's
// persisted preferences (thresholds, see electron/config/pattern-miner-
// prefs.cjs) and the one live mining run at a time, spawns the worker thread
// (./mine-worker.cjs), turns its streamed messages into transactional writes
// (./store.cjs), and answers "run now"/status queries. Same factory shape
// too (`createPatternMiner(deps)`), for the same testability reason: every
// Electron/fs/worker touchpoint is injectable, defaulting to the real thing
// only when not supplied, so miner.test.js can drive this whole module with
// a fake in-process "worker" (a plain EventEmitter) instead of a real OS
// thread.
//
// -- Never starts a run until asked ------------------------------------------
// `runNow()` is the only thing that creates a Worker; nothing in this module
// (or main.cjs's boot sequence) calls it automatically -- exactly the crawler's
// own discipline, for exactly the same reason: an autostart here would mean
// `npm run smoke`/`smoke:windows` silently mining the real event log on every
// local run. Preferences are loaded at boot (a small JSON file read); mining
// itself only ever starts from an explicit `patternMiner:runNow` IPC call.
//
// -- Per-environment buckets, paged, one bucket in flight at a time ----------
// `performRun()` asks electron/services/event-log.cjs which environment ids
// have ever recorded an event (`listDistinctEventEnvironmentIds`, including
// the `null` "no environment" bucket), then, for EACH one in turn: pages
// through that environment's events via `listEventsForMining`'s keyset
// cursor, posting each page to the worker as an `{ type: "events",
// environmentId, events, isLast }` message, and waits for that bucket's
// `"bucket-done"` reply before moving on to the next environment id. Only one
// bucket is ever "in flight" between main and worker at a time -- see mine-
// worker.cjs's header for why that bounds this module's own peak memory to
// one bucket's pages as well (nothing here accumulates a second bucket's
// pages while waiting).
//
// -- Findings are written ONCE, after the whole run finishes -----------------
// Every bucket's findings are collected in memory (compact -- a finding is a
// handful of scalars plus its evidence pairs, not raw events) and handed to
// store.upsertFindings() in a SINGLE call after the last bucket completes, so
// the whole run's writes land in one transaction rather than one transaction
// per bucket -- consistent with this project's "all bulk writes inside
// db.transaction()" rule.
// ---------------------------------------------------------------------------

const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const { app } = require("electron");
const {
	PATTERN_MINER_PREFS_FILE,
	defaultPatternMinerPreferences,
	normalizePatternMinerPreferences,
} = require("../../config/pattern-miner-prefs.cjs");
const { listDistinctEventEnvironmentIds, listEventsForMining } = require("../event-log.cjs");
const store = require("./store.cjs");

const WORKER_PATH = path.join(__dirname, "mine-worker.cjs");
// How many events are paged per worker message -- matches event-log.cjs's own
// DEFAULT_MINING_PAGE_SIZE default; kept as its own literal here for the same
// reason crawler.cjs keeps its own BATCH_SIZE apart from crawl-worker.cjs's
// default (see that file's header): this is the orchestration/message-size
// concern, not the query helper's own default, and the two happening to
// agree today is not a coupling either side depends on.
const EVENTS_PAGE_SIZE = 5000;
// A genuinely hung worker (a bug, not normal operation) must not leave a
// mining run "running" forever with no way for the user to ever see it
// finish or retry -- an idle/scheduled background feature failing silently
// closed like this is far better than it wedging the miner's status
// permanently. 90 days of events comfortably mines in low single-digit
// seconds (see mining-performance.test.js); this is a generous multiple of
// that, not a tight budget.
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

function idleStatus() {
	return {
		state: "idle",
		startedAt: null,
		finishedAt: null,
		environmentsMined: 0,
		eventsScanned: 0,
		findingsCreated: 0,
		findingsUpdated: 0,
		error: null,
	};
}

function createPatternMiner(deps = {}) {
	const resolvePrefsPath = deps.getPrefsPath ?? (() => path.join(app.getPath("userData"), PATTERN_MINER_PREFS_FILE));
	const createWorker = deps.createWorker ?? (() => new Worker(WORKER_PATH));
	const getDb = deps.getDb ?? (() => null);
	const getEventLog = deps.getEventLog ?? (() => null);
	const runTimeoutMs = deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const setTimeoutFn = deps.setTimeout ?? setTimeout;
	const clearTimeoutFn = deps.clearTimeout ?? clearTimeout;
	// Test-only seam: a real run always pages EVENTS_PAGE_SIZE (5000) rows at a
	// time, but miner.test.js needs to prove the multi-page/"one bucket in
	// flight at a time" wiring itself works without seeding thousands of rows
	// -- overriding this to a tiny number is what makes a handful of seeded
	// events actually exercise more than one page.
	const eventsPageSize = deps.eventsPageSize ?? EVENTS_PAGE_SIZE;

	let preferences = defaultPatternMinerPreferences();
	let status = idleStatus();
	let worker = null;
	let runInFlight = null;

	function getStatus() {
		return { ...status };
	}

	function loadPreferences() {
		try {
			const raw = fs.readFileSync(resolvePrefsPath(), "utf8");
			preferences = normalizePatternMinerPreferences(JSON.parse(raw));
		} catch {
			preferences = defaultPatternMinerPreferences();
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
		preferences = normalizePatternMinerPreferences({ ...preferences, ...(patch || {}) });
		persist();
		return preferences;
	}

	function logSafely(type, options) {
		try {
			getEventLog()?.record?.(type, options);
		} catch {
			// Never let event-log recording take the run's own result down.
		}
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

	// Pages one environment bucket's events to `w` and resolves with that
	// bucket's findings (each tagged with `environmentId`) once the worker
	// reports `"bucket-done"`. Rejects on a worker-reported `"error"` or a
	// synchronous read failure. Only one of these is ever in flight at a time
	// (see this file's header).
	function mineOneBucket(w, db, environmentId, onPageRead) {
		return new Promise((resolve, reject) => {
			let afterTs = "";
			let afterId = 0;
			let settled = false;

			function onMessage(message) {
				if (!message || typeof message !== "object" || settled) {
					return;
				}
				if (message.type === "bucket-done") {
					settled = true;
					w.removeListener("message", onMessage);
					const findings = Array.isArray(message.findings) ? message.findings : [];
					resolve(findings.map((finding) => ({ ...finding, environmentId: message.environmentId ?? null })));
				} else if (message.type === "error") {
					settled = true;
					w.removeListener("message", onMessage);
					reject(new Error(message.message || "Pattern mining worker reported an error."));
				}
			}
			w.on("message", onMessage);

			function sendNextPage() {
				let page;
				try {
					page = listEventsForMining(db, environmentId, { afterTs, afterId, limit: eventsPageSize });
				} catch (error) {
					settled = true;
					w.removeListener("message", onMessage);
					reject(error);
					return;
				}
				onPageRead(page.length);
				const isLast = page.length < eventsPageSize;
				w.postMessage({ type: "events", environmentId, events: page, isLast });
				if (!isLast) {
					const last = page[page.length - 1];
					afterTs = last.ts;
					afterId = last.id;
					setImmediate(sendNextPage);
				}
			}

			sendNextPage();
		});
	}

	function waitForRunComplete(w) {
		return new Promise((resolve) => {
			function onMessage(message) {
				if (message?.type === "done") {
					w.removeListener("message", onMessage);
					resolve();
				}
			}
			w.on("message", onMessage);
			w.postMessage({ type: "run-complete" });
		});
	}

	async function performRun() {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}

		status = { ...idleStatus(), state: "running", startedAt: Date.now() };

		let environmentIds;
		try {
			environmentIds = listDistinctEventEnvironmentIds(db);
		} catch (error) {
			status = { ...status, state: "error", finishedAt: Date.now(), error: error.message || String(error) };
			return { ok: false, error: status.error };
		}

		if (environmentIds.length === 0) {
			status = { ...status, state: "completed", finishedAt: Date.now() };
			return { ok: true, ...getStatus() };
		}

		const w = createWorker();
		worker = w;

		let timedOut = false;
		const timeoutHandle = setTimeoutFn(() => {
			timedOut = true;
			cleanupWorker();
		}, runTimeoutMs);
		if (typeof timeoutHandle.unref === "function") {
			timeoutHandle.unref();
		}

		try {
			w.postMessage({ type: "config", thresholds: preferences });

			const allFindings = [];
			let eventsScanned = 0;
			let environmentsMined = 0;

			for (const environmentId of environmentIds) {
				if (timedOut) {
					throw new Error("Pattern mining run timed out.");
				}
				const findings = await mineOneBucket(w, db, environmentId, (count) => {
					eventsScanned += count;
				});
				allFindings.push(...findings);
				environmentsMined += 1;
			}

			if (!timedOut) {
				await waitForRunComplete(w);
			}

			const writeResult = store.upsertFindings(db, allFindings);

			status = {
				...idleStatus(),
				state: "completed",
				startedAt: status.startedAt,
				finishedAt: Date.now(),
				environmentsMined,
				eventsScanned,
				findingsCreated: writeResult.created,
				findingsUpdated: writeResult.updated,
			};
			logSafely("pattern_miner.run_completed", {
				payload: {
					environmentsMined,
					eventsScanned,
					findingsCreated: writeResult.created,
					findingsUpdated: writeResult.updated,
				},
			});
			return { ok: true, ...getStatus() };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			status = { ...status, state: "error", finishedAt: Date.now(), error: message };
			console.error("[Atlas] pattern-miner: run failed:", error);
			return { ok: false, error: message };
		} finally {
			clearTimeoutFn(timeoutHandle);
			cleanupWorker();
		}
	}

	// The ONE way a mining run ever starts -- see this file's header. Callers
	// that call this while a run is already in flight get the SAME promise
	// (never a second, overlapping worker/run).
	function runNow() {
		if (runInFlight) {
			return runInFlight;
		}
		runInFlight = performRun().finally(() => {
			runInFlight = null;
		});
		return runInFlight;
	}

	function shutdown() {
		cleanupWorker();
	}

	return {
		loadPreferences,
		getPreferences,
		setPreferences,
		runNow,
		getStatus,
		shutdown,
	};
}

module.exports = { createPatternMiner, DEFAULT_RUN_TIMEOUT_MS, EVENTS_PAGE_SIZE };
