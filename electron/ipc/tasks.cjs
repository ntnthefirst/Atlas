// ---------------------------------------------------------------------------
// Task IPC handlers (task:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. Every
// handler here is a thin passthrough to the database, so the only dependency
// is `db` itself. `getDb` is a getter rather than a plain value because `db`
// is assigned during app startup, after this module is required -- capturing
// it by value here would freeze it at `null` and break every handler.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getDb } = deps;

	ipcMain.handle("task:listByEnvironment", (_event, environmentId) => {
		if (!environmentId) {
			return [];
		}
		return getDb().listTasksByEnvironment(environmentId);
	});

	ipcMain.handle("task:create", (_event, environmentId, title, description, fields) => {
		if (!environmentId || !title || !title.trim()) {
			throw new Error("Task environment and title are required.");
		}
		return getDb().createTask(environmentId, title.trim(), (description || "").trim(), fields || {});
	});

	ipcMain.handle("task:updateStatus", (_event, taskId, status) => {
		if (!taskId || !status) {
			throw new Error("Task id and status are required.");
		}
		return getDb().updateTaskStatus(taskId, status);
	});

	ipcMain.handle("task:update", (_event, taskId, fields) => {
		if (!taskId || !fields || typeof fields !== "object") {
			throw new Error("Task id and fields are required.");
		}
		return getDb().updateTask(taskId, fields);
	});

	ipcMain.handle("task:delete", (_event, taskId) => {
		if (!taskId) {
			throw new Error("Task id is required.");
		}
		return getDb().deleteTask(taskId);
	});
}

module.exports = { register };
