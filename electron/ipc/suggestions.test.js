import { describe, expect, it, vi } from "vitest";
import { register } from "./suggestions.cjs";

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

function createFakeManager(overrides = {}) {
	return {
		getPreferences: vi.fn(() => ({ enabled: true, maxPerSession: 1, maxPerDay: 3 })),
		setPreferences: vi.fn((patch) => ({ enabled: true, maxPerSession: 1, maxPerDay: 3, ...patch })),
		getSuggestionToSurface: vi.fn(() => null),
		...overrides,
	};
}

describe("suggestions:getPreferences / suggestions:setPreferences", () => {
	it("reads through to the manager", () => {
		const manager = createFakeManager();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager });

		expect(ipcMain.invoke("suggestions:getPreferences")).toEqual({
			enabled: true,
			maxPerSession: 1,
			maxPerDay: 3,
		});
		expect(manager.getPreferences).toHaveBeenCalledOnce();
	});

	it("writes through to the manager, defaulting a missing patch to {}", () => {
		const manager = createFakeManager();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager });

		ipcMain.invoke("suggestions:setPreferences", { enabled: false });
		expect(manager.setPreferences).toHaveBeenCalledWith({ enabled: false });

		ipcMain.invoke("suggestions:setPreferences", undefined);
		expect(manager.setPreferences).toHaveBeenCalledWith({});
	});
});

describe("suggestions:getCurrent", () => {
	it("passes the environmentId straight through and returns whatever the manager decides", () => {
		const suggestion = { id: "f1", environmentId: "env-a", description: "When X, then Y" };
		const manager = createFakeManager({ getSuggestionToSurface: vi.fn(() => suggestion) });
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager });

		const result = ipcMain.invoke("suggestions:getCurrent", "env-a");

		expect(manager.getSuggestionToSurface).toHaveBeenCalledWith("env-a");
		expect(result).toEqual(suggestion);
	});

	it("returns null (never throws) when the manager has nothing to show", () => {
		const manager = createFakeManager();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager });

		expect(ipcMain.invoke("suggestions:getCurrent", "env-a")).toBeNull();
	});
});
