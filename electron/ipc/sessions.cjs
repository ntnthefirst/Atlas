// ---------------------------------------------------------------------------
// Session IPC handlers (session:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. These
// are the most side-effect-heavy handlers in the app: they drive the activity
// tracker (setCurrentSession/clearCurrentSession/closeOpenBlockNow) alongside
// the database, and session:stop also closes the mini window. Every side
// effect below runs in the exact same order it did in main.cjs.
//
// `getDb` and `getTracker` are getters rather than plain values because `db`
// and `tracker` are both assigned during app startup, after this module is
// required -- capturing either by value here would freeze it at `null` and
// break every handler. `getMiniWindow` is a getter for the same reason: unlike
// `openPrimaryWindowByEnvironmentState` (a `function` declaration that's
// never reassigned), `miniWindow` is a `let` binding that main.cjs reassigns
// throughout the window's lifecycle (created, closed, destroyed), so holding
// a value captured at require time would go stale.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getDb, getTracker, getMiniWindow } = deps;

	ipcMain.handle("session:active", () => getDb().getActiveSession());

	ipcMain.handle("session:start", (_event, environmentId) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}

		const session = getDb().startSession(environmentId);
		getTracker().setCurrentSession(session.id);
		return session;
	});

	ipcMain.handle("session:pause", (_event, sessionId) => {
		const session = getDb().pauseSession(sessionId);
		getTracker().closeOpenBlockNow(sessionId);
		return session;
	});

	ipcMain.handle("session:resume", (_event, sessionId) => getDb().resumeSession(sessionId));

	ipcMain.handle("session:stop", (_event, sessionId) => {
		// Finalize the last activity block
		getTracker().closeOpenBlockNow(sessionId);

		// Immediately mark session as inactive in tracker to stop accepting new data
		// This must happen BEFORE db.stopSession to prevent race conditions
		if (getTracker().currentSessionId === sessionId) {
			getTracker().clearCurrentSession();
		}

		// Mark session as ended in database
		const session = getDb().stopSession(sessionId);

		// Close mini window if open
		if (getMiniWindow() && !getMiniWindow().isDestroyed()) {
			getMiniWindow().close();
		}

		return session;
	});

	ipcMain.handle("session:listByEnvironment", (_event, environmentId) => {
		if (!environmentId) {
			return [];
		}
		return getDb().listSessionsByEnvironment(environmentId);
	});

	ipcMain.handle("session:delete", (_event, sessionId) => {
		if (!sessionId) {
			throw new Error("Session id missing.");
		}
		return getDb().deleteSession(sessionId);
	});
}

module.exports = { register };
