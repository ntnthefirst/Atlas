"use strict";

// ---------------------------------------------------------------------------
// Finding lifecycle IPC handlers (findings:*) -- WP-3.4.
//
// No preload/renderer wiring yet -- the same precedent electron/ipc/
// smart-functions.cjs (WP-3.1) and electron/ipc/pattern-miner.cjs (WP-3.3)
// already set: WP-3.5 ("Suggestion surfacing") and WP-3.6 ("Findings
// management") are the packages that build the UI these channels back.
// Registering the handlers now keeps accept/ignore/expire real and testable
// through the same seam every other domain uses, without building UI this WP
// was never asked to build.
//
// `manager` is a plain value (never reassigned after main.cjs constructs it,
// exactly like `patternMiner`/`smartFunctionsEngine`); `engine` is the smart
// functions engine, used ONLY to refresh its in-memory rule cache after
// acceptFinding() creates a new one -- the exact same
// `engine?.refreshRules?.()` call electron/ipc/smart-functions.cjs's own
// `create`/`update`/`delete` handlers already make after touching
// `smart_functions`. `getDb`/`getEventLog` are getters for the usual reason
// (`db`/`eventLog` are `let`s main.cjs reassigns during startup).
//
// -- WP-3.5/3.7: recording the outcome ---------------------------------------
// `getEventLog` is optional (every call below uses `?.()?.record?.()`) and
// new for WP-3.5: `findings:accept`/`findings:ignore` are the SAME two
// handlers the Notch's one-click accept/dismiss buttons call (see electron/
// services/suggestion-surfacing/suggestion-manager.cjs's own header for why
// accept/dismiss deliberately live here and nowhere else), so this is the
// one place a "the user accepted/dismissed a suggestion" event can be logged
// without a second, parallel call site. Only the finding's pattern type and
// the outcome are recorded -- never a raw window title or file path (see
// electron/services/event-log.cjs's own privacy header) -- exactly what
// WP-3.7's feedback loop needs to suppress categories the user keeps
// rejecting, no more.
// ---------------------------------------------------------------------------

const patternMinerStore = require("../services/pattern-miner/store.cjs");

function register(ipcMain, deps) {
	const { manager, engine, getDb, getEventLog } = deps;

	ipcMain.handle("findings:getLifecyclePreferences", () => manager.getPreferences());

	ipcMain.handle("findings:setLifecyclePreferences", (_event, patch) => manager.setPreferences(patch || {}));

	ipcMain.handle("findings:markSuggested", (_event, findingId) => manager.markSuggested(findingId));

	ipcMain.handle("findings:accept", (_event, findingId) => {
		// Read BEFORE acceptFinding() runs, purely for this event-log record --
		// patternType/environmentId are stable columns accept() never changes,
		// so reading them first vs. after makes no difference to what's logged,
		// only to whether a lookup is still possible if accept() itself fails.
		const db = getDb?.();
		const findingForLog = db ? patternMinerStore.getFinding(db, findingId) : null;

		const result = manager.acceptFinding(findingId);
		if (result.ok) {
			// A brand new (or reused) rule only takes effect once the engine's own
			// in-memory cache is refreshed -- see smart-functions.cjs's identical
			// call after its own `create`.
			engine?.refreshRules?.();
			getEventLog?.()?.record?.("suggestion.accepted", {
				environmentId: findingForLog?.environmentId ?? result.rule?.environmentId ?? null,
				subject: findingId,
				payload: { patternType: findingForLog?.patternType ?? null },
			});
		}
		return result;
	});

	ipcMain.handle("findings:ignore", (_event, findingId) => {
		const result = manager.ignoreFinding(findingId);
		if (result.ok) {
			getEventLog?.()?.record?.("suggestion.dismissed", {
				environmentId: result.finding?.environmentId ?? null,
				subject: findingId,
				payload: { patternType: result.finding?.patternType ?? null },
			});
		}
		return result;
	});

	// Bulk sweeps -- never run automatically (see finding-lifecycle-manager.cjs's
	// own header); exposed here for an explicit "check now" affordance (and for
	// this WP's own tests/verification) exactly like patternMiner:runNow.
	ipcMain.handle("findings:resurfaceDue", () => manager.resurfaceDueFindings());

	ipcMain.handle("findings:sweepExpired", () => manager.sweepExpiredFindings());
}

module.exports = { register };
