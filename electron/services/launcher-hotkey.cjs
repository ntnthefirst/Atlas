"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, globalShortcut } = require("electron");
const {
	LAUNCHER_HOTKEY_PREFS_FILE,
	defaultLauncherHotkeyPreferences,
	normalizeLauncherHotkeyPreferences,
} = require("../config/launcher-hotkey-prefs.cjs");

// ---------------------------------------------------------------------------
// The global launcher hotkey (WP-2.1).
//
// Sibling of services/environment-hotkey.cjs -- same shape, same reasoning,
// copied here rather than generalized because it is its OWN independent
// globalShortcut registration and its OWN persisted binding, entirely
// separate from the environment-switcher hotkey. See environment-hotkey.cjs's
// header for the full reasoning this mirrors; only what's different is
// re-explained below.
//
// `globalShortcut.register(accelerator, callback)` returns `false` -- not a
// thrown error -- when another application already holds the combination.
// Every path below (boot registration AND rebinding) returns a real
// `{ registered, ... }` / `{ ok, ... }` result rather than swallowing a
// `false` return, exactly like the environment hotkey.
//
// Rebinding (`setAccelerator`) registers the CANDIDATE accelerator BEFORE
// touching the current one, so a failed rebind attempt can never leave the
// user with neither shortcut working.
//
// `deps.globalShortcut` and `deps.getPrefsPath` exist purely so this can be
// unit-tested with a fake shortcut table and a scratch file path, without a
// running Electron process -- the real app (main.cjs) calls
// `createLauncherHotkeyManager()` with no arguments and gets the real
// `electron.globalShortcut` and the real userData path.
// ---------------------------------------------------------------------------

function createLauncherHotkeyManager(deps = {}) {
	const shortcuts = deps.globalShortcut ?? globalShortcut;
	const resolvePrefsPath =
		deps.getPrefsPath ?? (() => path.join(app.getPath("userData"), LAUNCHER_HOTKEY_PREFS_FILE));

	let preferences = defaultLauncherHotkeyPreferences();
	let registered = false;
	let trigger = null;

	function load() {
		try {
			const raw = fs.readFileSync(resolvePrefsPath(), "utf8");
			preferences = normalizeLauncherHotkeyPreferences(JSON.parse(raw));
		} catch {
			preferences = defaultLauncherHotkeyPreferences();
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
				`[Atlas] Could not register the launcher hotkey (${preferences.accelerator}) -- ` +
					"another application already holds it. Rebind it via launcher:setHotkeyBinding.",
			);
		}
		return getBinding();
	}

	// Rebind. See the header comment above (and environment-hotkey.cjs's, in
	// full) for why the candidate is tried BEFORE the current binding is
	// touched.
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
			// call, and the failure is handed back for the caller to show inline --
			// never swallowed.
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

		preferences = normalizeLauncherHotkeyPreferences({ accelerator: candidate });
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

module.exports = { createLauncherHotkeyManager };
