import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../db.cjs";
import { register } from "./notes.cjs";

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-notes-ipc-test-"));
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

describe("note IPC handlers — event log recording (WP-0.5)", () => {
	it("records note.create with the note id as subject, never the note content", async () => {
		const { environment, eventLog, ipcMain } = await setup();

		const note = ipcMain.invoke("note:create", environment.id, "very private note content");

		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("note.create", {
			environmentId: environment.id,
			subject: note.id,
		});
		expect(JSON.stringify(eventLog.record.mock.calls[0])).not.toContain("very private note content");
	});

	it("never throws when no event log getter is supplied", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Test env");
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db });

		expect(() => ipcMain.invoke("note:create", environment.id, "content")).not.toThrow();
	});
});
