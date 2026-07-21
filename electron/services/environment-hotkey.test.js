import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createEnvironmentHotkeyManager } from "./environment-hotkey.cjs";
import { DEFAULT_ACCELERATOR } from "../config/hotkey-prefs.cjs";

// This suite never touches the real Electron globalShortcut/app -- a fake
// shortcut table (a Set of currently-"held" accelerators, exactly like the OS
// would enforce) stands in for `deps.globalShortcut`, and a scratch file in
// the OS temp dir stands in for the persisted preferences file. See
// environment-hotkey.cjs's header for why `deps.globalShortcut`/
// `deps.getPrefsPath` exist at all.

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
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atlas-hotkey-test-")), "environment-hotkey.json");
}

describe("environment-hotkey.cjs (WP-1.4)", () => {
	it("registers the default accelerator at boot and reports it as active", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createEnvironmentHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });
		const onTrigger = vi.fn();

		manager.load();
		const result = manager.register(onTrigger);

		expect(result).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: true });
		expect(manager.getBinding()).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: true });
	});

	it("fires the trigger callback when the registered accelerator is invoked", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createEnvironmentHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });
		const onTrigger = vi.fn();

		manager.load();
		manager.register(onTrigger);
		// Invoke whatever callback was actually handed to globalShortcut.register --
		// this is what Electron itself would call when the physical keys are pressed.
		const registeredCallback = shortcuts.register.mock.calls[0][1];
		registeredCallback();

		expect(onTrigger).toHaveBeenCalledTimes(1);
	});

	it("reports registered:false, not a thrown error, when the default is already taken at boot", () => {
		const shortcuts = createFakeGlobalShortcut(new Set([DEFAULT_ACCELERATOR]));
		const manager = createEnvironmentHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });

		manager.load();
		expect(() => manager.register(() => {})).not.toThrow();
		expect(manager.getBinding()).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: false });
	});

	it("rebinds to a free accelerator, unregisters the old one, and persists the change", () => {
		const shortcuts = createFakeGlobalShortcut();
		const prefsPath = tempPrefsPath();
		const manager = createEnvironmentHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: () => prefsPath });

		manager.load();
		manager.register(() => {});

		const result = manager.setAccelerator("Control+Shift+Space");

		expect(result).toEqual({ ok: true, accelerator: "Control+Shift+Space", registered: true });
		expect(shortcuts.unregister).toHaveBeenCalledWith(DEFAULT_ACCELERATOR);
		expect(shortcuts.held.has("Control+Shift+Space")).toBe(true);
		expect(shortcuts.held.has(DEFAULT_ACCELERATOR)).toBe(false);

		const persisted = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
		expect(persisted).toEqual({ accelerator: "Control+Shift+Space" });
	});

	it("a conflicting rebind leaves the OLD binding fully intact and surfaces the conflict", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createEnvironmentHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });

		manager.load();
		manager.register(() => {});
		// Something else on the "system" grabs the candidate combination first.
		shortcuts.held.add("Control+Alt+T");

		const result = manager.setAccelerator("Control+Alt+T");

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/already in use/i);
		// The failure is surfaced (never silently swallowed) AND the previous,
		// still-working binding is reported back unchanged.
		expect(result.accelerator).toBe(DEFAULT_ACCELERATOR);
		expect(result.registered).toBe(true);
		expect(shortcuts.unregister).not.toHaveBeenCalled();
		expect(manager.getBinding()).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: true });
	});

	it("rebinding after a boot-time conflict (nothing currently registered) still works", () => {
		const shortcuts = createFakeGlobalShortcut(new Set([DEFAULT_ACCELERATOR]));
		const manager = createEnvironmentHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });

		manager.load();
		manager.register(() => {});
		expect(manager.getBinding().registered).toBe(false);

		const result = manager.setAccelerator("Control+Alt+M");

		expect(result).toEqual({ ok: true, accelerator: "Control+Alt+M", registered: true });
		// Nothing to unregister -- the old accelerator was never actually held by us.
		expect(shortcuts.unregister).not.toHaveBeenCalled();
	});

	it("rejects an empty/blank candidate without touching the current binding", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createEnvironmentHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });
		manager.load();
		manager.register(() => {});

		const result = manager.setAccelerator("   ");

		expect(result.ok).toBe(false);
		expect(manager.getBinding()).toEqual({ accelerator: DEFAULT_ACCELERATOR, registered: true });
	});

	it("unregisterAll releases the held accelerator and updates getBinding", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createEnvironmentHotkeyManager({ globalShortcut: shortcuts, getPrefsPath: tempPrefsPath });
		manager.load();
		manager.register(() => {});

		manager.unregisterAll();

		expect(shortcuts.unregister).toHaveBeenCalledWith(DEFAULT_ACCELERATOR);
		expect(manager.getBinding().registered).toBe(false);
	});

	it("load() falls back to the default when the prefs file does not exist yet", () => {
		const shortcuts = createFakeGlobalShortcut();
		const manager = createEnvironmentHotkeyManager({
			globalShortcut: shortcuts,
			getPrefsPath: () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atlas-hotkey-test-")), "missing.json"),
		});

		expect(manager.load()).toEqual({ accelerator: DEFAULT_ACCELERATOR });
	});
});
