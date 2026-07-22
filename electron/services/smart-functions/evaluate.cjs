// ---------------------------------------------------------------------------
// Smart Functions (WP-3.1) -- the PURE half: trigger matching, condition
// checking, and the loop-prevention decision, all as one function of
// (rule, event, ctx) with no I/O. Mirrors the split this codebase already
// established for context-detection.cjs, launcher-providers/ranking.cjs, and
// file-index/file-ranking.cjs: the decision is a pure reducer, unit-testable
// with plain fixtures; engine.cjs (the stateful half) is responsible for
// gathering `ctx` from the real world and for actually running a rule's
// actions once `decide()` says to.
//
// -- What `event` looks like ---------------------------------------------
// `{ type, environmentId, subject, payload, sessionId }` -- the same shape
// electron/services/event-log.cjs's `record()` normalizes to (see that
// module's own `subscribe()`, which is engine.cjs's primary trigger source),
// plus two synthetic types engine.cjs generates itself and never persists:
// `"time.tick"` (payload: `{ hhmm }`, the one deliberately polled trigger --
// see engine.cjs's header for why) and `"manual"` (an explicit, direct
// invocation of one specific rule, ignoring every other rule's trigger
// entirely -- see decide() below).
//
// -- What `ctx` looks like ---------------------------------------------------
// `{ currentEnvironmentId, foregroundProcessName, now, dispatchDepth,
//    maxDispatchDepth, recentFires(ruleId) -> number[], maxFiresPerWindow,
//    rateWindowMs }`. Every field is a plain value or a plain accessor
// function -- nothing here is a live db/timer handle, so a test can build one
// from a literal object with zero mocking.
// ---------------------------------------------------------------------------

"use strict";

// Case-insensitive, trimmed equality -- the one comparison every process-name
// match in this module uses (trigger.processName, app_running's processName),
// since Windows process names/foreground labels are not case-sensitive in any
// way a user would expect to have to match exactly.
function sameProcessName(a, b) {
	return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Deliberately simple: a case-insensitive substring match, with a leading
// "*" treated as "ends with" and a trailing "*" treated as "starts with" --
// enough to express "anything under this folder" or "*.psd" without pulling
// in a real glob engine for v1. A blank/missing pattern matches everything.
function matchesFilePattern(path, pattern) {
	if (!pattern) {
		return true;
	}
	if (typeof path !== "string") {
		return false;
	}
	const haystack = path.toLowerCase();
	const needle = pattern.trim().toLowerCase();
	if (needle.startsWith("*") && needle.endsWith("*") && needle.length > 1) {
		return haystack.includes(needle.slice(1, -1));
	}
	if (needle.startsWith("*")) {
		return haystack.endsWith(needle.slice(1));
	}
	if (needle.endsWith("*")) {
		return haystack.startsWith(needle.slice(0, -1));
	}
	return haystack.includes(needle);
}

// event.type -> the value a normalized rule.trigger.type is stored under,
// EXCEPT "manual" and "time.of_day", which have no 1:1 event.type (manual
// bypasses trigger matching entirely; time.of_day matches the synthetic
// "time.tick" event on its own `hhmm` field, not on type alone) and
// "app.launched", which matches "app.focus" (see this file's header on why
// there is no separate "an app was launched" signal -- app.focus IS that
// signal, see activity-tracker.cjs).
const TRIGGER_EVENT_TYPE = {
	"environment.switched": "environment.switch",
	"session.started": "session.start",
	"session.stopped": "session.stop",
	"app.launched": "app.focus",
	"display.connected": "display.connected",
};

function matchesTrigger(trigger, event) {
	if (!trigger || !event || typeof event.type !== "string") {
		return false;
	}
	if (trigger.type === "manual") {
		// A manual trigger never matches an incoming event -- it only ever runs
		// via engine.runManually(), which bypasses matchesTrigger entirely (see
		// engine.cjs). This keeps "decide() said no" and "this wasn't a manual
		// invocation" the same, simple answer.
		return false;
	}
	if (trigger.type === "time.of_day") {
		return event.type === "time.tick" && event.payload?.hhmm === trigger.time;
	}
	if (trigger.type === "file.changed") {
		if (event.type !== "file.changed") {
			return false;
		}
		if (trigger.kind && event.payload?.kind !== trigger.kind) {
			return false;
		}
		return matchesFilePattern(event.payload?.path, trigger.pattern);
	}
	const expectedEventType = TRIGGER_EVENT_TYPE[trigger.type];
	if (!expectedEventType || event.type !== expectedEventType) {
		return false;
	}
	if (trigger.type === "environment.switched" && trigger.environmentId) {
		return event.environmentId === trigger.environmentId;
	}
	if (trigger.type === "app.launched" && trigger.processName) {
		return sameProcessName(event.subject, trigger.processName);
	}
	return true;
}

// Minutes since midnight, for a simple linear time-of-day comparison.
function minutesOf(hhmm) {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}

function withinTimeWindow(condition, nowMs) {
	const nowMinutes = new Date(nowMs).getHours() * 60 + new Date(nowMs).getMinutes();
	const start = minutesOf(condition.start);
	const end = minutesOf(condition.end);
	if (start === end) {
		return true; // a zero-width window is "always", not "never"
	}
	if (start < end) {
		return nowMinutes >= start && nowMinutes < end;
	}
	// Overnight window (e.g. 22:00 -> 06:00): true on either side of midnight.
	return nowMinutes >= start || nowMinutes < end;
}

function evaluateCondition(condition, ctx) {
	switch (condition.type) {
		case "environment":
			return Boolean(ctx.currentEnvironmentId) && ctx.currentEnvironmentId === condition.environmentId;
		case "time_window":
			return withinTimeWindow(condition, ctx.now);
		case "app_running":
			return sameProcessName(ctx.foregroundProcessName, condition.processName);
		default:
			// An unrecognized condition type (a future version's document read by
			// an older build) fails closed -- never fires a rule whose condition
			// this build doesn't understand.
			return false;
	}
}

function evaluateConditions(conditions, ctx) {
	if (!Array.isArray(conditions) || conditions.length === 0) {
		return true;
	}
	return conditions.every((condition) => evaluateCondition(condition, ctx));
}

// The one entry point engine.cjs calls for every (rule, event) pair. Returns
// `{ fire, reason }` -- `reason` is never used to decide behaviour outside
// this function (engine.cjs only branches on `fire`), it exists purely so a
// caller can log/test WHY a rule didn't fire without re-deriving it.
function decide(rule, event, ctx) {
	if (!rule || rule.enabled === false) {
		return { fire: false, reason: "disabled" };
	}

	// Loop prevention, part 1: a dispatch chain deeper than the configured
	// budget refuses EVERY rule outright, regardless of trigger/conditions --
	// see engine.cjs's header for how `ctx.dispatchDepth` is threaded through
	// an action's own re-dispatch, and why that (not a shared mutable counter)
	// is what makes this check meaningful across an async action boundary.
	if (ctx.dispatchDepth > ctx.maxDispatchDepth) {
		return { fire: false, reason: "loop_prevented" };
	}

	if (event.type === "manual") {
		// Explicit, direct invocation of THIS rule (engine.runManually) --
		// trigger/environment scoping never apply; only the depth guard above
		// and the rate cap below still gate a manual run, so a runaway manual
		// re-trigger loop (a rule whose OWN action re-invokes itself manually)
		// is still bounded.
	} else if (!matchesTrigger(rule.trigger, event)) {
		return { fire: false, reason: "no_trigger_match" };
	} else if (
		rule.environmentId &&
		ctx.currentEnvironmentId &&
		rule.environmentId !== ctx.currentEnvironmentId
	) {
		// An environment-scoped rule only reacts to a REAL event while its own
		// environment is active -- see migration 011's header on why a rule can
		// belong to one environment, several (shared layout), or none (global).
		// Skipped entirely when there is no "current" environment to compare
		// against (e.g. at boot before any switch), matching the same
		// fail-open-to-global convention electron/db.cjs#getEffectiveNotchPreferences
		// already uses for a null environment id.
		return { fire: false, reason: "environment_mismatch" };
	}

	if (!evaluateConditions(rule.conditions, ctx)) {
		return { fire: false, reason: "condition_failed" };
	}

	// Loop prevention, part 2: a per-rule firing-rate cap, independent of the
	// depth guard above -- catches a loop that ISN'T one synchronous
	// recursive chain (e.g. two rules ping-ponging through an awaited action),
	// which the depth guard alone cannot see since each top-level dispatch
	// starts back at depth 0.
	const recentFires = typeof ctx.recentFires === "function" ? ctx.recentFires(rule.id) ?? [] : [];
	const windowStart = ctx.now - ctx.rateWindowMs;
	const firesInWindow = recentFires.filter((firedAt) => firedAt > windowStart).length;
	if (firesInWindow >= ctx.maxFiresPerWindow) {
		return { fire: false, reason: "rate_limited" };
	}

	return { fire: true, reason: "matched" };
}

module.exports = {
	sameProcessName,
	matchesFilePattern,
	matchesTrigger,
	withinTimeWindow,
	evaluateCondition,
	evaluateConditions,
	decide,
};
