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
// no existing call site to hang the event log off of for it. This channel is
// a fire-and-forget notification that exists purely to feed the event log --
// it has no other side effect and changes no existing behaviour.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getDb, openPrimaryWindowByEnvironmentState, getEventLog } = deps;

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
		return true;
	});
}

module.exports = { register };
