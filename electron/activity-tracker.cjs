// WP-0.6: OS access (the PowerShell call this file used to make directly)
// now lives behind the platform adapter -- see electron/platform/win32.cjs
// for the script and electron/platform/unsupported.cjs for the non-Windows
// fallback this file must handle explicitly (D10).
const platform = require("./platform/index.cjs");

class ActivityTracker {
	// `eventLog` is optional (defaults to null) so this class stays usable
	// wherever it was constructed before the event log existed; when absent,
	// `recordFocus` below is a no-op.
	constructor(db, eventLog = null) {
		this.db = db;
		this.eventLog = eventLog;
		this.intervalId = null;
		this.currentAppName = "Unknown";
		this.currentSessionId = null;
		this.isSessionActive = false;
		this.isTickInProgress = false;
		// Tracks the last process name an `app.focus` event was recorded for, so
		// the event log gets one event per real app switch rather than one per
		// activity_blocks row (which also splits on window-title changes -- see
		// the comment in tick() below).
		this.lastFocusedProcessName = null;
	}

	start() {
		if (this.intervalId) {
			return;
		}

		this.intervalId = setInterval(() => {
			this.tick().catch((error) => {
				console.error("Activity tick error:", error);
			});
		}, 1500);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setCurrentSession(sessionId) {
		this.currentSessionId = sessionId;
		this.isSessionActive = true;
		// A new session is a fresh context for the event log even if the
		// foreground app happens to be the same as the previous session's --
		// without this reset, resuming the same app across a session boundary
		// would silently produce zero app.focus events for the new session.
		this.lastFocusedProcessName = null;
	}

	clearCurrentSession() {
		this.currentSessionId = null;
		this.isSessionActive = false;
		this.lastFocusedProcessName = null;
	}

	getCurrentAppName() {
		return this.currentAppName;
	}

	// *Which* process names count as "a shell, not a real foreground app" is
	// Windows-specific data (macOS's equivalent list would be entirely
	// different process names), so that list lives behind the platform
	// adapter alongside win32.cjs's other Windows-specific knowledge. This
	// method stays here, under this name, because *whether* an ignored
	// process should be excluded from activity tracking is Atlas tracking
	// policy, not an OS query -- the adapter only answers "is this a known
	// shell process name", it has no notion of activity blocks or sessions.
	isIgnoredProcess(processName) {
		return platform.isIgnoredProcessName(processName);
	}

	// Delegates to the platform adapter (WP-0.6) instead of spawning
	// PowerShell directly. Returns exactly what the adapter returns --
	// including the `supported` flag -- so tick() (below) can branch on it
	// explicitly rather than this method quietly turning "unsupported
	// platform" into some particular app name. That silent conversion is
	// the anti-pattern D10 calls out by name: this used to return the
	// literal string "Unknown" for any non-Windows platform, which reads
	// identically to a real window that is genuinely titled "Unknown".
	async getForegroundAppInfo() {
		return platform.getForegroundWindow();
	}

	async tick() {
		// Safeguard: if session is marked as inactive, do not track
		if (!this.isSessionActive || !this.currentSessionId) {
			return;
		}

		// Prevent concurrent tick operations
		if (this.isTickInProgress) {
			return;
		}

		this.isTickInProgress = true;

		try {
			const session = this.db.getSessionById(this.currentSessionId);
			if (!session || !session.is_active || session.is_paused) {
				return;
			}

			const appInfo = await this.getForegroundAppInfo();
			const now = new Date().toISOString();

			if (!appInfo.supported) {
				// D10: Windows only, for now. On any other platform the adapter is
				// honest that it has no foreground-window data at all -- do not
				// fabricate an app name (that would recreate the exact "Unknown"
				// ambiguity WP-0.6 removes) or bookkeep an activity block for data
				// we don't have. Just close whatever block a prior tick may have
				// left open, same as the ignored-process branch below.
				this.currentAppName = "Tracking unsupported on this platform";
				this.db.closeOpenActivityBlock(session.id, now);
				return;
			}

			if (this.isIgnoredProcess(appInfo.processName)) {
				this.currentAppName = "No tracked app";
				this.db.closeOpenActivityBlock(session.id, now);
				return;
			}

			const appName = appInfo.label;
			this.currentAppName = appName;
			const openBlock = this.db.getOpenActivityBlock(session.id);

			if (!openBlock) {
				this.db.createActivityBlock(session.id, appName, now);
			} else if (openBlock.app_name !== appName) {
				this.db.closeOpenActivityBlock(session.id, now);
				this.db.createActivityBlock(session.id, appName, now);
			}

			this.recordFocusChange(session, appInfo.processName);
		} finally {
			this.isTickInProgress = false;
		}
	}

	// Event-log signal for WP-0.5. Deliberately independent of the
	// activity_blocks bookkeeping above: `appName` there is `appInfo.label`,
	// which prefers the window *title* when one is present (see
	// getForegroundAppInfo), and title content is exactly what the event log
	// must never store. This only ever records `appInfo.processName` -- a
	// coarse app identity (e.g. "chrome", "Code") -- and only when it actually
	// changes, so re-titling the same app's window doesn't spam the log.
	recordFocusChange(session, processName) {
		const name = processName || "Unknown";
		if (name === this.lastFocusedProcessName) {
			return;
		}
		this.lastFocusedProcessName = name;
		this.eventLog?.record("app.focus", {
			environmentId: session.environment_id,
			sessionId: session.id,
			subject: name,
		});
	}

	closeOpenBlockNow(sessionId) {
		this.db.closeOpenActivityBlock(sessionId, new Date().toISOString());
	}
}

module.exports = {
	ActivityTracker,
};
