// ---------------------------------------------------------------------------
// Focus mode IPC handlers (focus:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. The
// focus engine itself (the 1s heartbeat timer, phase transitions, nudges,
// persistence) now lives in electron/services/focus-engine.cjs (also WP-0.2)
// -- only the IPC handler registrations that call into it are here. main.cjs
// still assembles this module's `deps` in wireIpc(), same as every other
// ipc/*.cjs module; only the *source* of the values changed, from main.cjs's
// own local functions to focus-engine.cjs's exports. Every handler below is a
// thin call-through to a plain exported function (`rollFocusStatsIfNeeded`,
// `startFocus`, `pauseFocus`, `resumeFocus`, `advanceFocusPhase`, `stopFocus`,
// `setFocusGoal`, `updateFocusConfig`), none of which are ever reassigned, so
// they're passed as plain values.
//
// `getFocusState` IS a getter, though: focus-engine.cjs's internal
// `focusState` is a `let` it reassigns wholesale in `loadFocusPreferences()`
// (called during app.whenReady(), after this module is required) -- a value
// capture here would freeze this module onto the pre-load placeholder state
// forever, so `focus:getState` and `focus:skip` (which reads
// `focusState.runtime` to decide whether there's anything to skip) both call
// the getter fresh.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const {
		getFocusState,
		rollFocusStatsIfNeeded,
		startFocus,
		pauseFocus,
		resumeFocus,
		advanceFocusPhase,
		stopFocus,
		setFocusGoal,
		updateFocusConfig,
	} = deps;

	ipcMain.handle("focus:getState", () => {
		rollFocusStatsIfNeeded();
		return getFocusState();
	});
	ipcMain.handle("focus:start", (_event, goal) => startFocus(goal));
	ipcMain.handle("focus:pause", () => pauseFocus());
	ipcMain.handle("focus:resume", () => resumeFocus());
	ipcMain.handle("focus:skip", () => {
		if (getFocusState().runtime) advanceFocusPhase(true);
		return getFocusState();
	});
	ipcMain.handle("focus:stop", () => stopFocus());
	ipcMain.handle("focus:setGoal", (_event, goal) => setFocusGoal(goal));
	ipcMain.handle("focus:setConfig", (_event, patch) => updateFocusConfig(patch));
}

module.exports = { register };
