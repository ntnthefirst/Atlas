// ---------------------------------------------------------------------------
// Smart Functions (WP-3.1) -- runs one rule's action LIST, in order, with
// every action's failure isolated from the rest. This is the whole
// implementation of the WP's "a failing action does not abort the remaining
// actions" acceptance criterion: each action is awaited inside its own
// try/catch, a thrown error becomes one failed entry in the returned summary
// (never a rejected promise the caller has to also catch), and the loop
// always continues to the next action regardless of what the previous one
// did. Mirrors electron/services/environment-switch.cjs#launchStartupApps's
// own per-command try/catch, generalized from "N commands" to "N actions of
// five different kinds".
// ---------------------------------------------------------------------------

"use strict";

const { ACTION_RUNNERS } = require("./actions.cjs");

// Runs every action in `rule.actions`, independently. Returns
// `{ results, failedCount, actionCount }` -- `results` is one entry per
// action, in order, `{ index, type, ok, detail? , error? }`. Never throws:
// an unknown action type is recorded as a failed result (defensive against a
// future build reading a rule written by a newer one), exactly like a
// throwing executor.
async function runActions(rule, execCtx) {
	const results = [];

	for (let index = 0; index < rule.actions.length; index += 1) {
		const action = rule.actions[index];
		const type = action?.type ?? "unknown";
		const runnerFn = ACTION_RUNNERS[type];

		if (!runnerFn) {
			const error = `Unknown action type "${type}".`;
			results.push({ index, type, ok: false, error });
			recordActionFailure(rule, execCtx, index, type, error);
			continue;
		}

		try {
			const detail = await runnerFn(action, execCtx, rule);
			results.push({ index, type, ok: true, detail: detail ?? null });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results.push({ index, type, ok: false, error: message });
			recordActionFailure(rule, execCtx, index, type, message);
		}
	}

	const failedCount = results.filter((result) => !result.ok).length;
	return { results, failedCount, actionCount: results.length };
}

// Logs a failing action through the shared event log (batched, bounded --
// see electron/services/event-log.cjs's own header) AND to the console, so a
// failure is visible even in a boot with no event log wired up (tests, or a
// very early crash). Never throws -- a broken event log must not turn one
// failed action into a second, unhandled failure.
function recordActionFailure(rule, execCtx, index, type, message) {
	console.error(
		`[Atlas] smart-functions: action #${index} ("${type}") failed for rule "${rule.id}" ("${rule.label}"):`,
		message,
	);
	try {
		execCtx.getEventLog?.()?.record("smart_function.action_failed", {
			environmentId: execCtx.environmentId ?? rule.environmentId ?? null,
			subject: rule.id,
			payload: { actionType: type, index, error: message },
		});
	} catch {
		// A broken event log must never break action execution or mask the
		// console.error above, which already ran.
	}
}

module.exports = { runActions };
