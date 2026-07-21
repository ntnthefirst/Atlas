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
//
// `getEventLog` is optional-shaped the same way, plus every call below uses
// `?.` on both the getter and the returned value: this file must keep working
// exactly as it did before WP-0.5 for any caller (e.g. a test harness) that
// doesn't wire an event log in.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getDb, getTracker, getMiniWindow, getEventLog } = deps;

	ipcMain.handle("session:active", () => getDb().getActiveSession());

	ipcMain.handle("session:start", (_event, environmentId) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}

		const session = getDb().startSession(environmentId);
		getTracker().setCurrentSession(session.id);
		getEventLog?.()?.record("session.start", { environmentId, sessionId: session.id });
		return session;
	});

	ipcMain.handle("session:pause", (_event, sessionId) => {
		// pauseSession() is a no-op that returns the session unchanged if it's
		// already paused (see db.cjs); check the prior state first so a
		// redundant pause call doesn't record a duplicate session.pause event.
		const wasAlreadyPaused = getDb().getSessionById(sessionId)?.is_paused === 1;
		const session = getDb().pauseSession(sessionId);
		getTracker().closeOpenBlockNow(sessionId);
		if (!wasAlreadyPaused) {
			getEventLog?.()?.record("session.pause", { environmentId: session.environment_id, sessionId });
		}
		return session;
	});

	ipcMain.handle("session:resume", (_event, sessionId) => {
		// Same reasoning as session:pause above -- resumeSession() no-ops if the
		// session isn't actually paused.
		const wasPaused = getDb().getSessionById(sessionId)?.is_paused === 1;
		const session = getDb().resumeSession(sessionId);
		if (wasPaused) {
			getEventLog?.()?.record("session.resume", { environmentId: session.environment_id, sessionId });
		}
		return session;
	});

	ipcMain.handle("session:stop", (_event, sessionId) => {
		// Same reasoning again -- stopSession() no-ops if the session is already
		// inactive. Read the prior state before any of the calls below mutate it.
		const wasActive = getDb().getSessionById(sessionId)?.is_active === 1;

		// Finalize the last activity block
		getTracker().closeOpenBlockNow(sessionId);

		// Immediately mark session as inactive in tracker to stop accepting new data
		// This must happen BEFORE db.stopSession to prevent race conditions
		if (getTracker().currentSessionId === sessionId) {
			getTracker().clearCurrentSession();
		}

		// Mark session as ended in database
		const session = getDb().stopSession(sessionId);
		if (wasActive) {
			getEventLog?.()?.record("session.stop", { environmentId: session.environment_id, sessionId });
		}

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
