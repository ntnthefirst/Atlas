"use strict";

// ---------------------------------------------------------------------------
// Launcher global hotkey: schema, default and normalization (WP-2.1).
//
// Sibling of config/hotkey-prefs.cjs (the environment-switcher hotkey) --
// same shape, same reasoning: pure, no Electron, no filesystem, so it's
// testable under plain vitest, with the actual globalShortcut
// registration/persistence mechanics living in
// electron/services/launcher-hotkey.cjs.
//
// This is a SEPARATE preferences file (and a separate globalShortcut
// registration) from the environment-switcher hotkey -- two independent
// global hotkeys, two independent bindings, so rebinding one can never
// silently touch the other.
//
// Default is "Control+Alt+Space": mirrors the "Control+Alt+<key>" shape
// chosen for the environment switcher (Control+Alt+E) -- a combination
// Windows itself doesn't claim and that's unlikely to collide with other
// installed software -- while staying a spare combo distinct from it. Still
// just a default: globalShortcut.register() reports plainly if it turns out
// to conflict with something already running on this machine, and the
// binding is always rebindable (launcher:setHotkeyBinding).
// ---------------------------------------------------------------------------

const LAUNCHER_HOTKEY_PREFS_FILE = "launcher-hotkey.json";

const DEFAULT_ACCELERATOR = "Control+Alt+Space";

const defaultLauncherHotkeyPreferences = () => ({ accelerator: DEFAULT_ACCELERATOR });

// Never throws, never returns a blank/missing accelerator -- a corrupt or
// pre-existing-but-empty preferences file falls back to the default rather
// than leaving the hotkey unregistered for a reason the user never chose.
function normalizeLauncherHotkeyPreferences(raw) {
	if (!raw || typeof raw !== "object") {
		return defaultLauncherHotkeyPreferences();
	}
	return {
		accelerator:
			typeof raw.accelerator === "string" && raw.accelerator.trim()
				? raw.accelerator.trim()
				: DEFAULT_ACCELERATOR,
	};
}

module.exports = {
	LAUNCHER_HOTKEY_PREFS_FILE,
	DEFAULT_ACCELERATOR,
	defaultLauncherHotkeyPreferences,
	normalizeLauncherHotkeyPreferences,
};
