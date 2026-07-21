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
//
// WP-0.8 routes `activity:listBySession` through the scoped accessor
// (electron/data/scoped.cjs): activity blocks belong to a session, which
// belongs to an environment, so `scoped.forSession` resolves the owning
// environment from the session id before the blocks are read. `getTracker`
// calls are unaffected -- the current foreground app name isn't stored data
// scoped to an environment at all.
// ---------------------------------------------------------------------------

const { scoped } = require("../data/scoped.cjs");

function register(ipcMain, deps) {
	const { getDb, getTracker } = deps;

	ipcMain.handle("activity:listBySession", (_event, sessionId) => {
		if (!sessionId) {
			return [];
		}
		const scope = scoped.forSession(getDb(), sessionId);
		if (!scope) {
			return [];
		}
		return scope.sessions.listActivityBlocks(sessionId);
	});

	ipcMain.handle("activity:current-app", () => getTracker().getCurrentAppName());
}

module.exports = { register };
