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
// `smart_functions`.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { manager, engine } = deps;

	ipcMain.handle("findings:getLifecyclePreferences", () => manager.getPreferences());

	ipcMain.handle("findings:setLifecyclePreferences", (_event, patch) => manager.setPreferences(patch || {}));

	ipcMain.handle("findings:markSuggested", (_event, findingId) => manager.markSuggested(findingId));

	ipcMain.handle("findings:accept", (_event, findingId) => {
		const result = manager.acceptFinding(findingId);
		if (result.ok) {
			// A brand new (or reused) rule only takes effect once the engine's own
			// in-memory cache is refreshed -- see smart-functions.cjs's identical
			// call after its own `create`.
			engine?.refreshRules?.();
		}
		return result;
	});

	ipcMain.handle("findings:ignore", (_event, findingId) => manager.ignoreFinding(findingId));

	// Bulk sweeps -- never run automatically (see finding-lifecycle-manager.cjs's
	// own header); exposed here for an explicit "check now" affordance (and for
	// this WP's own tests/verification) exactly like patternMiner:runNow.
	ipcMain.handle("findings:resurfaceDue", () => manager.resurfaceDueFindings());

	ipcMain.handle("findings:sweepExpired", () => manager.sweepExpiredFindings());
}

module.exports = { register };
