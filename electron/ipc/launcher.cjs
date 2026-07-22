// ---------------------------------------------------------------------------
// Launcher IPC handlers (launcher:*) (WP-2.1).
//
// The input surface and result-list SHELL only -- `search`/`execute` are the
// WP-2.2 seam (see electron/services/launcher-providers.cjs's header) handed
// in as plain function values, exactly like `applyNotchPreferences` elsewhere:
// both are `function` declarations that are never reassigned, so there's no
// stale-capture risk in holding onto them directly.
//
// `getEventLog` and `getCurrentEnvironmentId` are getters for the usual
// reason -- `eventLog` and `currentEnvironmentId` are `let`s main.cjs
// reassigns after this module is required (eventLog once, at boot;
// currentEnvironmentId on every environment switch) -- a value capture here
// would freeze onto whatever they were at require time (null/undefined).
//
// `hideLauncherWindow` is a plain value (a `function` declaration in
// main.cjs, never reassigned) -- what Esc and a modifier-execute both use to
// dismiss the launcher without destroying the pre-created window (see
// electron/windows/launcher-window.cjs's header for why it's hidden, not
// closed).
//
// `onOpenLatencyReported` is OPTIONAL and only supplied by main.cjs when
// running under ATLAS_LAUNCHER_SELFCHECK -- see main.cjs's
// `runLauncherSelfCheck()`. In normal operation it's undefined and the
// handler below just logs/records like any other event.
//
// `launcher:query` records `launcher.query` with the raw query STRING as the
// event's subject. Storing the literal text here (rather than just a count)
// is a deliberate exception to the event log's usual "coarse action types
// only" discipline (see services/event-log.cjs's header) -- this is
// user-initiated launcher input the user typed to search their OWN data, not
// passive background tracking, and the miner (Phase 3) needs the actual text
// to learn anything useful from it.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const {
		getBinding,
		setBinding,
		search,
		execute,
		hideLauncherWindow,
		getEventLog,
		getCurrentEnvironmentId,
		onOpenLatencyReported,
	} = deps;

	ipcMain.handle("launcher:getHotkeyBinding", () => getBinding());

	ipcMain.handle("launcher:setHotkeyBinding", (_event, accelerator) => setBinding(accelerator));

	ipcMain.handle("launcher:query", async (_event, query) => {
		const environmentId = getCurrentEnvironmentId?.() ?? null;
		const results = (await search(query, { environmentId })) ?? [];
		getEventLog?.()?.record("launcher.query", { environmentId, subject: query, payload: { resultCount: results.length } });
		return results;
	});

	ipcMain.handle("launcher:execute", async (_event, resultId, modifier) => {
		const environmentId = getCurrentEnvironmentId?.() ?? null;
		const result = await execute(resultId, { environmentId, modifier: modifier ?? null });
		getEventLog?.()?.record("launcher.execute", { environmentId, subject: resultId, payload: { modifier: modifier ?? null } });
		return result;
	});

	// Reports the hotkey-fire -> renderer-first-paint latency the renderer
	// measures for itself (see src/components/launcher/LauncherWindowApp.tsx).
	// Logged unconditionally so the number is visible in a plain console/log
	// tail; `onOpenLatencyReported` additionally lets the ATLAS_LAUNCHER_SELFCHECK
	// boot path (main.cjs) observe it and exit.
	ipcMain.handle("launcher:reportOpenLatency", (_event, latencyMs) => {
		const roundedMs = Math.round(Number(latencyMs) || 0);
		console.log(`[Atlas] Launcher opened in ${roundedMs}ms (hotkey -> renderer first paint).`);
		getEventLog?.()?.record("launcher.opened", { payload: { latencyMs: roundedMs } });
		onOpenLatencyReported?.(roundedMs);
		return true;
	});

	ipcMain.handle("launcher:hide", () => {
		hideLauncherWindow();
		return true;
	});
}

module.exports = { register };
