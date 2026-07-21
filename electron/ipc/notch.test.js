import { describe, expect, it, vi } from "vitest";
import { register } from "./notch.cjs";

// This suite targets the WP-1.3 per-environment layout handlers
// (notch:getLayoutForEnvironment / notch:setDefaultLayout /
// notch:setEnvironmentLayout / notch:clearEnvironmentLayout). The
// pre-existing notch:getPreferences/notch:setPreferences pair is unchanged
// in shape (still ambient "whatever's active") and is exercised indirectly
// through electron/db.test.js and the app itself.

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

function createFakeDb() {
	return {
		getEffectiveNotchPreferences: vi.fn((environmentId) => ({
			usesDefault: environmentId !== "has-own-layout",
			layoutId: environmentId === "has-own-layout" ? "own-layout-id" : "default",
			preferences: { position: "top" },
		})),
		updateGlobalDefaultNotchLayout: vi.fn((patch) => ({
			usesDefault: true,
			layoutId: "default",
			preferences: { position: "top", ...patch },
		})),
		setEnvironmentNotchLayout: vi.fn((environmentId, patch) => ({
			usesDefault: false,
			layoutId: `${environmentId}-layout`,
			preferences: { position: "top", ...patch },
		})),
		clearEnvironmentNotchLayout: vi.fn(() => ({
			usesDefault: true,
			layoutId: "default",
			preferences: { position: "top" },
		})),
	};
}

describe("notch:getLayoutForEnvironment", () => {
	it("resolves through db.getEffectiveNotchPreferences", () => {
		const db = createFakeDb();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, getNotchPreferences: () => ({}) });

		const result = ipcMain.invoke("notch:getLayoutForEnvironment", "env-1");

		expect(db.getEffectiveNotchPreferences).toHaveBeenCalledWith("env-1");
		expect(result).toEqual({ usesDefault: true, layoutId: "default", preferences: { position: "top" } });
	});

	it("throws for a missing environment id", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => createFakeDb(), getNotchPreferences: () => ({}) });

		expect(() => ipcMain.invoke("notch:getLayoutForEnvironment", null)).toThrow();
	});
});

describe("notch:setDefaultLayout", () => {
	it("edits the global default and always refreshes the active notch", () => {
		const db = createFakeDb();
		const refreshActiveNotchPreferences = vi.fn();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, getNotchPreferences: () => ({}), refreshActiveNotchPreferences });

		const result = ipcMain.invoke("notch:setDefaultLayout", { locked: true });

		expect(db.updateGlobalDefaultNotchLayout).toHaveBeenCalledWith({ locked: true });
		expect(refreshActiveNotchPreferences).toHaveBeenCalledTimes(1);
		expect(result.usesDefault).toBe(true);
	});
});

describe("notch:setEnvironmentLayout", () => {
	it("forks/updates the environment's own layout", () => {
		const db = createFakeDb();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, getNotchPreferences: () => ({}) });

		const result = ipcMain.invoke("notch:setEnvironmentLayout", "env-1", { locked: true });

		expect(db.setEnvironmentNotchLayout).toHaveBeenCalledWith("env-1", { locked: true });
		expect(result.usesDefault).toBe(false);
	});

	it("refreshes the live notch only when the edited environment is the currently active one", () => {
		const db = createFakeDb();
		const refreshActiveNotchPreferences = vi.fn();
		const ipcMain = createFakeIpcMain();

		register(ipcMain, {
			getDb: () => db,
			getNotchPreferences: () => ({}),
			getCurrentEnvironmentId: () => "active-env",
			refreshActiveNotchPreferences,
		});
		ipcMain.invoke("notch:setEnvironmentLayout", "some-other-env", {});
		expect(refreshActiveNotchPreferences).not.toHaveBeenCalled();

		ipcMain.invoke("notch:setEnvironmentLayout", "active-env", {});
		expect(refreshActiveNotchPreferences).toHaveBeenCalledTimes(1);
	});

	it("throws for a missing environment id", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => createFakeDb(), getNotchPreferences: () => ({}) });

		expect(() => ipcMain.invoke("notch:setEnvironmentLayout", null, {})).toThrow();
	});
});

describe("notch:clearEnvironmentLayout", () => {
	it("reverts the environment to the default", () => {
		const db = createFakeDb();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getDb: () => db, getNotchPreferences: () => ({}) });

		const result = ipcMain.invoke("notch:clearEnvironmentLayout", "env-1");

		expect(db.clearEnvironmentNotchLayout).toHaveBeenCalledWith("env-1");
		expect(result.usesDefault).toBe(true);
	});

	it("refreshes the live notch only when clearing the currently active environment", () => {
		const db = createFakeDb();
		const refreshActiveNotchPreferences = vi.fn();
		const ipcMain = createFakeIpcMain();

		register(ipcMain, {
			getDb: () => db,
			getNotchPreferences: () => ({}),
			getCurrentEnvironmentId: () => "active-env",
			refreshActiveNotchPreferences,
		});
		ipcMain.invoke("notch:clearEnvironmentLayout", "some-other-env");
		expect(refreshActiveNotchPreferences).not.toHaveBeenCalled();

		ipcMain.invoke("notch:clearEnvironmentLayout", "active-env");
		expect(refreshActiveNotchPreferences).toHaveBeenCalledTimes(1);
	});
});
