import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createLauncherHotkeyManager } from "./launcher-hotkey.cjs";
import { DEFAULT_ACCELERATOR } from "../config/launcher-hotkey-prefs.cjs";

// Mirrors environment-hotkey.test.js: a fake shortcut table (a Set of
// currently-"held" accelerators, exactly like the OS would enforce) stands in
// for `deps.globalShortcut`, and a scratch file in the OS temp dir stands in
// for the persisted preferences file.

function createFakeGlobalShortcut(alreadyTaken = new Set()) {
	const held = new Set(alreadyTaken);
	return {
		held,
		register: vi.fn((accelerator) => {
			if (held.has(accelerator)) {
				return false;
			}
			held.add(accelerator);
			return true;
		}),
		unregister: vi.fn((accelerator) => {
			held.delete(accelerator);
		}),
	};
}

function tempPrefsPath() {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atlas-launcher-hotkey-test-")), "launcher-hotkey.json");
}

describe("launcher-hotkey.cjs (WP-2.1)", () => {
	it("registers the default accelerator at boot and reports it as active", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createLauncherHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });
		const onTrigger = vi.fn();

		manager.load();
		const result = manager.register(onTrigger);

		expect(result).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: true });
		expect(manager.getBinding()).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: true });
	});

	it("fires the trigger callback when the registered accelerator is invoked", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createLauncherHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });
		const onTrigger = vi.fn();

		manager.load();
		manager.register(onTrigger);
		const registeredCallback = shortcuts.register.mock.calls[0][1];
		registeredCallback();

		expect(onTrigger).toHaveBeenCalledTimes(1);
	});

	it("reports registered:false, not a thrown error, when the default is already taken at boot", () => {
		const shortcuts = createFakeGlobalShortcut(new Set([DEFAULT_ACCELERATOR]));
		const manager = createLauncherHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });

		manager.load();
		expect(() => manager.register(() => {})).not.toThrow();
		expect(manager.getBinding()).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: false });
	});

	it("rebinds to a free accelerator, unregisters the old one, and persists the change", () => {
		const shortcuts = createFakeGlobalShortcut();
		const prefsPath = tempPrefsPath();
		const manager = createLauncherHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: () => prefsPath });

		manager.load();
		manager.register(() => {});

		const result = manager.setAccelerator("Control+Alt+K");

		expect(result).toEqual({ ok: true, accelerator: "Control+Alt+K", registered: true });
		expect(shortcuts.unregister).toHaveBeenCalledWith(DEFAULT_ACCELERATOR);
		expect(shortcuts.held.has("Control+Alt+K")).toBe(true);
		expect(shortcuts.held.has(DEFAULT_ACCELERATOR)).toBe(false);

		const persisted = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
		expect(persisted).toEqual({ accelerator: "Control+Alt+K" });
	});

	it("a conflicting rebind leaves the OLD binding fully intact and surfaces the conflict", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createLauncherHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });

		manager.load();
		manager.register(() => {});
		// Something else on the "system" grabs the candidate combination first.
		shortcuts.held.add("Control+Alt+T");

		const result = manager.setAccelerator("Control+Alt+T");

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/already in use/i);
		expect(result.accelerator).toBe(DEFAULT_ACCELERATOR);
		expect(result.registered).toBe(true);
		expect(shortcuts.unregister).not.toHaveBeenCalled();
		expect(manager.getBinding()).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: true });
	});

	it("rebinding after a boot-time conflict (nothing currently registered) still works", () => {
		const shortcuts = createFakeGlobalShortcut(new Set([DEFAULT_ACCELERATOR]));
		const manager = createLauncherHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });

		manager.load();
		manager.register(() => {});
		expect(manager.getBinding().registered).toBe(false);

		const result = manager.setAccelerator("Control+Alt+M");

		expect(result).toEqual({ ok: true, accelerator: "Control+Alt+M", registered: true });
		expect(shortcuts.unregister).not.toHaveBeenCalled();
	});

	it("rejects an empty/blank candidate without touching the current binding", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createLauncherHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });
		manager.load();
		manager.register(() => {});

		const result = manager.setAccelerator("   ");

		expect(result.ok).toBe(false);
		expect(manager.getBinding()).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: true });
	});

	it("unregisterAll releases the held accelerator and updates getBinding", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createLauncherHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });
		manager.load();
		manager.register(() => {});

		manager.unregisterAll();

		expect(shortcuts.unregister).toHaveBeenCalledWith(DEFAULT_ACCELERATOR);
		expect(manager.getBinding().registered).toBe(false);
	});

	it("load() falls back to the default when the prefs file does not exist yet", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createLauncherHotkeyManager({
			globalShortcut: shortcuts,
			getPrefsPath: () =>
				path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atlas-launcher-hotkey-test-")), "missing.json"),
		});

		expect(manager.load()).toEqual({ accelerator: DEFAULT_ACCELERATOR });
	});
});
