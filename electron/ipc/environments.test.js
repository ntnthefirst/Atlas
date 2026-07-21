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

describe("environment:getConfig / environment:setConfig (WP-1.1)", () => {
	function createFakeDb() {
		const configs = new Map();
		return {
			getEnvironmentConfig: (environmentId) => configs.get(environmentId) ?? null,
			setEnvironmentConfig: (environmentId, patch) => {
				if (!configs.has(environmentId) && environmentId !== "known-env") {
					throw new Error("Environment not found.");
				}
				const next = { ...(configs.get(environmentId) ?? {}), ...patch };
				configs.set(environmentId, next);
				return next;
			},
		};
	}

	it("environment:getConfig passes the environment id straight through to the db", () => {
		const db = createFakeDb();
		db.setEnvironmentConfig("known-env", { notchLayoutId: "layout-1" });
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		expect(ipcMain.invoke("environment:getConfig", "known-env")).toEqual({ notchLayoutId: "layout-1" });
	});

	it("environment:getConfig throws when no environment id is given", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => createFakeDb(), openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:getConfig", null)).toThrow(/id missing/i);
	});

	it("environment:setConfig forwards the patch to the db and returns the resolved config", () => {
		const db = createFakeDb();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		const result = ipcMain.invoke("environment:setConfig", "known-env", { notchLayoutId: "layout-2" });

		expect(result).toEqual({ notchLayoutId: "layout-2" });
		expect(ipcMain.invoke("environment:getConfig", "known-env")).toEqual({ notchLayoutId: "layout-2" });
	});

	it("environment:setConfig throws when no environment id is given", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => createFakeDb(), openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:setConfig", null, {})).toThrow(/id missing/i);
	});

	it("environment:setConfig defaults a missing/undefined patch to an empty object rather than passing undefined through", () => {
		const db = createFakeDb();
		let receivedPatch;
		db.setEnvironmentConfig = (environmentId, patch) => {
			receivedPatch = patch;
			return {};
		};
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		ipcMain.invoke("environment:setConfig", "known-env");

		expect(receivedPatch).toEqual({});
	});
});
