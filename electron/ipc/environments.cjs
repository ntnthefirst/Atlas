// ---------------------------------------------------------------------------
// Environment (map) IPC handlers (map:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. Most
// of these are thin passthroughs to the database, but map:create and
// map:delete also re-derive which top-level window should be showing (main vs
// welcome) once the set of maps changes -- `openPrimaryWindowByMapState` is
// passed in to preserve that side effect exactly, in the same order as
// before.
//
// `getDb` is a getter rather than a plain value because `db` is assigned
// during app startup, after this module is required -- capturing it by value
// here would freeze it at `null` and break every handler. `openPrimaryWindowByMapState`
// is passed as a plain function reference instead: it's a `function`
// declaration in main.cjs that is never reassigned, so unlike `db` there is
// no stale-capture risk in holding onto it directly.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getDb, openPrimaryWindowByMapState } = deps;

	ipcMain.handle("map:list", () => getDb().listMaps());

	ipcMain.handle("map:create", (_event, name, options = {}) => {
		if (!name || !name.trim()) {
			throw new Error("Environment name is required.");
		}
		const createdMap = getDb().createMap(name.trim(), {
			icon: options?.icon ?? null,
			accent: options?.accent ?? null,
			preset: options?.preset ?? null,
		});
		openPrimaryWindowByMapState();
		return createdMap;
	});

	ipcMain.handle("map:rename", (_event, mapId, name) => {
		if (!mapId) {
			throw new Error("Environment id missing.");
		}
		if (!name || !name.trim()) {
			throw new Error("Environment name is required.");
		}
		return getDb().renameMap(mapId, name.trim());
	});

	ipcMain.handle("map:update", (_event, mapId, fields = {}) => {
		if (!mapId) {
			throw new Error("Environment id missing.");
		}
		const sanitized = {};
		if (typeof fields?.name === "string" && fields.name.trim()) sanitized.name = fields.name.trim();
		if (typeof fields?.icon === "string" || fields?.icon === null) sanitized.icon = fields.icon;
		if (typeof fields?.accent === "string" || fields?.accent === null) sanitized.accent = fields.accent;
		if (typeof fields?.preset === "string" || fields?.preset === null) sanitized.preset = fields.preset;
		return getDb().updateMap(mapId, sanitized);
	});

	ipcMain.handle("map:delete", (_event, mapId) => {
		if (!mapId) {
			throw new Error("Map id missing.");
		}
		const deleted = getDb().deleteMap(mapId);
		openPrimaryWindowByMapState();
		return deleted;
	});
}

module.exports = { register };
