import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../db.cjs";
import { register } from "./sessions.cjs";

// This suite is ESM (the package is `type: module`) even though the modules
// under test are CommonJS -- same reasoning as db.test.js.

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sessions-ipc-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// A minimal stand-in for Electron's ipcMain: captures handlers by channel and
// lets tests invoke them synchronously, the same shape ipc-contract.test.js
// assumes (`ipcMain.handle(channel, listener)`).
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

function createFakeTracker() {
	return {
		currentSessionId: null,
		setCurrentSession(id) {
			this.currentSessionId = id;
		},
		clearCurrentSession() {
			this.currentSessionId = null;
		},
		closeOpenBlockNow() {},
	};
}

async function setup() {
	const db = await AtlasDatabase.create(createTempDbPath());
	const environment = db.createEnvironment("Test env");
	const tracker = createFakeTracker();
	const eventLog = { record: vi.fn() };
	const ipcMain = createFakeIpcMain();
	register(ipcMain, {
		getDb: () => db,
		getTracker: () => tracker,
		getMiniWindow: () => null,
		getEventLog: () => eventLog,
	});
	return { db, environment, tracker, eventLog, ipcMain };
}

describe("session IPC handlers — event log recording (WP-0.5)", () => {
	it("records session.start with the environment and new session id", async () => {
		const { environment, eventLog, ipcMain } = await setup();

		const session = ipcMain.invoke("session:start", environment.id);

		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("session.start", {
			environmentId: environment.id,
			sessionId: session.id,
		});
	});

	it("records session.pause once, but not again for a redundant pause call", async () => {
		const { environment, eventLog, ipcMain } = await setup();
		const session = ipcMain.invoke("session:start", environment.id);
		eventLog.record.mockClear();

		ipcMain.invoke("session:pause", session.id);
		ipcMain.invoke("session:pause", session.id); // already paused -- must not double-record

		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("session.pause", {
			environmentId: environment.id,
			sessionId: session.id,
		});
	});

	it("does not record session.resume for a no-op resume of a session that isn't paused", async () => {
		const { environment, eventLog, ipcMain } = await setup();
		const session = ipcMain.invoke("session:start", environment.id);
		eventLog.record.mockClear();

		ipcMain.invoke("session:resume", session.id); // never paused

		expect(eventLog.record).not.toHaveBeenCalled();
	});

	it("records session.resume exactly once for a real pause-then-resume", async () => {
		const { environment, eventLog, ipcMain } = await setup();
		const session = ipcMain.invoke("session:start", environment.id);
		ipcMain.invoke("session:pause", session.id);
		eventLog.record.mockClear();

		ipcMain.invoke("session:resume", session.id);

		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("session.resume", {
			environmentId: environment.id,
			sessionId: session.id,
		});
	});

	it("records session.stop once, but not again for a redundant stop call", async () => {
		const { environment, eventLog, ipcMain } = await setup();
		const session = ipcMain.invoke("session:start", environment.id);
		eventLog.record.mockClear();

		ipcMain.invoke("session:stop", session.id);
		ipcMain.invoke("session:stop", session.id); // already stopped

		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("session.stop", {
			environmentId: environment.id,
			sessionId: session.id,
		});
	});

	it("never throws when no event log getter is supplied at all", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Test env");
		const tracker = createFakeTracker();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, getTracker: () => tracker, getMiniWindow: () => null });

		expect(() => ipcMain.invoke("session:start", environment.id)).not.toThrow();
	});
});
