import { describe, expect, it, vi } from "vitest";
import { register } from "./environments.cjs";

// This module's other handlers are thin database passthroughs, already
// covered indirectly via electron/db.test.js and the app itself; this suite
// only targets `environment:switch`, the one handler WP-0.5 added purely to
// feed the event log (see the header comment in environments.cjs for why
// there was no pre-existing call site for it).

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

describe("environment:switch — event log recording (WP-0.5)", () => {
	it("records environment.switch with the given environment id", () => {
		const eventLog = { record: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => ({}), openPrimaryWindowByEnvironmentState: () => {}, getEventLog: () => eventLog });

		const result = ipcMain.invoke("environment:switch", "env-123");

		expect(result).toBe(true);
		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("environment.switch", { environmentId: "env-123" });
	});

	it("does nothing and returns false for a missing environment id", () => {
		const eventLog = { record: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => ({}), openPrimaryWindowByEnvironmentState: () => {}, getEventLog: () => eventLog });

		const result = ipcMain.invoke("environment:switch", null);

		expect(result).toBe(false);
		expect(eventLog.record).not.toHaveBeenCalled();
	});

	it("never throws when no event log getter is supplied", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => ({}), openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:switch", "env-123")).not.toThrow();
	});
});
