// ---------------------------------------------------------------------------
// Note and notebook IPC handlers (note:*, notebook:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. Every
// handler here is a thin passthrough to the database, so the only dependency
// is `db` itself. `getDb` is a getter rather than a plain value because `db`
// is assigned during app startup, after this module is required -- capturing
// it by value here would freeze it at `null` and break every handler.
//
// WP-0.5 adds `getEventLog` (same optional-getter shape) to record
// `note.create`. Only the note id is ever recorded as `subject` -- never
// `content`, which is exactly the body text the event log must never store.
//
// WP-0.8 routes every database call below through the scoped accessor
// (electron/data/scoped.cjs) instead of calling `getDb()` methods directly.
// `note:update`/`note:delete` take only a note id, no environment id -- see
// scoped.cjs's file header for why `scoped.forNote` resolving the scope from
// the note's own row is the correct (and only available) scoping for those
// two channels.
// ---------------------------------------------------------------------------

const { scoped } = require("../data/scoped.cjs");

function register(ipcMain, deps) {
	const { getDb, getEventLog } = deps;

	ipcMain.handle("note:listByEnvironment", (_event, environmentId) => {
		if (!environmentId) {
			return [];
		}
		return scoped(getDb(), environmentId).notes.list();
	});

	ipcMain.handle("note:create", (_event, environmentId, content) => {
		if (!environmentId) {
			throw new Error("Environment id is required.");
		}
		const note = scoped(getDb(), environmentId).notes.create((content || "").trim());
		getEventLog?.()?.record("note.create", { environmentId, subject: note.id });
		return note;
	});

	ipcMain.handle("note:update", (_event, noteId, content) => {
		if (!noteId) {
			throw new Error("Note id is required.");
		}
		const scope = scoped.forNote(getDb(), noteId);
		if (!scope) {
			return null;
		}
		return scope.notes.update(noteId, content || "");
	});

	ipcMain.handle("note:delete", (_event, noteId) => {
		if (!noteId) {
			throw new Error("Note id is required.");
		}
		const scope = scoped.forNote(getDb(), noteId);
		scope?.notes.delete(noteId);
		return true;
	});

	ipcMain.handle("notebook:getByEnvironment", (_event, environmentId) => {
		if (!environmentId) {
			throw new Error("Environment id is required.");
		}
		return scoped(getDb(), environmentId).notes.getNotebook();
	});

	ipcMain.handle("notebook:updateByEnvironment", (_event, environmentId, content) => {
		if (!environmentId) {
			throw new Error("Environment id is required.");
		}
		if (typeof content !== "string") {
			throw new Error("Notebook content must be a string.");
		}
		return scoped(getDb(), environmentId).notes.updateNotebook(content);
	});
}

module.exports = { register };
