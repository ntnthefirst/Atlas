import { describe, expect, it, vi } from "vitest";
import { register } from "./launcher.cjs";

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

function createFakeEventLog() {
	return { record: vi.fn() };
}

describe("launcher:* IPC (WP-2.1)", () => {
	it("launcher:getHotkeyBinding returns whatever the service reports", () => {
		const getBinding = vi.fn(() => ({ accelerator: "Control+Alt+Space", registered: true }));
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getBinding, setBinding: vi.fn() });

		expect(ipcMain.invoke("launcher:getHotkeyBinding")).toEqual({
			accelerator: "Control+Alt+Space",
			registered: true,
		});
	});

	it("launcher:setHotkeyBinding forwards the accelerator and surfaces a conflict unchanged", () => {
		const setBinding = vi.fn(() => ({
			ok: false,
			accelerator: "Control+Alt+Space",
			registered: true,
			error: '"Control+Alt+T" is already in use by another application.',
		}));
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getBinding: vi.fn(), setBinding });

		const result = ipcMain.invoke("launcher:setHotkeyBinding", "Control+Alt+T");

		expect(setBinding).toHaveBeenCalledWith("Control+Alt+T");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/already in use/i);
	});

	it("launcher:query calls the provider seam, scopes to the active environment, and records the query", async () => {
		const search = vi.fn(() => [{ id: "a", kind: "action", title: "A" }]);
		const eventLog = createFakeEventLog();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, {
			search,
			execute: vi.fn(),
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => "env-1",
		});

		const results = await ipcMain.invoke("launcher:query", "note");

		expect(search).toHaveBeenCalledWith("note", { environmentId: "env-1" });
		expect(results).toEqual([{ id: "a", kind: "action", title: "A" }]);
		expect(eventLog.record).toHaveBeenCalledWith("launcher.query", {
			environmentId: "env-1",
			subject: "note",
			payload: { resultCount: 1 },
		});
	});

	it("launcher:query awaits a promise-returning provider and defaults to [] for a nullish result", async () => {
		const search = vi.fn(async () => null);
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { search, execute: vi.fn(), getEventLog: () => undefined, getCurrentEnvironmentId: () => null });

		const results = await ipcMain.invoke("launcher:query", "x");
		expect(results).toEqual([]);
	});

	it("launcher:execute calls the provider seam and records the execution with its modifier", async () => {
		const execute = vi.fn(() => ({ ok: true, resultId: "stub-new-task", modifier: "ctrl" }));
		const eventLog = createFakeEventLog();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, {
			search: vi.fn(),
			execute,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => "env-1",
		});

		const result = await ipcMain.invoke("launcher:execute", "stub-new-task", "ctrl");

		expect(execute).toHaveBeenCalledWith("stub-new-task", { environmentId: "env-1", modifier: "ctrl" });
		expect(result).toEqual({ ok: true, resultId: "stub-new-task", modifier: "ctrl" });
		expect(eventLog.record).toHaveBeenCalledWith("launcher.execute", {
			environmentId: "env-1",
			subject: "stub-new-task",
			payload: { modifier: "ctrl" },
		});
	});

	it("launcher:reportOpenLatency logs, records an event, and forwards to the self-check hook when present", async () => {
		const eventLog = createFakeEventLog();
		const onOpenLatencyReported = vi.fn();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, {
			search: vi.fn(),
			execute: vi.fn(),
			getEventLog: () => eventLog,
			onOpenLatencyReported,
		});

		const result = await ipcMain.invoke("launcher:reportOpenLatency", 23.7);

		expect(result).toBe(true);
		expect(eventLog.record).toHaveBeenCalledWith("launcher.opened", { payload: { latencyMs: 24 } });
		expect(onOpenLatencyReported).toHaveBeenCalledWith(24);
	});

	it("launcher:hide calls the window-hide callback", () => {
		const hideLauncherWindow = vi.fn();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { search: vi.fn(), execute: vi.fn(), hideLauncherWindow });

		const result = ipcMain.invoke("launcher:hide");

		expect(hideLauncherWindow).toHaveBeenCalledTimes(1);
		expect(result).toBe(true);
	});
});
