// ---------------------------------------------------------------------------
// Work-context adaptation (WP-2.8) -- the STATEFUL half.
//
// Owns the clock, the polling, the pin, the event log and the mapping from a
// detected context to a Notch layout. All of the actual decision-making lives
// in electron/services/context-detection.cjs, which is pure; this module is
// deliberately thin around it, the same split crawler.cjs/store.cjs and
// ranking.cjs/index.cjs already use.
//
// -- Where the foreground signal comes from, and what it costs -----------------
// Reading the foreground window on Windows means spawning powershell.exe
// (electron/platform/win32.cjs owns that script -- it is the only file
// permitted to). That is far too expensive to run on a tight loop for the
// lifetime of the app, and it shows up in Task Manager when you do.
//
// So the primary source is not a poll at all: electron/activity-tracker.cjs
// ALREADY reads the foreground window every 1500ms while a session is
// running, and main.cjs feeds each of those readings straight into observe().
// During a session -- exactly when knowing the user's context matters most --
// context detection therefore costs nothing beyond what Atlas already spent.
//
// start() adds an independent poll for the rest of the time, at a much slower
// interval (see DEFAULT_POLL_INTERVAL_MS), and observe() is safe to call from
// both: the detector is a pure reducer over observations, so a duplicate
// reading is at worst a no-op tick, never a double count. Like the file
// index's crawler and watcher, it is opt-in -- nothing here starts on its
// own at boot, so `npm run smoke` never spawns a PowerShell probe.
//
// -- Privacy: what is deliberately NOT recorded --------------------------------
// The platform adapter returns a window TITLE alongside the process name, and
// a window title is some of the most sensitive text on a machine: the
// document you have open, the URL you are reading, the subject line of the
// message on screen, the name of the person you are talking to. None of it is
// needed to answer "is this person coding or in a meeting", so none of it is
// taken: observe() accepts a process name only, and the event log records the
// DERIVED CONTEXT (`coding`) and never the app that produced it. An event log
// is durable, environment-scoped and read back by other features -- it is the
// last place raw window titles should end up as a side effect of a layout
// feature.
//
// -- Mapping a context to a layout ---------------------------------------------
// No new table and no migration: WP-1.3's `notch_layouts` is already a
// keyed collection, so a context layout is just a row under a well-known id
// (`context:coding`). If the row exists, that layout applies while the
// context holds; if it does not, resolveLayoutId() returns null and the
// environment's own layout continues to apply untouched. That means the
// feature degrades to exactly the pre-WP-2.8 behaviour for anyone who has
// not set a context layout up, which is the right default for something that
// moves the UI around.
// ---------------------------------------------------------------------------
"use strict";

const {
	CONTEXTS,
	DEFAULT_CANDIDATE_GAP_MS,
	DEFAULT_DWELL_MS,
	classifyProcessName,
	createInitialContextState,
	nextContextState,
} = require("./context-detection.cjs");

// Slow on purpose. This is the fallback source used only outside a tracked
// session; the activity tracker's own 1500ms readings cover the session case
// for free. Four seconds is frequent enough that a 45-second dwell still
// resolves promptly (roughly eleven observations) and rare enough that the
// PowerShell spawn is not something a user would ever notice.
const DEFAULT_POLL_INTERVAL_MS = 4000;
// On battery, back off hard -- same posture as the crawler and the watcher.
// A layout that adapts a little later is a fair trade for not waking the CPU
// every four seconds on an unplugged laptop.
const DEFAULT_BATTERY_POLL_INTERVAL_MS = 15_000;

const CONTEXT_LAYOUT_ID_PREFIX = "context:";

function contextLayoutId(context) {
	return `${CONTEXT_LAYOUT_ID_PREFIX}${context}`;
}

function isValidContext(value) {
	return typeof value === "string" && CONTEXTS.includes(value);
}

function createContextService(deps = {}) {
	const getDb = deps.getDb ?? (() => null);
	const getEventLog = deps.getEventLog ?? (() => null);
	const getActiveEnvironmentId = deps.getActiveEnvironmentId ?? (() => null);
	const platform = deps.platform ?? require("../platform/index.cjs");
	const power = deps.powerMonitor ?? null;
	const now = deps.now ?? (() => Date.now());
	// Timer seams, so a 45-second dwell and a 4-second poll are both testable
	// without waiting (mirrors file-index/watcher.cjs's own safety-net seams).
	const setIntervalFn = deps.setInterval ?? setInterval;
	const clearIntervalFn = deps.clearInterval ?? clearInterval;
	const broadcast = deps.broadcast ?? (() => {});
	const detectionOptions = {
		dwellMs: deps.dwellMs ?? DEFAULT_DWELL_MS,
		candidateGapMs: deps.candidateGapMs ?? DEFAULT_CANDIDATE_GAP_MS,
	};
	const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const batteryPollIntervalMs = deps.batteryPollIntervalMs ?? DEFAULT_BATTERY_POLL_INTERVAL_MS;

	let state = createInitialContextState(now());
	let pinnedContext = null;
	let pollTimer = null;
	let polling = Promise.resolve();

	// The context the rest of the app should act on. A pin overrides detection
	// ENTIRELY (the plan's wording): detection keeps running underneath so that
	// unpinning produces a current answer rather than a stale one, but while a
	// pin is set nothing it concludes reaches the layout or the event log.
	function getEffectiveContext() {
		return pinnedContext ?? state.context;
	}

	function getStatus() {
		return {
			context: state.context,
			effectiveContext: getEffectiveContext(),
			pinnedContext,
			isPinned: pinnedContext !== null,
			candidate: state.candidate,
			changedAt: state.changedAt,
			polling: pollTimer !== null,
		};
	}

	// The layout a context maps to, or null when the user has not configured
	// one -- in which case the environment's own layout keeps applying and this
	// feature is invisible. Never throws: a layout lookup failing must not take
	// down a polling path.
	function resolveLayoutId(context = getEffectiveContext()) {
		if (!isValidContext(context)) {
			return null;
		}
		const db = getDb();
		if (!db) {
			return null;
		}
		try {
			const layoutId = contextLayoutId(context);
			return db.getNotchLayoutRow(layoutId) ? layoutId : null;
		} catch (error) {
			console.error("[Atlas] context: failed to resolve a context layout:", error);
			return null;
		}
	}

	// Records the DERIVED context only -- never the process name or window
	// title that produced it (see this file's header on privacy).
	function recordContextChange(from, to) {
		try {
			getEventLog()?.record?.("context.changed", {
				environmentId: getActiveEnvironmentId(),
				subject: to,
				payload: { from, to },
			});
		} catch {
			// A broken event log must never break context detection.
		}
	}

	function emitChange(from) {
		const status = getStatus();
		recordContextChange(from, state.context);
		try {
			broadcast({ ...status, layoutId: resolveLayoutId() });
		} catch (error) {
			console.error("[Atlas] context: failed to broadcast a context change:", error);
		}
	}

	// The single entry point for a foreground reading, whatever its source
	// (the activity tracker's own tick, or this module's poll). Takes a
	// PROCESS NAME, deliberately not the window info object -- there is no
	// path by which a window title can reach this module's state.
	function observe(processName, at = now()) {
		const previousContext = state.context;
		state = nextContextState(state, { context: classifyProcessName(processName), at }, detectionOptions);
		if (!state.changed) {
			return getStatus();
		}
		// A pin overrides detection entirely: keep the detector's own state
		// current, but do not let it move the layout or write an event.
		if (pinnedContext === null) {
			emitChange(previousContext);
		}
		return getStatus();
	}

	async function pollOnce() {
		try {
			const info = await platform.getForegroundWindow();
			// D10: on an unsupported platform the adapter says so rather than
			// inventing an app name; there is no signal to feed the detector.
			if (!info?.supported) {
				return;
			}
			observe(info.processName);
		} catch (error) {
			console.error("[Atlas] context: foreground probe failed:", error);
		}
	}

	function currentPollIntervalMs() {
		try {
			return power?.isOnBatteryPower?.() ? batteryPollIntervalMs : pollIntervalMs;
		} catch {
			return pollIntervalMs;
		}
	}

	function start() {
		if (pollTimer) {
			return getStatus();
		}
		pollTimer = setIntervalFn(() => {
			polling = pollOnce();
		}, currentPollIntervalMs());
		// Never the reason the app can't quit.
		pollTimer?.unref?.();
		broadcast(getStatus());
		return getStatus();
	}

	function stop() {
		if (pollTimer) {
			clearIntervalFn(pollTimer);
			pollTimer = null;
		}
		broadcast(getStatus());
		return getStatus();
	}

	// Pinning is the user saying "stop guessing". It takes effect immediately
	// and survives any amount of subsequent detection.
	function pin(context) {
		if (!isValidContext(context)) {
			return getStatus();
		}
		pinnedContext = context;
		const status = getStatus();
		try {
			getEventLog()?.record?.("context.pinned", {
				environmentId: getActiveEnvironmentId(),
				subject: context,
			});
		} catch {
			// non-fatal
		}
		broadcast({ ...status, layoutId: resolveLayoutId() });
		return status;
	}

	function unpin() {
		if (pinnedContext === null) {
			return getStatus();
		}
		pinnedContext = null;
		const status = getStatus();
		try {
			getEventLog()?.record?.("context.unpinned", { environmentId: getActiveEnvironmentId() });
		} catch {
			// non-fatal
		}
		broadcast({ ...status, layoutId: resolveLayoutId() });
		return status;
	}

	function shutdown() {
		stop();
	}

	return {
		observe,
		start,
		stop,
		shutdown,
		pin,
		unpin,
		getStatus,
		getEffectiveContext,
		resolveLayoutId,
		// Test seam: await the most recent poll instead of racing it.
		waitForIdle: () => polling,
	};
}

module.exports = {
	CONTEXT_LAYOUT_ID_PREFIX,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_BATTERY_POLL_INTERVAL_MS,
	contextLayoutId,
	createContextService,
};
