// ---------------------------------------------------------------------------
// Task IPC handlers (task:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. Every
// handler here is a thin passthrough to the database, so the only dependency
// is `db` itself. `getDb` is a getter rather than a plain value because `db`
// is assigned during app startup, after this module is required -- capturing
// it by value here would freeze it at `null` and break every handler.
//
// WP-0.5 adds `getEventLog` (same optional-getter shape) to record
// `task.create`/`task.complete`. Only the task id is ever recorded as
// `subject` -- never the title or description, which is exactly the body
// text the event log must never store.
//
// WP-0.8 routes every database call below through the scoped accessor
// (electron/data/scoped.cjs) instead of calling `getDb()` methods directly.
// `task:updateStatus`/`task:update`/`task:delete` take only a task id, no
// environment id -- see scoped.cjs's file header for why `scoped.forTask`
// resolving the scope from the task's own row is the correct (and only
// available) scoping for those three channels.
// ---------------------------------------------------------------------------

const { scoped } = require("../data/scoped.cjs");

function register(ipcMain, deps) {
	const { getDb, getEventLog } = deps;

	ipcMain.handle("task:listByEnvironment", (_event, environmentId) => {
		if (!environmentId) {
			return [];
		}
		return scoped(getDb(), environmentId).tasks.list();
	});

	ipcMain.handle("task:create", (_event, environmentId, title, description, fields) => {
		if (!environmentId || !title || !title.trim()) {
			throw new Error("Task environment and title are required.");
		}
		const task = scoped(getDb(), environmentId).tasks.create(
			title.trim(),
			(description || "").trim(),
			fields || {},
		);
		getEventLog?.()?.record("task.create", { environmentId, subject: task.id });
		return task;
	});

	ipcMain.handle("task:updateStatus", (_event, taskId, status) => {
		if (!taskId || !status) {
			throw new Error("Task id and status are required.");
		}
		const scope = scoped.forTask(getDb(), taskId);
		if (!scope) {
			return null;
		}
		// Read the prior status so task.complete fires once, on the transition
		// into "done" -- not on every subsequent edit of an already-done task.
		const previousStatus = scope.tasks.get(taskId)?.status;
		const task = scope.tasks.updateStatus(taskId, status);
		if (task && status === "done" && previousStatus !== "done") {
			getEventLog?.()?.record("task.complete", { environmentId: task.environment_id, subject: taskId });
		}
		return task;
	});

	ipcMain.handle("task:update", (_event, taskId, fields) => {
		if (!taskId || !fields || typeof fields !== "object") {
			throw new Error("Task id and fields are required.");
		}
		const scope = scoped.forTask(getDb(), taskId);
		if (!scope) {
			return null;
		}
		const previousStatus = scope.tasks.get(taskId)?.status;
		const task = scope.tasks.update(taskId, fields);
		if (task && task.status === "done" && previousStatus !== "done") {
			getEventLog?.()?.record("task.complete", { environmentId: task.environment_id, subject: taskId });
		}
		return task;
	});

	ipcMain.handle("task:delete", (_event, taskId) => {
		if (!taskId) {
			throw new Error("Task id is required.");
		}
		const scope = scoped.forTask(getDb(), taskId);
		if (!scope) {
			return false;
		}
		return scope.tasks.delete(taskId);
	});
}

module.exports = { register };
