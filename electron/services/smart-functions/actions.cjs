// ---------------------------------------------------------------------------
// Smart Functions (WP-3.1) -- the action executors. This IS the action
// vocabulary already established by src/scenes.ts's NotchSceneConfig
// (launch apps, open URLs, control the timer, switch environment, create
// tasks), reimplemented on the MAIN process side because a scene today only
// ever runs from the renderer (src/components/notch/NotchApp.tsx#runScene,
// calling window.atlas.* one step at a time) -- there is no main-process
// entry point that pipeline can be called into (see
// electron/services/launcher-providers/commands-provider.cjs's own header,
// which found and documented exactly this gap for WP-2.9). Every executor
// below mirrors an EXISTING main-process call site as closely as possible:
//   - timer (start) mirrors commands-provider's "start-timer" command.
//   - timer (stop) mirrors commands-provider's "stop-timer" command.
//   - switchEnvironment mirrors ipc/environments.cjs's `environment:switch`
//     handler (setActiveEnvironment + the same "environment.switch" event).
//   - createTask mirrors ipc/tasks.cjs's `task:create` handler.
//   - launchApp/openUrl mirror NotchApp.tsx#runScene's own two loops --
//     `openUrl` reuses the exact `start "" "<url>"` shell trick, so both go
//     through platform.launch() exactly like a scene's launched apps do.
//
// -- Impure by design, dependency-injected --------------------------------
// Every executor takes `execCtx` (db, environmentId, getEventLog, getTracker,
// switchEnvironment, platform, dispatchNext -- all provided by engine.cjs)
// rather than reaching for a module-level `require("electron")` or a
// singleton -- exactly the DI style environment-switch.cjs and
// context-service.cjs already use, and the only way this file stays testable
// with a fake platform/db instead of actually spawning processes.
//
// -- Failure isolation is the CALLER's job (runner.cjs) ---------------------
// Every executor throws on failure (a missing environment, an unknown timer
// mode, a database error) rather than swallowing it -- runner.cjs is the one
// place that catches per-action, so "a failing action does not abort the
// remaining actions" has exactly one implementation, not one per executor.
//
// -- Loop prevention: tagging + explicit re-dispatch -------------------------
// `timer` (both modes) and `switchEnvironment` are the two actions whose
// resulting event ("session.start"/"session.stop"/"environment.switch") is
// ALSO one of this package's own trigger types -- the only two ways a rule's
// own action can feed a NEW event back into the engine. Both:
//   1. record the SAME event-log entry the real IPC handler would (so a
//      smart-function-driven timer/switch looks identical in Activity/
//      Insights history to a manually-driven one), tagged
//      `payload.smartFunctionOrigin = rule.id` so engine.cjs's generic
//      event-log subscription (which treats every UNTAGGED event as a fresh,
//      depth-0 external trigger) recognizes this one as already handled and
//      skips it -- see engine.cjs's header for why double-handling the same
//      event at depth 0 would silently defeat the depth-based loop guard.
//   2. call `execCtx.dispatchNext(event)`, which is engine.cjs's own
//      `handleEvent(event, depth + 1)` -- the ONE path that actually
//      re-evaluates rules against this synthetic re-trigger, at the correct,
//      incremented depth evaluate.cjs's `decide()` checks.
// createTask's "task.create" is deliberately NOT tagged/re-dispatched: no
// trigger type in this package reacts to a task being created (see
// model.cjs's TRIGGER_TYPES), so there is no loop for it to feed.
// ---------------------------------------------------------------------------

"use strict";

const { scoped } = require("../../data/scoped.cjs");

function smartFunctionOriginPayload(rule) {
	return { smartFunctionOrigin: rule.id };
}

async function runLaunchApp(action, execCtx) {
	await execCtx.platform.launch(action.command);
	return `Launched "${action.command}"`;
}

async function runOpenUrl(action, execCtx) {
	// The exact trick NotchApp.tsx#runScene uses for a scene's own `urls`:
	// the `start` shell built-in via `platform.launch`'s `shell: true` spawn,
	// never a second launch mechanism.
	await execCtx.platform.launch(`start "" "${action.url}"`);
	return `Opened ${action.url}`;
}

async function runTimerStart(execCtx, rule) {
	const environmentId = execCtx.environmentId;
	if (!environmentId) {
		throw new Error("No environment to start a timer in.");
	}
	if (!execCtx.db) {
		throw new Error("Database not ready.");
	}
	const session = scoped(execCtx.db, environmentId).sessions.start();
	execCtx.getTracker?.()?.setCurrentSession?.(session.id);
	execCtx.getEventLog?.()?.record("session.start", {
		environmentId,
		sessionId: session.id,
		payload: smartFunctionOriginPayload(rule),
	});
	// Awaited, not fire-and-forget: this is what makes the whole re-dispatch
	// chain (bounded by evaluate.cjs's depth guard) fully settle before this
	// action -- and in turn the rule that ran it -- is considered "done". See
	// engine.cjs's header on why depth is threaded as a plain argument rather
	// than a shared counter; awaiting here does not change that correctness
	// argument, it only makes "the whole chain has finished" observable.
	await execCtx.dispatchNext?.({ type: "session.start", environmentId, sessionId: session.id });
	return "Timer started";
}

async function runTimerStop(execCtx, rule) {
	const db = execCtx.db;
	if (!db) {
		throw new Error("Database not ready.");
	}
	const active = scoped.getGlobalActiveSession(db);
	if (!active) {
		throw new Error("No active timer to stop.");
	}
	const scope = scoped.forSession(db, active.id);
	if (!scope) {
		throw new Error("No active session found to stop.");
	}
	execCtx.getTracker?.()?.closeOpenBlockNow?.(active.id);
	const session = scope.sessions.stop(active.id);
	execCtx.getEventLog?.()?.record("session.stop", {
		environmentId: session.environment_id,
		sessionId: active.id,
		payload: smartFunctionOriginPayload(rule),
	});
	await execCtx.dispatchNext?.({ type: "session.stop", environmentId: session.environment_id, sessionId: active.id });
	return "Timer stopped";
}

async function runTimer(action, execCtx, rule) {
	if (action.mode === "start") {
		return runTimerStart(execCtx, rule);
	}
	if (action.mode === "stop") {
		return runTimerStop(execCtx, rule);
	}
	throw new Error(`Unknown timer mode "${action.mode}".`);
}

async function runSwitchEnvironment(action, execCtx, rule) {
	if (typeof execCtx.switchEnvironment !== "function") {
		throw new Error("Switching environments is not available.");
	}
	execCtx.switchEnvironment(action.environmentId);
	execCtx.getEventLog?.()?.record("environment.switch", {
		environmentId: action.environmentId,
		payload: smartFunctionOriginPayload(rule),
	});
	await execCtx.dispatchNext?.({ type: "environment.switch", environmentId: action.environmentId });
	return `Switched environment to ${action.environmentId}`;
}

async function runCreateTask(action, execCtx) {
	const environmentId = execCtx.environmentId;
	if (!environmentId) {
		throw new Error("No environment to create a task in.");
	}
	if (!execCtx.db) {
		throw new Error("Database not ready.");
	}
	const scope = scoped(execCtx.db, environmentId);
	const task = scope.tasks.create(action.title, "", {});
	if (action.column) {
		scope.tasks.updateStatus(task.id, action.column);
	}
	execCtx.getEventLog?.()?.record("task.create", { environmentId, subject: task.id });
	return `Created task "${action.title}"`;
}

// action.type -> (action, execCtx, rule) => Promise<string /* human-readable
// detail, for the run summary */>. Throws on failure -- see this file's
// header on why isolation lives in runner.cjs, not here.
const ACTION_RUNNERS = {
	launchApp: runLaunchApp,
	openUrl: runOpenUrl,
	timer: runTimer,
	switchEnvironment: runSwitchEnvironment,
	createTask: runCreateTask,
};

module.exports = { ACTION_RUNNERS, smartFunctionOriginPayload };
