"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, globalShortcut } = require("electron");
const {
	HOTKEY_PREFS_FILE,
	defaultHotkeyPreferences,
	normalizeHotkeyPreferences,
} = require("../config/hotkey-prefs.cjs");

// ---------------------------------------------------------------------------
// The global environment-switcher hotkey (WP-1.4).
//
// One `globalShortcut` registration, always active system-wide (not just
// while Atlas has focus), that opens the environment switcher -- see
// main.cjs's `openEnvironmentSwitcher`. This module owns the persisted
// binding and the register/unregister mechanics; main.cjs owns what
// actually happens when it fires (a plain callback handed to `register`).
//
// `globalShortcut.register(accelerator, callback)` returns `false` -- not a
// thrown error -- when another application already holds the combination.
// That is the one behaviour this whole module exists to make impossible to
// miss: main.cjs's WP-1.3-era code had no hotkey at all to get this wrong,
// but a naive "call register() once at boot and move on" implementation
// would silently leave the user with a dead key the instant that happens.
// Every path below (boot registration AND rebinding) returns a real
// `{ registered, ... }` result that a caller can act on, rather than
// swallowing a `false` return.
//
// Rebinding (`setAccelerator`) registers the CANDIDATE accelerator BEFORE
// touching the current one. If the candidate is already taken, the current
// binding is left completely untouched -- registered if it was registered,
// unregistered if it wasn't -- so a failed rebind attempt can never leave
// the user with neither shortcut working. Only once the candidate proves
// available does the old one get unregistered and the new one persisted.
//
// `deps.globalShortcut` and `deps.getPrefsPath` exist purely so this can be
// unit-tested with a fake shortcut table and a scratch file path, without a
// running Electron process -- the real app (main.cjs) calls
// `createEnvironmentHotkeyManager()` with no arguments and gets the real
// `electron.globalShortcut` and the real userData path.
// ---------------------------------------------------------------------------

function createEnvironmentHotkeyManager(deps = {}) {
	const shortcuts = deps.globalShortcut ?? globalShortcut;
	const resolvePrefsPath = deps.getPrefsPath ?? (() => path.join(app.getPath("userData"), HOTKEY_PREFS_FILE));

	let preferences = defaultHotkeyPreferences();
	let registered = false;
	let trigger = null;

	function load() {
		try {
			const raw = fs.readFileSync(resolvePrefsPath(), "utf8");
			preferences = normalizeHotkeyPreferences(JSON.parse(raw));
		} catch {
			preferences = defaultHotkeyPreferences();
		}
		return preferences;
	}

	function persist() {
		try {
			fs.writeFileSync(resolvePrefsPath(), JSON.stringify(preferences, null, 2), "utf8");
		} catch {
			// Non-blocking: the binding still works this session from memory even
			// if it can't be written to disk.
		}
	}

	function getBinding() {
		return { accelerator: preferences.accelerator, registered };
	}

	// Registers the currently-persisted accelerator for the first time
	// (called once at boot). `onTrigger` is kept (not just used once) so a
	// later successful `setAccelerator` call can re-register with the same
	// callback without main.cjs having to remember and re-pass it.
	function register(onTrigger) {
		trigger = onTrigger;
		registered = Boolean(shortcuts.register(preferences.accelerator, () => trigger?.()));
		if (!registered) {
			console.error(
				`[Atlas] Could not register the environment-switcher hotkey (${preferences.accelerator}) -- ` +
					"another application already holds it. Rebind it in Settings -> Keybindings.",
			);
		}
		return getBinding();
	}

	// Rebind. See the header comment above for why the candidate is tried
	// BEFORE the current binding is touched.
	function setAccelerator(nextAccelerator) {
		const candidate = typeof nextAccelerator === "string" ? nextAccelerator.trim() : "";
		if (!candidate) {
			return { ok: false, accelerator: preferences.accelerator, registered, error: "No shortcut given." };
		}

		if (candidate === preferences.accelerator && registered) {
			return { ok: true, accelerator: preferences.accelerator, registered: true };
		}

		const previousAccelerator = preferences.accelerator;
		const wasRegistered = registered;

		const succeeded = Boolean(shortcuts.register(candidate, () => trigger?.()));
		if (!succeeded) {
			// Nothing changed: the old binding is exactly as it was before this
			// call, and the failure is handed back for the caller (the Settings
			// UI) to show inline -- never swallowed.
			return {
				ok: false,
				accelerator: previousAccelerator,
				registered: wasRegistered,
				error: `"${candidate}" is already in use by another application.`,
			};
		}

		if (wasRegistered && previousAccelerator !== candidate) {
			shortcuts.unregister(previousAccelerator);
		}

		preferences = normalizeHotkeyPreferences({ accelerator: candidate });
		registered = true;
		persist();
		return { ok: true, accelerator: preferences.accelerator, registered: true };
	}

	// Called on app quit. Electron unregisters process-owned global shortcuts
	// on exit regardless, but doing it explicitly avoids relying on that and
	// leaves nothing registered while a smoke-test run's Electron process is
	// shutting down.
	function unregisterAll() {
		if (registered) {
			shortcuts.unregister(preferences.accelerator);
			registered = false;
		}
	}

	return { load, getBinding, register, setAccelerator, unregisterAll };
}

module.exports = { createEnvironmentHotkeyManager };
