// ---------------------------------------------------------------------------
// Dashboard/insights IPC handlers (dashboard:overview, data:repairCorruptedSessions).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. Note
// that dashboard:getLayout / dashboard:setLayout are NOT here -- those are
// preference handlers (backed by dashboardPreferences, not the database) and
// stay in main.cjs alongside the other preference handlers. Only the two
// database-backed handlers below moved.
//
// `getDb` is a getter rather than a plain value because `db` is assigned
// during app startup, after this module is required -- capturing it by value
// here would freeze it at `null` and break every handler.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getDb } = deps;

	ipcMain.handle("dashboard:overview", (_event, environmentId) => {
		if (!environmentId) {
			return {
				totalTodayMs: 0,
				timePerApp: [],
				timePerEnvironment: [],
				quickStats: { sessionsToday: 0, openTasks: 0 },
			};
		}
		return getDb().getDashboardOverview(environmentId);
	});

	ipcMain.handle("data:repairCorruptedSessions", () => {
		console.log("[Atlas] Starting repair of corrupted session data...");
		const results = getDb().repairCorruptedSessions();
		console.log(
			`[Atlas] Repair complete: ${results.sessionsRepaired} sessions checked, ${results.blocksNormalized} blocks normalized.`,
		);
		return results;
	});
}

module.exports = { register };
