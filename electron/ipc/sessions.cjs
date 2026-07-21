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
//
// WP-0.8 routes every database call below through the scoped accessor
// (electron/data/scoped.cjs) instead of calling `getDb()` methods directly.
// `session:pause/resume/stop/delete` take only a session id, no environment
// id -- see scoped.cjs's file header for why `scoped.forSession` resolving
// the scope from the session's own row is the correct (and only available)
// scoping for those channels. `session:active` is the one documented
// exception -- see `scoped.getGlobalActiveSession`'s comment in scoped.cjs
// for why it is not (and, given its channel shape, cannot be) scoped to an
// environment at all.
// ---------------------------------------------------------------------------

const { scoped } = require("../data/scoped.cjs");

function register(ipcMain, deps) {
	const { getDb, getTracker, getMiniWindow, getEventLog } = deps;

	ipcMain.handle("session:active", () => scoped.getGlobalActiveSession(getDb()));

	ipcMain.handle("session:start", (_event, environmentId) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}

		const session = scoped(getDb(), environmentId).sessions.start();
		getTracker().setCurrentSession(session.id);
		getEventLog?.()?.record("session.start", { environmentId, sessionId: session.id });
		return session;
	});

	ipcMain.handle("session:pause", (_event, sessionId) => {
		const scope = scoped.forSession(getDb(), sessionId);
		if (!scope) {
			throw new Error("No active session found to pause.");
		}
		// pauseSession() is a no-op that returns the session unchanged if it's
		// already paused (see db.cjs); check the prior state first so a
		// redundant pause call doesn't record a duplicate session.pause event.
		const wasAlreadyPaused = scope.sessions.get(sessionId)?.is_paused === 1;
		const session = scope.sessions.pause(sessionId);
		getTracker().closeOpenBlockNow(sessionId);
		if (!wasAlreadyPaused) {
			getEventLog?.()?.record("session.pause", { environmentId: session.environment_id, sessionId });
		}
		return session;
	});

	ipcMain.handle("session:resume", (_event, sessionId) => {
		const scope = scoped.forSession(getDb(), sessionId);
		if (!scope) {
			throw new Error("No active session found to resume.");
		}
		// Same reasoning as session:pause above -- resumeSession() no-ops if the
		// session isn't actually paused.
		const wasPaused = scope.sessions.get(sessionId)?.is_paused === 1;
		const session = scope.sessions.resume(sessionId);
		if (wasPaused) {
			getEventLog?.()?.record("session.resume", { environmentId: session.environment_id, sessionId });
		}
		return session;
	});

	ipcMain.handle("session:stop", (_event, sessionId) => {
		const scope = scoped.forSession(getDb(), sessionId);
		if (!scope) {
			throw new Error("No active session found to stop.");
		}
		// Same reasoning again -- stopSession() no-ops if the session is already
		// inactive. Read the prior state before any of the calls below mutate it.
		const wasActive = scope.sessions.get(sessionId)?.is_active === 1;

		// Finalize the last activity block
		getTracker().closeOpenBlockNow(sessionId);

		// Immediately mark session as inactive in tracker to stop accepting new data
		// This must happen BEFORE db.stopSession to prevent race conditions
		if (getTracker().currentSessionId === sessionId) {
			getTracker().clearCurrentSession();
		}

		// Mark session as ended in database
		const session = scope.sessions.stop(sessionId);
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
		return scoped(getDb(), environmentId).sessions.list();
	});

	ipcMain.handle("session:delete", (_event, sessionId) => {
		if (!sessionId) {
			throw new Error("Session id missing.");
		}
		const scope = scoped.forSession(getDb(), sessionId);
		if (!scope) {
			throw new Error("Session not found.");
		}
		return scope.sessions.delete(sessionId);
	});
}

module.exports = { register };
