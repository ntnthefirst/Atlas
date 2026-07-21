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

	// WP-1.3: live Notch switching rides on this same channel now.
	it("calls setActiveEnvironment with the new environment id, for live Notch layout switching", () => {
		const setActiveEnvironment = vi.fn();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, {
			getDb: () => ({}),
			openPrimaryWindowByEnvironmentState: () => {},
			setActiveEnvironment,
		});

		ipcMain.invoke("environment:switch", "env-456");

		expect(setActiveEnvironment).toHaveBeenCalledTimes(1);
		expect(setActiveEnvironment).toHaveBeenCalledWith("env-456");
	});

	it("never throws when no setActiveEnvironment is supplied", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => ({}), openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:switch", "env-789")).not.toThrow();
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

describe("environment:archive / environment:unarchive / environment:listArchived (WP-1.5)", () => {
	function createFakeDb() {
		const environments = new Map();
		return {
			environments,
			archiveEnvironment: (environmentId) => {
				const env = environments.get(environmentId);
				if (!env) throw new Error("Environment not found.");
				env.archived_at = "2026-01-01T00:00:00.000Z";
				return { ...env };
			},
			unarchiveEnvironment: (environmentId) => {
				const env = environments.get(environmentId);
				if (!env) throw new Error("Environment not found.");
				env.archived_at = null;
				return { ...env };
			},
			listArchivedEnvironments: () => [...environments.values()].filter((e) => e.archived_at),
		};
	}

	it("environment:archive archives via the db and re-derives the primary window", () => {
		const db = createFakeDb();
		db.environments.set("env-1", { id: "env-1", name: "Work", archived_at: null });
		const ipcMain = createFakeIpcMain();
		let windowStateCalls = 0;
		register(ipcMain, {
			getDb: () => db,
			openPrimaryWindowByEnvironmentState: () => {
				windowStateCalls += 1;
			},
		});

		const result = ipcMain.invoke("environment:archive", "env-1");

		expect(result.archived_at).toBeTruthy();
		expect(windowStateCalls).toBe(1);
	});

	it("environment:archive records environment.archived and flushes the event log first", () => {
		const db = createFakeDb();
		db.environments.set("env-1", { id: "env-1", name: "Work", archived_at: null });
		const eventLog = { record: vi.fn(), flushNow: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {}, getEventLog: () => eventLog });

		ipcMain.invoke("environment:archive", "env-1");

		expect(eventLog.flushNow).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("environment.archived", { environmentId: "env-1" });
	});

	it("environment:archive throws when no environment id is given", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => createFakeDb(), openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:archive", null)).toThrow(/id missing/i);
	});

	it("environment:archive propagates the db's rejection (e.g. the last remaining environment)", () => {
		const db = createFakeDb();
		db.archiveEnvironment = () => {
			throw new Error("Cannot archive the only environment.");
		};
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:archive", "env-1")).toThrow(/only environment/i);
	});

	it("environment:unarchive reverses archiving and records environment.unarchived", () => {
		const db = createFakeDb();
		db.environments.set("env-1", { id: "env-1", name: "Work", archived_at: "2026-01-01T00:00:00.000Z" });
		const eventLog = { record: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {}, getEventLog: () => eventLog });

		const result = ipcMain.invoke("environment:unarchive", "env-1");

		expect(result.archived_at).toBeNull();
		expect(eventLog.record).toHaveBeenCalledWith("environment.unarchived", { environmentId: "env-1" });
	});

	it("environment:unarchive throws when no environment id is given", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => createFakeDb(), openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:unarchive", null)).toThrow(/id missing/i);
	});

	it("environment:listArchived forwards straight to the db", () => {
		const db = createFakeDb();
		db.environments.set("env-1", { id: "env-1", name: "Work", archived_at: "2026-01-01T00:00:00.000Z" });
		db.environments.set("env-2", { id: "env-2", name: "Play", archived_at: null });
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		const result = ipcMain.invoke("environment:listArchived");

		expect(result.map((e) => e.id)).toEqual(["env-1"]);
	});
});

describe("environment:getContentCounts (WP-1.5)", () => {
	it("flushes the event log, then forwards the environment id to the db", () => {
		const counts = { tasks: 3, sessions: 1, notes: 2, activityBlocks: 5, events: 7, hasCustomNotchLayout: false };
		const db = { getEnvironmentContentCounts: vi.fn(() => counts) };
		const eventLog = { flushNow: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {}, getEventLog: () => eventLog });

		const result = ipcMain.invoke("environment:getContentCounts", "env-1");

		expect(eventLog.flushNow).toHaveBeenCalledTimes(1);
		expect(db.getEnvironmentContentCounts).toHaveBeenCalledWith("env-1");
		expect(result).toBe(counts);
	});

	it("throws when no environment id is given", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => ({ getEnvironmentContentCounts: () => ({}) }), openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:getContentCounts", null)).toThrow(/id missing/i);
	});

	it("never throws when no event log getter is supplied", () => {
		const db = { getEnvironmentContentCounts: () => ({ tasks: 0 }) };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:getContentCounts", "env-1")).not.toThrow();
	});
});

describe("environment:duplicate (WP-1.5)", () => {
	it("forwards the environment id and name to the db, records environment.duplicated, and re-derives the primary window", () => {
		const duplicated = { id: "env-2", name: "Work copy" };
		const db = { duplicateEnvironment: vi.fn(() => duplicated) };
		const eventLog = { record: vi.fn() };
		let windowStateCalls = 0;
		const ipcMain = createFakeIpcMain();
		register(ipcMain, {
			getDb: () => db,
			openPrimaryWindowByEnvironmentState: () => {
				windowStateCalls += 1;
			},
			getEventLog: () => eventLog,
		});

		const result = ipcMain.invoke("environment:duplicate", "env-1", "Work copy");

		expect(db.duplicateEnvironment).toHaveBeenCalledWith("env-1", "Work copy");
		expect(result).toBe(duplicated);
		expect(eventLog.record).toHaveBeenCalledWith("environment.duplicated", { environmentId: "env-2", subject: "env-1" });
		expect(windowStateCalls).toBe(1);
	});

	it("passes undefined through for a non-string name rather than forwarding it as-is", () => {
		const db = { duplicateEnvironment: vi.fn(() => ({ id: "env-2", name: "Work copy" })) };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		ipcMain.invoke("environment:duplicate", "env-1", null);

		expect(db.duplicateEnvironment).toHaveBeenCalledWith("env-1", undefined);
	});

	it("throws when no environment id is given", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => ({ duplicateEnvironment: () => ({ id: "x" }) }), openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:duplicate", null)).toThrow(/id missing/i);
	});
});

describe("environment:setIsolationMode (WP-1.2)", () => {
	function createFakeDb(initialMode = "connected") {
		const environment = { id: "env-1", name: "Work", icon: null, accent: null, preset: null, isolation_mode: initialMode, created_at: "t" };
		return {
			environment,
			setEnvironmentIsolationMode: (environmentId, mode) => {
				if (environmentId !== environment.id) {
					throw new Error("Environment not found.");
				}
				if (mode !== "connected" && mode !== "enclosed") {
					throw new Error(`Invalid isolation mode: ${mode}`);
				}
				environment.isolation_mode = mode;
				return mode;
			},
			getEnvironment: (environmentId) => (environmentId === environment.id ? { ...environment } : null),
		};
	}

	it("writes the new mode and returns the full, refreshed environment row", () => {
		const db = createFakeDb("connected");
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		const result = ipcMain.invoke("environment:setIsolationMode", "env-1", "enclosed");

		expect(result).toEqual({ id: "env-1", name: "Work", icon: null, accent: null, preset: null, isolation_mode: "enclosed", created_at: "t" });
		expect(db.environment.isolation_mode).toBe("enclosed");
	});

	it("records environment.isolation_mode_changed with the new mode as the event subject", () => {
		const db = createFakeDb("connected");
		const eventLog = { record: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {}, getEventLog: () => eventLog });

		ipcMain.invoke("environment:setIsolationMode", "env-1", "enclosed");

		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("environment.isolation_mode_changed", {
			environmentId: "env-1",
			subject: "enclosed",
		});
	});

	it("throws when no environment id is given", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => createFakeDb(), openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:setIsolationMode", null, "enclosed")).toThrow(/id missing/i);
	});

	it("propagates the db layer's rejection of an invalid mode rather than writing it", () => {
		const db = createFakeDb("connected");
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:setIsolationMode", "env-1", "private")).toThrow(/invalid isolation mode/i);
		expect(db.environment.isolation_mode).toBe("connected");
	});

	it("never throws when no event log getter is supplied", () => {
		const db = createFakeDb("connected");
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, openPrimaryWindowByEnvironmentState: () => {} });

		expect(() => ipcMain.invoke("environment:setIsolationMode", "env-1", "enclosed")).not.toThrow();
	});
});
