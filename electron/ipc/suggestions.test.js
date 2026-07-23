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

// ---------------------------------------------------------------------------
// WP-3.7's two channels. Both are environment-scoped by construction, and the
// reset channel normalizes a missing pattern type to an explicit null so the
// manager never has to guess whether "undefined" meant "all of them" or a
// dropped argument.
// ---------------------------------------------------------------------------

describe("suggestions:getFeedback / suggestions:resetFeedback (WP-3.7)", () => {
	function createFeedbackManager(overrides = {}) {
		return {
			getPreferences: vi.fn(() => ({})),
			setPreferences: vi.fn((patch) => patch),
			getSuggestionToSurface: vi.fn(() => null),
			getFeedback: vi.fn(() => [{ patternType: "sequential_co_occurrence", suppressed: true }]),
			resetFeedback: vi.fn(() => []),
			...overrides,
		};
	}

	it("forwards the environment id to getFeedback and returns its rows", () => {
		const manager = createFeedbackManager();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager });

		const rows = ipcMain.invoke("suggestions:getFeedback", "env-a");

		expect(manager.getFeedback).toHaveBeenCalledWith("env-a");
		expect(rows[0].suppressed).toBe(true);
	});

	it("resets one named category", () => {
		const manager = createFeedbackManager();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager });

		ipcMain.invoke("suggestions:resetFeedback", "env-a", "sequential_co_occurrence");

		expect(manager.resetFeedback).toHaveBeenCalledWith("env-a", "sequential_co_occurrence");
	});

	it("normalizes a missing pattern type to an explicit null, never undefined", () => {
		const manager = createFeedbackManager();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager });

		ipcMain.invoke("suggestions:resetFeedback", "env-a");

		expect(manager.resetFeedback).toHaveBeenCalledWith("env-a", null);
	});
});
