// ---------------------------------------------------------------------------
// Activity IPC handlers (activity:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. Every
// handler here is a thin passthrough to the database or the activity tracker.
//
// `getDb` and `getTracker` are getters rather than plain values because `db`
// and `tracker` are both assigned during app startup, after this module is
// required -- capturing either by value here would freeze it at `null` and
// break every handler.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getDb, getTracker } = deps;

	ipcMain.handle("activity:listBySession", (_event, sessionId) => {
		if (!sessionId) {
			return [];
		}
		return getDb().listActivityBlocksBySession(sessionId);
	});

	ipcMain.handle("activity:current-app", () => getTracker().getCurrentAppName());
}

module.exports = { register };
