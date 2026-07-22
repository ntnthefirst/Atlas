// ---------------------------------------------------------------------------
// Work-context detection (WP-2.8) -- the PURE half.
//
// Turns a stream of "which app is in the foreground right now" observations
// into a stable answer to "what is the user doing": coding, communication, or
// browsing. No I/O, no timers, no database -- a function from (previous
// state, one observation, clock reading) to the next state, exactly the shape
// electron/services/launcher-providers/ranking.cjs and file-index/
// file-ranking.cjs already established, and for the same reason: the rule
// that actually matters here is a time-based hysteresis rule, and a
// hysteresis rule you can only exercise by waiting tens of seconds in real
// time is a rule that will not get tested properly. Every clock reading is
// passed in; electron/services/context-service.cjs owns the polling, the
// database and the event log.
//
// -- Why hysteresis is the whole point ---------------------------------------
// IMPLEMENTATION-PLAN.md's WP-2.8 is emphatic, and it is a product
// requirement rather than a performance note: "a Notch that reshuffles while
// you are looking at it is worse than a static one". A detector that is
// merely ACCURATE is not good enough -- alt-tabbing to Slack for four seconds
// to read one message is not "the user switched to communication", and a
// layout that rearranges itself on that is actively worse than one that never
// moves. So a candidate context has to hold the foreground CONTINUOUSLY for
// `dwellMs` before it is allowed to take over, and anything short of that
// leaves the committed context exactly where it was.
//
// -- The three kinds of observation -------------------------------------------
// Not every foreground app maps to a context, and the difference between "no
// signal" and "a signal for something else" is what makes the difference
// between a detector that holds still and one that thrashes:
//
//   * A KNOWN context (VS Code -> coding). Evidence, either for the committed
//     context or for a challenger.
//   * An UNCLASSIFIED app (File Explorer, Notepad, some in-house tool). This
//     is NOT evidence against the current context -- opening Explorer to drag
//     a file into your editor does not mean you stopped coding. It neither
//     advances a challenger's dwell nor resets it; the state is returned
//     untouched. Treating it as evidence against would make every file dialog
//     a context change.
//   * An IGNORED process (see the shell list in electron/platform/win32.cjs).
//     Same handling as unclassified, and deliberately so: the ignore list
//     exists because those process names are shells rather than the work
//     itself, and Atlas's own foreground-window probe is a PowerShell call.
//     Letting the tool that MEASURES the foreground app count as a signal
//     about it would be self-observation. classifyProcessName() returns null
//     for these, so they take the unclassified path above.
//
// -- The gap rule, and the loophole it closes ----------------------------------
// "Held the foreground continuously for dwellMs" cannot be implemented as
// `now - candidateSince >= dwellMs` alone. Consider: a candidate starts at
// t=0 (one glance at Slack), the user then spends five minutes in an
// unclassified app, and at t=300s Slack is seen once more. Elapsed wall-clock
// beats any sane dwell, so the context would flip on what is really two
// isolated glances -- precisely the flapping this is meant to prevent. So the
// candidate also carries `candidateLastSeenAt`, and if the gap since it was
// last actually observed exceeds `candidateGapMs`, its dwell restarts from
// now instead of counting time it was nowhere to be seen. `candidateGapMs`
// should be comfortably larger than the polling interval (a couple of missed
// polls is a hiccup, not an absence) and much smaller than `dwellMs`.
// ---------------------------------------------------------------------------
"use strict";

const CODING = "coding";
const COMMUNICATION = "communication";
const BROWSING = "browsing";

// The three the plan names as required. Exported as a frozen list so the
// service, the IPC layer and the tests all agree on what a valid context is
// without re-declaring it.
const CONTEXTS = Object.freeze([CODING, COMMUNICATION, BROWSING]);

// How long a challenger must hold the foreground before it takes over.
// 45 seconds is deliberately long: the cost of switching late is that the
// Notch shows the previous layout for another half-minute, and the cost of
// switching early is a layout that moves while the user is reading it. The
// plan is explicit about which of those is worse.
const DEFAULT_DWELL_MS = 45_000;

// How long a challenger may go unobserved before its dwell restarts (see the
// header). Three missed 4-second polls.
const DEFAULT_CANDIDATE_GAP_MS = 12_000;

// Process names (lowercased, no `.exe` -- Windows' Get-Process ProcessName,
// which is what electron/platform/win32.cjs returns) mapped to the context
// they signal. Substring matching would be tempting and wrong: "code" is a
// substring of far too much, and a rule that fires on a coincidence is a
// context change the user cannot explain. Exact names only; an app nobody
// listed is unclassified, which is a safe answer rather than a wrong one.
const PROCESS_CONTEXTS = new Map([
	// -- coding
	["code", CODING],
	["code - insiders", CODING],
	["cursor", CODING],
	["devenv", CODING], // Visual Studio
	["idea64", CODING],
	["pycharm64", CODING],
	["webstorm64", CODING],
	["rider64", CODING],
	["clion64", CODING],
	["goland64", CODING],
	["sublime_text", CODING],
	["notepad++", CODING],
	["gitkraken", CODING],
	["sourcetree", CODING],
	["postman", CODING],
	["docker desktop", CODING],
	// -- communication
	["outlook", COMMUNICATION],
	["ms-teams", COMMUNICATION],
	["teams", COMMUNICATION],
	["slack", COMMUNICATION],
	["discord", COMMUNICATION],
	["zoom", COMMUNICATION],
	["telegram", COMMUNICATION],
	["whatsapp", COMMUNICATION],
	["skype", COMMUNICATION],
	["thunderbird", COMMUNICATION],
	["signal", COMMUNICATION],
	// -- browsing
	["chrome", BROWSING],
	["firefox", BROWSING],
	["msedge", BROWSING],
	["brave", BROWSING],
	["opera", BROWSING],
	["vivaldi", BROWSING],
	["arc", BROWSING],
]);

// Returns the context a foreground process name signals, or null for "no
// signal" (unknown app, blank, or a shell the platform adapter already treats
// as not-really-the-foreground-app). Never throws on odd input -- this sits
// on a polling path that must not be able to take the app down.
function classifyProcessName(processName) {
	if (typeof processName !== "string") {
		return null;
	}
	const normalized = processName.trim().toLowerCase();
	if (!normalized || normalized === "unknown") {
		return null;
	}
	return PROCESS_CONTEXTS.get(normalized) ?? null;
}

// `context` is the COMMITTED context -- what the rest of the app should act
// on. `candidate` is a challenger that has not yet earned the switch. A
// freshly-started detector has committed to nothing (null), which is
// meaningfully different from any of the three real contexts: it means "no
// sustained signal yet", and the service maps it to the environment's normal
// layout rather than to a context layout.
function createInitialContextState(now = 0) {
	return {
		context: null,
		changedAt: now,
		candidate: null,
		candidateSince: null,
		candidateLastSeenAt: null,
	};
}

// The whole hysteresis rule, as one pure transition. Returns a NEW state
// object plus `changed`, which is true only on the tick where a challenger
// actually won -- the service uses that edge to log an event and re-resolve
// the Notch layout, so it must never be true for a mere candidate update.
function nextContextState(state, observation, options = {}) {
	const dwellMs = Number.isFinite(options.dwellMs) ? options.dwellMs : DEFAULT_DWELL_MS;
	const candidateGapMs = Number.isFinite(options.candidateGapMs)
		? options.candidateGapMs
		: DEFAULT_CANDIDATE_GAP_MS;

	const current = state ?? createInitialContextState(0);
	const at = Number.isFinite(observation?.at) ? observation.at : 0;
	const observed = observation?.context ?? null;

	// No signal (unclassified app, ignored shell, unreadable window) -- hold
	// everything exactly as it is, including any challenger's part-built
	// dwell. See the header on why this is not evidence against.
	if (observed === null) {
		return { ...current, changed: false };
	}

	// The committed context reasserted itself: any challenger is abandoned,
	// which is what makes a brief glance away cost nothing at all.
	if (observed === current.context) {
		return {
			...current,
			candidate: null,
			candidateSince: null,
			candidateLastSeenAt: null,
			changed: false,
		};
	}

	// A different challenger than the one we were tracking (or the first one).
	if (observed !== current.candidate) {
		return {
			...current,
			candidate: observed,
			candidateSince: at,
			candidateLastSeenAt: at,
			changed: false,
		};
	}

	// Same challenger as last time -- but if it vanished for longer than the
	// gap tolerance, it has not been sustained, so its dwell restarts rather
	// than silently banking the time it was absent (see the header).
	const gap = at - (current.candidateLastSeenAt ?? at);
	if (gap > candidateGapMs) {
		return {
			...current,
			candidateSince: at,
			candidateLastSeenAt: at,
			changed: false,
		};
	}

	const heldFor = at - (current.candidateSince ?? at);
	if (heldFor < dwellMs) {
		return { ...current, candidateLastSeenAt: at, changed: false };
	}

	// Earned it.
	return {
		context: observed,
		changedAt: at,
		candidate: null,
		candidateSince: null,
		candidateLastSeenAt: null,
		changed: true,
	};
}

module.exports = {
	CODING,
	COMMUNICATION,
	BROWSING,
	CONTEXTS,
	DEFAULT_DWELL_MS,
	DEFAULT_CANDIDATE_GAP_MS,
	classifyProcessName,
	createInitialContextState,
	nextContextState,
};
