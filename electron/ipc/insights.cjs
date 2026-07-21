// ---------------------------------------------------------------------------
// Dashboard/insights IPC handlers (dashboard:overview, data:repairCorruptedSessions).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. Note
// that dashboard:getLayout / dashboard:setLayout are NOT here -- those are
// preference handlers (backed by dashboardPreferences, not the database), and
// live in electron/ipc/system.cjs alongside the other preference/system
// handlers. Only the two database-backed handlers below moved into this file.
//
// `getDb` is a getter rather than a plain value because `db` is assigned
// during app startup, after this module is required -- capturing it by value
// here would freeze it at `null` and break every handler.
//
// WP-0.8: `dashboard:overview` is exactly the cross-environment read the
// isolation model governs -- its `timePerEnvironment` breakdown aggregates
// every environment's sessions for today, not just the requesting one. It now
// goes through the scoped accessor (electron/data/scoped.cjs), which excludes
// any enclosed environment's contribution from that breakdown, and shows an
// enclosed requester only its own row. `getEventLog` is new here (previously
// this module only needed `getDb`) so that read can be recorded the same way
// every other cross-environment read is -- see scoped.cjs's
// `logCrossEnvironmentRead`. `data:repairCorruptedSessions` is a maintenance
// operation over every session in the database regardless of environment (it
// repairs timestamp corruption, it does not return session content to any
// caller) and is unaffected by the isolation model -- left exactly as it was.
// ---------------------------------------------------------------------------

const { scoped } = require("../data/scoped.cjs");

function register(ipcMain, deps) {
	const { getDb, getEventLog } = deps;

	ipcMain.handle("dashboard:overview", (_event, environmentId) => {
		if (!environmentId) {
			return {
				totalTodayMs: 0,
				timePerApp: [],
				timePerEnvironment: [],
				quickStats: { sessionsToday: 0, openTasks: 0 },
			};
		}
		return scoped(getDb(), environmentId, { eventLog: getEventLog?.() }).dashboardOverview();
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
