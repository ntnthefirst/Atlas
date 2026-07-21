// ---------------------------------------------------------------------------
// Environment IPC handlers (environment:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. Most
// of these are thin passthroughs to the database, but environment:create and
// environment:delete also re-derive which top-level window should be showing
// (main vs welcome) once the set of environments changes --
// `openPrimaryWindowByEnvironmentState` is passed in to preserve that side
// effect exactly, in the same order as before.
//
// `getDb` is a getter rather than a plain value because `db` is assigned
// during app startup, after this module is required -- capturing it by value
// here would freeze it at `null` and break every handler.
// `openPrimaryWindowByEnvironmentState` is passed as a plain function
// reference instead: it's a `function` declaration in main.cjs that is never
// reassigned, so unlike `db` there is no stale-capture risk in holding onto
// it directly.
//
// `environment:switch` (WP-0.5) is new, not extracted: environment selection
// is renderer-only local state (see App.tsx's "remember the active
// environment" effect) with no prior main-process signal at all, so there was
// no existing call site to hang the event log off of for it. Originally a
// pure fire-and-forget notification that fed only the event log.
//
// WP-1.3 gives it a second job: it is now also main.cjs's one authoritative
// signal for "which environment is active", which per-environment Notch
// layout resolution needs (electron/config/notch-layouts.cjs) and Electron
// alone has no other way to learn -- the renderer keeps this in
// localStorage (`atlas.lastEnvironmentId`), shared across windows, but the
// main process cannot read a renderer's localStorage. `setActiveEnvironment`
// (main.cjs) records the id, resolves that environment's effective Notch
// layout (its own override, or the global default), and re-renders every
// notch window immediately -- see main.cjs's setActiveEnvironment/
// refreshActiveNotchPreferences and windows/notch-windows.cjs's
// renderNotchPreferences. Called from both App.tsx's own switcher and the
// Notch's (NotchApp.tsx's onSwitchEnvironment), so switching from either
// place re-renders the Notch with no restart.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getDb, openPrimaryWindowByEnvironmentState, getEventLog, setActiveEnvironment } = deps;

	ipcMain.handle("environment:list", () => getDb().listEnvironments());

	ipcMain.handle("environment:create", (_event, name, options = {}) => {
		if (!name || !name.trim()) {
			throw new Error("Environment name is required.");
		}
		const createdEnvironment = getDb().createEnvironment(name.trim(), {
			icon: options?.icon ?? null,
			accent: options?.accent ?? null,
			preset: options?.preset ?? null,
		});
		openPrimaryWindowByEnvironmentState();
		return createdEnvironment;
	});

	ipcMain.handle("environment:rename", (_event, environmentId, name) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}
		if (!name || !name.trim()) {
			throw new Error("Environment name is required.");
		}
		return getDb().renameEnvironment(environmentId, name.trim());
	});

	ipcMain.handle("environment:update", (_event, environmentId, fields = {}) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}
		const sanitized = {};
		if (typeof fields?.name === "string" && fields.name.trim()) sanitized.name = fields.name.trim();
		if (typeof fields?.icon === "string" || fields?.icon === null) sanitized.icon = fields.icon;
		if (typeof fields?.accent === "string" || fields?.accent === null) sanitized.accent = fields.accent;
		if (typeof fields?.preset === "string" || fields?.preset === null) sanitized.preset = fields.preset;
		return getDb().updateEnvironment(environmentId, sanitized);
	});

	ipcMain.handle("environment:delete", (_event, environmentId) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}
		const deleted = getDb().deleteEnvironment(environmentId);
		openPrimaryWindowByEnvironmentState();
		return deleted;
	});

	ipcMain.handle("environment:switch", (_event, environmentId) => {
		if (!environmentId) {
			return false;
		}
		getEventLog?.()?.record("environment.switch", { environmentId });
		// WP-1.3: live-switching -- resolves and applies this environment's
		// effective Notch layout (own override, or the global default) and
		// re-renders every notch window immediately.
		setActiveEnvironment?.(environmentId);
		return true;
	});

	// WP-1.1: the environment configuration document (appearance, Notch
	// layout reference, AI defaults, integration enablement, startup
	// behaviour). Not routed through electron/data/scoped.cjs -- that
	// accessor exists to gate CROSS-environment reads of tasks/notes/
	// sessions/events (see its file header), and a config read/write is
	// always addressed by its own environment id, exactly like
	// environment:update above. There is no "am I allowed to see this" policy
	// question here, only "does this environment exist" -- the same shape
	// db.cjs's methods already enforce.
	ipcMain.handle("environment:getConfig", (_event, environmentId) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}
		return getDb().getEnvironmentConfig(environmentId);
	});

	ipcMain.handle("environment:setConfig", (_event, environmentId, patch = {}) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}
		return getDb().setEnvironmentConfig(environmentId, patch ?? {});
	});

	// WP-1.2 (isolation enforcement UI): the one write path for an
	// environment's isolation mode. Deliberately its own channel, not folded
	// into environment:update -- flipping this is never an incidental field
	// edit alongside a rename or a new accent, it is THE decision this whole
	// WP exists to make visible, so it gets its own named, logged transition
	// rather than disappearing into a generic "fields" bag. `setEnvironmentIsolationMode`
	// validates the mode itself (throws on anything but "connected"/"enclosed")
	// and takes effect on the very next scoped(...) call -- see
	// electron/data/scoped.cjs, which reads this column fresh per call rather
	// than caching it, so there is no restart and no stale in-memory copy to
	// invalidate.
	ipcMain.handle("environment:setIsolationMode", (_event, environmentId, mode) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}
		getDb().setEnvironmentIsolationMode(environmentId, mode);
		// `subject` (not `payload`) carries the new mode -- event-log.cjs#record
		// only persists {environmentId, subject, payload, sessionId}, and a short
		// identifier like the mode itself is exactly what `subject` is for (see
		// scoped.cjs's own cross-environment-read logging for the same pattern).
		getEventLog?.()?.record("environment.isolation_mode_changed", { environmentId, subject: mode });
		return getDb().getEnvironment(environmentId);
	});
}

module.exports = { register };
