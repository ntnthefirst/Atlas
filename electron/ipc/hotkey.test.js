import { describe, expect, it, vi } from "vitest";
import { register } from "./hotkey.cjs";

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

describe("hotkey:* IPC (WP-1.4)", () => {
	it("hotkey:getBinding returns whatever the service reports", () => {
		const getBinding = vi.fn(() => ({ accelerator: "Control+Alt+E", registered: true }));
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getBinding, setBinding: vi.fn() });

		expect(ipcMain.invoke("hotkey:getBinding")).toEqual({ accelerator: "Control+Alt+E", registered: true });
	});

	it("hotkey:setBinding forwards the accelerator and returns a success result unchanged", () => {
		const setBinding = vi.fn(() => ({ ok: true, accelerator: "Control+Alt+M", registered: true }));
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getBinding: vi.fn(), setBinding });

		const result = ipcMain.invoke("hotkey:setBinding", "Control+Alt+M");

		expect(setBinding).toHaveBeenCalledWith("Control+Alt+M");
		expect(result).toEqual({ ok: true, accelerator: "Control+Alt+M", registered: true });
	});

	// The one behaviour this whole package exists to guarantee: a conflicting
	// rebind must come back as a real, inspectable failure -- never `true`,
	// never swallowed into `undefined`.
	it("hotkey:setBinding surfaces a conflict failure exactly as the service reported it", () => {
		const setBinding = vi.fn(() => ({
			ok: false,
			accelerator: "Control+Alt+E",
			registered: true,
			error: '"Control+Alt+T" is already in use by another application.',
		}));
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { getBinding: vi.fn(), setBinding });

		const result = ipcMain.invoke("hotkey:setBinding", "Control+Alt+T");

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/already in use/i);
		expect(result.accelerator).toBe("Control+Alt+E");
	});
});
