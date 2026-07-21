const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, Notification } = require("electron");
const {
	FOCUS_PREFS_FILE,
	FOCUS_NUDGE_KINDS,
	defaultFocusConfig,
	NUDGE_COPY,
	todayKey,
	normalizeFocusConfig,
	normalizeFocusStats,
} = require("../config/focus-prefs.cjs");

// ---------------------------------------------------------------------------
// Focus mode (Pomodoro) + wellbeing nudges engine.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. This is the
// single source of truth shared by every window. Config + daily stats are
// persisted; the live `runtime` is intentionally not (a focus cycle doesn't
// survive an app restart). A 1s interval advances phases and fires the
// recurring nudges as native notifications, broadcasting state to all windows
// only when something actually changes (renderers tick their own
// countdowns). Mirrors src/types.ts FocusState.
//
// This module owns `focusState`, `nudgeLastFired`, and `focusTimer` itself
// now instead of main.cjs holding them as `let`s -- there's nothing to thread
// through from main.cjs's scope, so (like services/updater.cjs) this needs no
// deps object. `app` (for the userData path), `Notification`, and
// `BrowserWindow` (for broadcastFocusState's `getAllWindows()`) are all
// stateless Electron APIs, safe to require directly.
//
// electron/ipc/focus.cjs still receives its handler implementations through
// main.cjs's wireIpc(), same as every other ipc/*.cjs module -- only the
// *source* of those functions changed, from main.cjs's own local declarations
// to this module's exports. `getFocusState` stays a getter (never a raw
// `focusState` value) for exactly the reason it was one before: `focusState`
// is reassigned wholesale by `loadFocusPreferences()` and mutated in place by
// `advanceFocusPhase()` and friends, so a value snapshot would go stale the
// instant either runs.
// ---------------------------------------------------------------------------

let focusState = {
	config: { ...defaultFocusConfig, nudges: defaultFocusConfig.nudges.map((nudge) => ({ ...nudge })) },
	runtime: null,
	stats: { day: todayKey(), focusRoundsCompleted: 0, focusMsCompleted: 0 },
};
// Per-nudge timestamp (epoch ms) of the last time it fired, kept in memory so
// nudges pace from when they were enabled / the engine started, never persisted.
let nudgeLastFired = {};
let focusTimer = null;

function getFocusState() {
	return focusState;
}

// Reset the daily counters in place if the calendar day has rolled over.
function rollFocusStatsIfNeeded() {
	const today = todayKey();
	if (focusState.stats.day !== today) {
		focusState.stats = { day: today, focusRoundsCompleted: 0, focusMsCompleted: 0 };
	}
}

function loadFocusPreferences() {
	try {
		const raw = fs.readFileSync(path.join(app.getPath("userData"), FOCUS_PREFS_FILE), "utf8");
		const parsed = JSON.parse(raw);
		focusState = {
			config: normalizeFocusConfig(parsed.config),
			runtime: null,
			stats: normalizeFocusStats(parsed.stats),
		};
	} catch {
		focusState = {
			config: normalizeFocusConfig(null),
			runtime: null,
			stats: normalizeFocusStats(null),
		};
	}
	rollFocusStatsIfNeeded();
	return focusState;
}

function persistFocusPreferences() {
	try {
		fs.writeFileSync(
			path.join(app.getPath("userData"), FOCUS_PREFS_FILE),
			JSON.stringify({ config: focusState.config, stats: focusState.stats }, null, 2),
			"utf8",
		);
	} catch {
		// Non-blocking: focus still works from in-memory state this session.
	}
}

function broadcastFocusState() {
	for (const browserWindow of BrowserWindow.getAllWindows()) {
		if (!browserWindow.isDestroyed()) {
			browserWindow.webContents.send("focus:state-changed", focusState);
		}
	}
}

function phaseDurationMs(phase) {
	const config = focusState.config;
	if (phase === "shortBreak") return config.shortBreakMinutes * 60000;
	if (phase === "longBreak") return config.longBreakMinutes * 60000;
	return config.focusMinutes * 60000;
}

function notify(title, body) {
	try {
		if (Notification.isSupported()) {
			new Notification({ title, body, silent: false }).show();
		}
	} catch {
		// Notifications are best-effort; never let one crash the engine.
	}
}

// Build a runtime for a phase, honoring whether it should auto-start or wait
// paused for a manual start.
function makePhaseRuntime(phase, roundIndex, goal, startedAt, autoStart) {
	const duration = phaseDurationMs(phase);
	const now = Date.now();
	return {
		phase,
		roundIndex,
		phaseDurationMs: duration,
		phaseEndsAt: now + duration,
		isPaused: !autoStart,
		remainingMs: duration,
		goal: goal || "",
		startedAt: startedAt || now,
	};
}

// Advance to the next phase when the current one elapses (or is skipped).
function advanceFocusPhase(skipped) {
	const runtime = focusState.runtime;
	if (!runtime) return;
	const config = focusState.config;
	const goal = runtime.goal;
	const startedAt = runtime.startedAt;

	if (runtime.phase === "focus") {
		// Credit the completed focus round (a skip still ended the work block).
		rollFocusStatsIfNeeded();
		focusState.stats.focusRoundsCompleted += 1;
		focusState.stats.focusMsCompleted += runtime.phaseDurationMs;
		const completedRounds = runtime.roundIndex + 1;
		const longBreakDue = completedRounds % config.roundsBeforeLongBreak === 0;
		const nextPhase = longBreakDue ? "longBreak" : "shortBreak";
		focusState.runtime = makePhaseRuntime(nextPhase, runtime.roundIndex, goal, startedAt, config.autoStartBreaks);
		if (!skipped) {
			notify(
				longBreakDue ? "Long break time" : "Break time",
				`Focus round done. ${longBreakDue ? config.longBreakMinutes : config.shortBreakMinutes} min break.`,
			);
		}
	} else {
		// A break finished → next focus round. After a long break the cycle resets.
		const wasLong = runtime.phase === "longBreak";
		const nextRoundIndex = wasLong ? 0 : runtime.roundIndex + 1;
		focusState.runtime = makePhaseRuntime("focus", nextRoundIndex, goal, startedAt, config.autoStartFocus);
		if (!skipped) {
			notify("Back to focus", goal ? `Next up: ${goal}` : "Break over — back to it.");
		}
	}
	persistFocusPreferences();
	broadcastFocusState();
}

function maybeFireNudges(now) {
	const config = focusState.config;
	const runtime = focusState.runtime;
	const active = config.nudgesOnlyDuringFocus
		? Boolean(runtime && runtime.phase === "focus" && !runtime.isPaused)
		: true;
	if (!active) return;
	for (const nudge of config.nudges) {
		if (!nudge.enabled) continue;
		const last = nudgeLastFired[nudge.kind] || 0;
		if (now - last >= nudge.everyMinutes * 60000) {
			nudgeLastFired[nudge.kind] = now;
			const copy = NUDGE_COPY[nudge.kind];
			if (copy) notify(copy.title, copy.body);
		}
	}
}

// Single 1s heartbeat: advances an elapsed phase and paces the nudges. Kept
// running for the app's lifetime — cheap, and nudges fire without a focus cycle.
function startFocusEngine() {
	if (focusTimer) return;
	// Pace nudges from "now" so enabling one never fires it instantly.
	const now = Date.now();
	for (const kind of FOCUS_NUDGE_KINDS) nudgeLastFired[kind] = now;
	focusTimer = setInterval(() => {
		const tickNow = Date.now();
		const runtime = focusState.runtime;
		if (runtime && !runtime.isPaused && tickNow >= runtime.phaseEndsAt) {
			advanceFocusPhase(false);
		}
		maybeFireNudges(tickNow);
	}, 1000);
	if (typeof focusTimer.unref === "function") focusTimer.unref();
}

function startFocus(goal) {
	rollFocusStatsIfNeeded();
	if (focusState.runtime) {
		// Already mid-cycle: just (re)start the clock and clear any pause.
		const runtime = focusState.runtime;
		runtime.isPaused = false;
		runtime.phaseEndsAt = Date.now() + runtime.remainingMs;
		if (typeof goal === "string") runtime.goal = goal;
	} else {
		focusState.runtime = makePhaseRuntime("focus", 0, typeof goal === "string" ? goal : "", Date.now(), true);
	}
	broadcastFocusState();
	return focusState;
}

function pauseFocus() {
	const runtime = focusState.runtime;
	if (runtime && !runtime.isPaused) {
		runtime.remainingMs = Math.max(0, runtime.phaseEndsAt - Date.now());
		runtime.isPaused = true;
		broadcastFocusState();
	}
	return focusState;
}

function resumeFocus() {
	const runtime = focusState.runtime;
	if (runtime && runtime.isPaused) {
		runtime.isPaused = false;
		runtime.phaseEndsAt = Date.now() + runtime.remainingMs;
		broadcastFocusState();
	}
	return focusState;
}

function stopFocus() {
	focusState.runtime = null;
	broadcastFocusState();
	return focusState;
}

function setFocusGoal(goal) {
	if (focusState.runtime) {
		focusState.runtime.goal = typeof goal === "string" ? goal : "";
		broadcastFocusState();
	}
	return focusState;
}

function updateFocusConfig(patch) {
	focusState.config = normalizeFocusConfig({ ...focusState.config, ...(patch || {}) });
	persistFocusPreferences();
	broadcastFocusState();
	return focusState;
}

module.exports = {
	getFocusState,
	rollFocusStatsIfNeeded,
	loadFocusPreferences,
	startFocusEngine,
	startFocus,
	pauseFocus,
	resumeFocus,
	advanceFocusPhase,
	stopFocus,
	setFocusGoal,
	updateFocusConfig,
};
