// ---------------------------------------------------------------------------
// Note and notebook IPC handlers (note:*, notebook:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. Every
// handler here is a thin passthrough to the database, so the only dependency
// is `db` itself. `getDb` is a getter rather than a plain value because `db`
// is assigned during app startup, after this module is required -- capturing
// it by value here would freeze it at `null` and break every handler.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getDb } = deps;

	ipcMain.handle("note:listByEnvironment", (_event, environmentId) => {
		if (!environmentId) {
			return [];
		}
		return getDb().listNotesByEnvironment(environmentId);
	});

	ipcMain.handle("note:create", (_event, environmentId, content) => {
		if (!environmentId) {
			throw new Error("Environment id is required.");
		}
		return getDb().createNote(environmentId, (content || "").trim());
	});

	ipcMain.handle("note:update", (_event, noteId, content) => {
		if (!noteId) {
			throw new Error("Note id is required.");
		}
		return getDb().updateNote(noteId, content || "");
	});

	ipcMain.handle("note:delete", (_event, noteId) => {
		if (!noteId) {
			throw new Error("Note id is required.");
		}
		getDb().deleteNote(noteId);
		return true;
	});

	ipcMain.handle("notebook:getByEnvironment", (_event, environmentId) => {
		if (!environmentId) {
			throw new Error("Environment id is required.");
		}
		return getDb().getNotebookByEnvironment(environmentId);
	});

	ipcMain.handle("notebook:updateByEnvironment", (_event, environmentId, content) => {
		if (!environmentId) {
			throw new Error("Environment id is required.");
		}
		if (typeof content !== "string") {
			throw new Error("Notebook content must be a string.");
		}
		return getDb().updateNotebookByEnvironment(environmentId, content);
	});
}

module.exports = { register };
