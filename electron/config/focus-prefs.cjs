// ---------------------------------------------------------------------------
// Focus mode (Pomodoro) configuration schema, defaults and normalization.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. This is the pure
// half of the focus engine: schema, defaults, clamping and the day key. The
// stateful half — the live runtime, the 1s interval, nudge pacing and the
// broadcast to every window — stays in main.cjs, since it owns the timers and
// the window list.
//
// Mirrors the FocusState shape in src/types.ts.
// ---------------------------------------------------------------------------

const FOCUS_PREFS_FILE = "focus-preferences.json";
const FOCUS_NUDGE_KINDS = ["stand", "eyes", "hydrate", "posture"];
const defaultFocusConfig = {
	focusMinutes: 25,
	shortBreakMinutes: 5,
	longBreakMinutes: 15,
	roundsBeforeLongBreak: 4,
	autoStartBreaks: true,
	autoStartFocus: false,
	nudgesOnlyDuringFocus: true,
	nudges: [
		{ kind: "stand", enabled: false, everyMinutes: 50 },
		{ kind: "eyes", enabled: false, everyMinutes: 20 },
		{ kind: "hydrate", enabled: false, everyMinutes: 90 },
		{ kind: "posture", enabled: false, everyMinutes: 40 },
	],
};
const NUDGE_COPY = {
	stand: { title: "Stand up & stretch", body: "You've been sitting a while — take a quick stretch." },
	eyes: { title: "Rest your eyes", body: "Look ~20 ft away for 20 seconds (20-20-20)." },
	hydrate: { title: "Hydrate", body: "Time for a sip of water." },
	posture: { title: "Check your posture", body: "Sit back, shoulders down, screen at eye level." },
};

function todayKey(date = new Date()) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

const clampFocusInt = (value, min, max, fallback) => {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(Math.max(Math.round(number), min), max);
};

function normalizeFocusConfig(raw) {
	const source = raw && typeof raw === "object" ? raw : {};
	const byKind = new Map();
	if (Array.isArray(source.nudges)) {
		for (const entry of source.nudges) {
			if (entry && typeof entry === "object" && FOCUS_NUDGE_KINDS.includes(entry.kind)) {
				byKind.set(entry.kind, entry);
			}
		}
	}
	return {
		focusMinutes: clampFocusInt(source.focusMinutes, 1, 180, defaultFocusConfig.focusMinutes),
		shortBreakMinutes: clampFocusInt(source.shortBreakMinutes, 1, 60, defaultFocusConfig.shortBreakMinutes),
		longBreakMinutes: clampFocusInt(source.longBreakMinutes, 1, 120, defaultFocusConfig.longBreakMinutes),
		roundsBeforeLongBreak: clampFocusInt(
			source.roundsBeforeLongBreak,
			1,
			12,
			defaultFocusConfig.roundsBeforeLongBreak,
		),
		autoStartBreaks:
			typeof source.autoStartBreaks === "boolean" ? source.autoStartBreaks : defaultFocusConfig.autoStartBreaks,
		autoStartFocus:
			typeof source.autoStartFocus === "boolean" ? source.autoStartFocus : defaultFocusConfig.autoStartFocus,
		nudgesOnlyDuringFocus:
			typeof source.nudgesOnlyDuringFocus === "boolean"
				? source.nudgesOnlyDuringFocus
				: defaultFocusConfig.nudgesOnlyDuringFocus,
		nudges: defaultFocusConfig.nudges.map((fallback) => {
			const found = byKind.get(fallback.kind);
			return {
				kind: fallback.kind,
				enabled: found && typeof found.enabled === "boolean" ? found.enabled : fallback.enabled,
				everyMinutes: clampFocusInt(found ? found.everyMinutes : undefined, 1, 360, fallback.everyMinutes),
			};
		}),
	};
}

function normalizeFocusStats(raw) {
	const source = raw && typeof raw === "object" ? raw : {};
	const day = typeof source.day === "string" && source.day ? source.day : todayKey();
	return {
		day,
		focusRoundsCompleted: clampFocusInt(source.focusRoundsCompleted, 0, 100000, 0),
		focusMsCompleted: Math.max(0, Number(source.focusMsCompleted) || 0),
	};
}

module.exports = {
	FOCUS_PREFS_FILE,
	FOCUS_NUDGE_KINDS,
	defaultFocusConfig,
	NUDGE_COPY,
	todayKey,
	clampFocusInt,
	normalizeFocusConfig,
	normalizeFocusStats,
};
