// ---------------------------------------------------------------------------
// Smart Functions (WP-3.1) -- the STATEFUL half: owns the loaded rule cache,
// the loop-prevention bookkeeping, and every wire-up to a real trigger
// source. All of the actual decision-making lives in ./evaluate.cjs, which is
// pure; this module is deliberately thin around it, the same split
// context-service.cjs/context-detection.cjs and watcher.cjs/store.cjs already
// use in this codebase.
//
// -- Event-driven, not polling: subscribing to what already exists ----------
// This engine's PRIMARY trigger source is electron/services/event-log.cjs's
// new `subscribe()` (see that module's own header) -- almost every trigger
// this WP needs is something the app ALREADY records there the instant it
// happens: "environment.switch" (ipc/environments.cjs's `environment:switch`
// handler), "session.start"/"session.stop" (ipc/sessions.cjs and
// commands-provider.cjs), and "app.focus" (activity-tracker.cjs, itself only
// while a session is running -- see this file's own limitation note below).
// Subscribing once, here, means zero new polling for any of those four
// trigger types: `onEventLogEvent` below fires synchronously, in the same
// tick as whatever real action produced the event.
//
// Two more trigger types get a small, targeted, ADDITIONAL wire (not a new
// generic poll):
//   - "file.changed" rides electron/services/file-index/watcher.cjs's own
//     debounced fs.watch flush via its new `onFileEvent` hook (main.cjs wires
//     `handleFileEvent` below into it) -- a REAL filesystem notification, not
//     a second watcher and not a poll.
//   - "display.connected" rides Electron's own `screen.on("display-added"/
//     "display-removed")`, which main.cjs already listens to (to re-sync the
//     Notch across monitor changes) -- main.cjs now ALSO records an
//     "display.connected"/"display.disconnected" event-log entry there, which
//     this engine picks up through the exact same subscription as everything
//     else. No engine-side wiring at all beyond the ordinary subscription.
//
// -- The one genuinely polled trigger: time.of_day ---------------------------
// There is no OS-level "it is now HH:MM" event on Windows without standing up
// a Task Scheduler job (out of scope, and a much heavier mechanism than one
// rule's alarm deserves) or spawning a THIRD long-lived powershell.exe
// process (D10/win32.cjs's own discipline is to keep OS access rare and
// centralized, not add a new always-on process for this). A lightweight
// interval (default DEFAULT_TIME_POLL_MS, unref'd, same posture as
// context-service.cjs's own poll) checks the wall clock and dispatches a
// synthetic "time.tick" event ONLY when the minute actually changes -- so a
// rule with a `time.of_day` trigger fires once, not once per poll tick.
//
// -- Loop prevention (see evaluate.cjs#decide for the pure half) -------------
// A rule's action can itself produce a NEW event of a type this engine
// reacts to -- today, exactly two: `timer` (session.start/session.stop) and
// `switchEnvironment` (environment.switch), see actions.cjs's own header.
// Left unchecked, "trigger: environment switched, action: switch
// environment" retriggers itself the instant its own action's event-log
// write is observed. Two independent defenses:
//   1. An EXPLICIT depth counter, threaded as a plain function argument
//      (`handleEvent(event, depth)`), never a shared mutable field mutated
//      around an await -- see actions.cjs's own dispatchNext, which calls
//      `handleEvent(nextEvent, depth + 1)` directly, bypassing the generic
//      event-log subscription (which always starts at depth 0 and would
//      otherwise re-enter this same loop UNBOUNDED, since a fresh depth-0
//      entry is exactly what a real external event looks like -- see
//      `smartFunctionOrigin` below for how the two paths stay separate).
//      `evaluate.cjs#decide` refuses every rule outright once
//      `dispatchDepth > maxDispatchDepth`.
//   2. A per-rule firing-RATE cap (`recentFires`/`maxFiresPerWindow`/
//      `rateWindowMs`), independent of depth -- catches a loop that ISN'T one
//      synchronous recursive chain (e.g. two rules ping-ponging through an
//      awaited action across separate top-level, depth-0 dispatches).
// `payload.smartFunctionOrigin` (set by actions.cjs) is what keeps these two
// paths from double-firing the SAME logical event: the generic event-log
// subscription (`onEventLogEvent`) skips anything carrying that tag, because
// it was ALREADY explicitly re-dispatched via `dispatchNext` at the correct,
// incremented depth. Without that skip, the untagged, always-depth-0
// subscription path would re-enter this same rule forever, completely
// bypassing the depth guard -- proven in engine.test.js.
// ---------------------------------------------------------------------------

"use strict";

const store = require("./store.cjs");
const { decide } = require("./evaluate.cjs");
const { runActions } = require("./runner.cjs");
const { describeRule, describeAction } = require("./describe.cjs");

const DEFAULT_MAX_DISPATCH_DEPTH = 5;
const DEFAULT_MAX_FIRES_PER_WINDOW = 5;
const DEFAULT_RATE_WINDOW_MS = 10_000;
const DEFAULT_TIME_OF_DAY_POLL_MS = 30_000;

function createSmartFunctionsEngine(deps = {}) {
	const getDb = deps.getDb ?? (() => null);
	const getEventLog = deps.getEventLog ?? (() => null);
	const getCurrentEnvironmentId = deps.getCurrentEnvironmentId ?? (() => null);
	const getTracker = deps.getTracker ?? (() => null);
	const platform = deps.platform ?? require("../../platform/index.cjs");
	// Plain function, never reassigned after construction -- main.cjs passes
	// its own `setActiveEnvironment` here, exactly like environment-switch.cjs
	// and commands-provider.cjs both already receive it.
	const switchEnvironment = deps.switchEnvironment ?? null;
	const now = deps.now ?? (() => Date.now());
	const setIntervalFn = deps.setInterval ?? setInterval;
	const clearIntervalFn = deps.clearInterval ?? clearInterval;
	const maxDispatchDepth = deps.maxDispatchDepth ?? DEFAULT_MAX_DISPATCH_DEPTH;
	const maxFiresPerWindow = deps.maxFiresPerWindow ?? DEFAULT_MAX_FIRES_PER_WINDOW;
	const rateWindowMs = deps.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
	const timeOfDayPollMs = deps.timeOfDayPollMs ?? DEFAULT_TIME_OF_DAY_POLL_MS;

	let rules = [];
	// ruleId -> number[] (epoch ms this rule fired at, pruned to the rate
	// window on every read/write) -- in-memory only, deliberately: this is a
	// runtime safety valve, not user-facing history (that's what
	// "smart_function.fired" event-log entries are for), so it resets on
	// every restart, which is the right behaviour for a circuit breaker.
	let fireHistory = new Map();
	// The last process name observed via an "app.focus" event -- feeds the
	// `app_running` condition (see evaluate.cjs) at zero extra cost: no new
	// I/O, just remembering what already flowed past. Deliberately NOT "any
	// process running anywhere" (that would need platform.listRunningApps(),
	// a real powershell.exe spawn -- too expensive to pay on every condition
	// check); "currently the foreground app" is the cheap, honest
	// approximation this engine makes, documented here and in evaluate.cjs.
	let foregroundProcessName = null;
	let unsubscribeEventLog = null;
	let timeTimer = null;
	let lastCheckedMinute = null;

	function refreshRules() {
		const db = getDb();
		rules = db ? store.listAllRules(db) : [];
		return rules;
	}

	function recordFire(ruleId, at) {
		const cutoff = at - rateWindowMs;
		const list = (fireHistory.get(ruleId) ?? []).filter((firedAt) => firedAt >= cutoff);
		list.push(at);
		fireHistory.set(ruleId, list);
	}

	function recentFiresFor(ruleId) {
		return fireHistory.get(ruleId) ?? [];
	}

	function buildContext(depth) {
		return {
			currentEnvironmentId: getCurrentEnvironmentId(),
			foregroundProcessName,
			now: now(),
			dispatchDepth: depth,
			maxDispatchDepth,
			recentFires: recentFiresFor,
			maxFiresPerWindow,
			rateWindowMs,
		};
	}

	function logSafely(type, options) {
		try {
			getEventLog()?.record(type, options);
		} catch {
			// A broken event log must never break rule evaluation/execution.
		}
	}

	async function executeRule(rule, event, depth) {
		recordFire(rule.id, now());
		const execCtx = {
			db: getDb(),
			environmentId: rule.environmentId ?? getCurrentEnvironmentId(),
			getEventLog,
			getTracker,
			platform,
			switchEnvironment,
			// See this file's header: this is the ONLY path a rule's own action
			// re-enters evaluation through, always at depth + 1.
			dispatchNext: (nextEvent) => handleEvent(nextEvent, depth + 1),
		};
		const summary = await runActions(rule, execCtx);
		logSafely("smart_function.fired", {
			environmentId: execCtx.environmentId,
			subject: rule.id,
			payload: {
				triggerType: event.type,
				actionCount: summary.actionCount,
				failedCount: summary.failedCount,
			},
		});
		return summary;
	}

	// The single entry point for every event this engine ever reacts to,
	// whether real (the event-log subscription, always depth 0) or synthetic
	// (a rule's own action, via dispatchNext at depth + 1, or the time-of-day
	// poll's own synthetic tick, always depth 0). Never throws.
	async function handleEvent(event, depth = 0) {
		try {
			if (!event || typeof event.type !== "string") {
				return [];
			}
			// Never a trigger source, and never re-entrant: these are THIS
			// engine's own observability events (recorded by logSafely above and
			// by the loop/rate-limit guards below) -- letting them loop back in
			// would mean the engine's own bookkeeping could retrigger itself.
			if (event.type.startsWith("smart_function.")) {
				return [];
			}
			if (event.type === "app.focus" && typeof event.subject === "string" && event.subject) {
				foregroundProcessName = event.subject;
			}

			// A cheap early exit once the budget is blown -- evaluate.cjs#decide
			// enforces this SAME bound per rule too (`ctx.dispatchDepth >
			// ctx.maxDispatchDepth`), so removing just this one still terminates
			// correctly; this is only here to skip iterating `rules` at all once
			// nothing in it could possibly fire, not the sole enforcement point.
			if (depth > maxDispatchDepth) {
				console.error(
					`[Atlas] smart-functions: dispatch depth exceeded (${depth}) handling "${event.type}" -- refusing further evaluation to avoid a runaway loop.`,
				);
				logSafely("smart_function.loop_prevented", { payload: { eventType: event.type, depth } });
				return [];
			}

			const ctx = buildContext(depth);
			const summaries = [];
			for (const rule of rules) {
				const decision = decide(rule, event, ctx);
				if (!decision.fire) {
					if (decision.reason === "rate_limited") {
						logSafely("smart_function.suppressed", {
							environmentId: rule.environmentId ?? null,
							subject: rule.id,
							payload: { reason: decision.reason, eventType: event.type },
						});
					}
					continue;
				}
				// Awaited in the loop deliberately -- rules are evaluated (and, when
				// matched, run) in order, one at a time, so
				// fireHistory/foregroundProcessName mutations never interleave
				// unpredictably across rules reacting to the SAME event.
				summaries.push(await executeRule(rule, event, depth));
			}
			return summaries;
		} catch (error) {
			console.error("[Atlas] smart-functions: handleEvent failed unexpectedly:", error);
			return [];
		}
	}

	// See this file's header: skips anything tagged as this engine's OWN
	// action re-dispatching itself (already handled, at the correct depth, via
	// dispatchNext) -- without this, EVERY event-log write would be treated as
	// a fresh, depth-0 external trigger, including a smart function's own
	// action's write, which would silently defeat the depth guard entirely.
	function onEventLogEvent(event) {
		if (event?.payload?.smartFunctionOrigin) {
			return;
		}
		void handleEvent(event, 0);
	}

	// WP-3.1's "file changed" trigger -- wired directly to
	// file-index/watcher.cjs's `onFileEvent` hook (main.cjs), never to the
	// event log (see that hook's own header on why: aggregate vs. per-path).
	function handleFileEvent(fileEvent) {
		void handleEvent(
			{
				type: "file.changed",
				environmentId: fileEvent?.environmentId ?? null,
				subject: fileEvent?.path ?? null,
				payload: { kind: fileEvent?.kind ?? "changed", path: fileEvent?.path ?? null },
				sessionId: null,
			},
			0,
		);
	}

	function checkTimeOfDay() {
		const current = new Date(now());
		const hhmm = `${String(current.getHours()).padStart(2, "0")}:${String(current.getMinutes()).padStart(2, "0")}`;
		if (hhmm === lastCheckedMinute) {
			return;
		}
		lastCheckedMinute = hhmm;
		void handleEvent({ type: "time.tick", environmentId: null, subject: null, payload: { hhmm }, sessionId: null }, 0);
	}

	function startTimeOfDayPoll() {
		if (timeTimer || !(timeOfDayPollMs > 0)) {
			return;
		}
		timeTimer = setIntervalFn(checkTimeOfDay, timeOfDayPollMs);
		if (typeof timeTimer.unref === "function") {
			timeTimer.unref();
		}
	}

	function stopTimeOfDayPoll() {
		if (timeTimer) {
			clearIntervalFn(timeTimer);
			timeTimer = null;
		}
	}

	// Runs one rule right now, by id, ignoring its own trigger entirely --
	// exactly what pressing a scene's Notch button does today, and what
	// WP-3.2's editor "run now"/dry-run affordance will call. Conditions, the
	// depth guard, and the rate cap all still apply (see evaluate.cjs#decide's
	// `event.type === "manual"` branch) -- a manual rule that keeps
	// re-triggering ITSELF via its own action is still bounded.
	async function runManually(ruleId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		const rule = store.getRule(db, ruleId);
		if (!rule) {
			return { ok: false, error: "Smart function not found." };
		}
		const event = { type: "manual", environmentId: null, subject: null, payload: null, sessionId: null };
		const decision = decide(rule, event, buildContext(0));
		if (!decision.fire) {
			return { ok: false, error: `Not run (${decision.reason}).` };
		}
		const summary = await executeRule(rule, event, 0);
		return { ok: summary.failedCount === 0, summary };
	}

	// WP-3.2's "dry-run shows what would happen without doing it". Asks
	// evaluate.cjs#decide the EXACT question runManually asks -- same synthetic
	// manual event, same buildContext(0) -- and then stops, before
	// executeRule. Nothing else in this function has a side effect of any kind:
	// no action runs, no `smart_function.fired` event is logged, and
	// recordFire() is never called, so a dry run cannot consume the rate cap
	// that a later real run depends on. Reusing decide() rather than
	// re-deriving the answer is the whole point: a dry run that computed
	// eligibility its own way could disagree with the engine, which is exactly
	// what the user is trying to find out.
	//
	// A disabled rule reports `wouldFire: false, reason: "disabled"` rather
	// than "what it would do if it were on" -- the criterion is that this
	// matches actual behaviour, and actual behaviour is that a disabled rule
	// does not run.
	function dryRun(ruleId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		const rule = store.getRule(db, ruleId);
		if (!rule) {
			return { ok: false, error: "Smart function not found." };
		}
		const event = { type: "manual", environmentId: null, subject: null, payload: null, sessionId: null };
		const ctx = buildContext(0);
		const decision = decide(rule, event, ctx);
		return {
			ok: true,
			wouldFire: decision.fire,
			reason: decision.reason,
			description: describeRule(rule),
			// What it WOULD do, in the same words the preview uses -- an empty
			// list is itself the answer for a rule with no actions.
			actions: rule.actions.map((action) => describeAction(action)),
			// The live values the verdict was measured against, so a "no" is
			// explainable rather than mysterious.
			context: {
				currentEnvironmentId: ctx.currentEnvironmentId ?? null,
				foregroundProcessName: ctx.foregroundProcessName ?? null,
				now: ctx.now,
			},
		};
	}

	function start() {
		refreshRules();
		const eventLog = getEventLog();
		if (eventLog && typeof eventLog.subscribe === "function" && !unsubscribeEventLog) {
			unsubscribeEventLog = eventLog.subscribe(onEventLogEvent);
		}
		startTimeOfDayPoll();
		return getStatus();
	}

	function shutdown() {
		if (unsubscribeEventLog) {
			unsubscribeEventLog();
			unsubscribeEventLog = null;
		}
		stopTimeOfDayPoll();
	}

	function getStatus() {
		return {
			ruleCount: rules.length,
			subscribed: unsubscribeEventLog !== null,
			timeOfDayPolling: timeTimer !== null,
		};
	}

	return {
		start,
		shutdown,
		refreshRules,
		handleEvent,
		handleFileEvent,
		runManually,
		dryRun,
		getStatus,
		// Test/inspection seams -- mirror context-service.cjs's own
		// getStatus()/waitForIdle() convention for exposing otherwise-private
		// state without a real timer/db. `_seedRulesForTest` lets a test drive
		// dispatch/loop-prevention against a literal rule fixture without a real
		// database -- store.cjs (the read path `refreshRules()` normally uses)
		// already has its own dedicated suite.
		_recentFiresFor: recentFiresFor,
		_seedRulesForTest: (seededRules) => {
			rules = seededRules;
		},
	};
}

module.exports = {
	createSmartFunctionsEngine,
	DEFAULT_MAX_DISPATCH_DEPTH,
	DEFAULT_MAX_FIRES_PER_WINDOW,
	DEFAULT_RATE_WINDOW_MS,
	DEFAULT_TIME_OF_DAY_POLL_MS,
};
