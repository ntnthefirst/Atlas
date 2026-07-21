import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../db.cjs";
import { register } from "./tasks.cjs";

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-tasks-ipc-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function createFakeIpcMain() {
	const handlers = new Map();
	return {
		handle(channel, fn) {
			handlers.set(channel, fn);
		},
		invoke(channel, ...args) {
			const fn = handlers.get(channel);
			if (!fn) {
				throw new Error(`no handler registered for ${channel}`);
			}
			return fn({}, ...args);
		},
	};
}

async function setup() {
	const db = await AtlasDatabase.create(createTempDbPath());
	const environment = db.createEnvironment("Test env");
	const eventLog = { record: vi.fn() };
	const ipcMain = createFakeIpcMain();
	register(ipcMain, { getDb: () => db, getEventLog: () => eventLog });
	return { db, environment, eventLog, ipcMain };
}

describe("task IPC handlers — event log recording (WP-0.5)", () => {
	it("records task.create with the task id as subject, never the title", async () => {
		const { environment, eventLog, ipcMain } = await setup();

		const task = ipcMain.invoke("task:create", environment.id, "My secret project title", "some description", {});

		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("task.create", {
			environmentId: environment.id,
			subject: task.id,
		});
		// The privacy claim, made explicit: nothing about title/description ever
		// reaches the recorded call.
		const recordedArgs = eventLog.record.mock.calls[0];
		expect(JSON.stringify(recordedArgs)).not.toContain("secret project title");
		expect(JSON.stringify(recordedArgs)).not.toContain("some description");
	});

	it("records task.complete via task:updateStatus only on the transition into done", async () => {
		const { environment, eventLog, ipcMain } = await setup();
		const task = ipcMain.invoke("task:create", environment.id, "Task", "", {});
		eventLog.record.mockClear();

		ipcMain.invoke("task:updateStatus", task.id, "in-progress");
		expect(eventLog.record).not.toHaveBeenCalled();

		ipcMain.invoke("task:updateStatus", task.id, "done");
		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("task.complete", {
			environmentId: environment.id,
			subject: task.id,
		});

		// Calling done->done again must not double-record.
		eventLog.record.mockClear();
		ipcMain.invoke("task:updateStatus", task.id, "done");
		expect(eventLog.record).not.toHaveBeenCalled();
	});

	it("records task.complete via the generic task:update path too, on the same transition rule", async () => {
		const { environment, eventLog, ipcMain } = await setup();
		const task = ipcMain.invoke("task:create", environment.id, "Task", "", {});
		eventLog.record.mockClear();

		ipcMain.invoke("task:update", task.id, { description: "edited, still not done" });
		expect(eventLog.record).not.toHaveBeenCalled();

		ipcMain.invoke("task:update", task.id, { status: "done" });
		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("task.complete", {
			environmentId: environment.id,
			subject: task.id,
		});
	});

	it("never throws when no event log getter is supplied at all", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Test env");
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db });

		expect(() => ipcMain.invoke("task:create", environment.id, "Task", "", {})).not.toThrow();
	});
});
