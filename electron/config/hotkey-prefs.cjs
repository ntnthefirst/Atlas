"use strict";

// ---------------------------------------------------------------------------
// Environment-switcher global hotkey: schema, default and normalization
// (WP-1.4).
//
// Pure -- no Electron, no filesystem -- same discipline as every other
// config/*.cjs module (focus-prefs.cjs, notch-prefs.cjs, update-prefs.cjs):
// the shape and its default have to be testable under plain vitest, with the
// actual globalShortcut registration/persistence mechanics living in
// electron/services/environment-hotkey.cjs, which is Electron-only and
// therefore only exercised by the real app.
//
// The document is deliberately just `{ accelerator }` -- one Electron
// accelerator string (e.g. "Control+Alt+E"). There is exactly one global
// hotkey in this package (opens the environment switcher); a second one
// would earn a second field, not a list, so a malformed/legacy document can
// never partially resolve.
// ---------------------------------------------------------------------------

const HOTKEY_PREFS_FILE = "environment-hotkey.json";

// "Environment" -- chosen because Control+Alt combinations are rarely
// claimed by other Windows software (unlike a bare Ctrl+E or Alt+E), and it
// collides with nothing else Atlas itself registers. Still just a default:
// globalShortcut.register() reports it plainly if it turns out to conflict
// with something already running on this machine, and the binding is always
// rebindable from Settings -> Keybindings.
const DEFAULT_ACCELERATOR = "Control+Alt+E";

const defaultHotkeyPreferences = () => ({ accelerator: DEFAULT_ACCELERATOR });

// Never throws, never returns a blank/missing accelerator -- a corrupt or
// pre-existing-but-empty preferences file falls back to the default rather
// than leaving the hotkey unregistered for a reason the user never chose.
function normalizeHotkeyPreferences(raw) {
	if (!raw || typeof raw !== "object") {
		return defaultHotkeyPreferences();
	}
	return {
		accelerator:
			typeof raw.accelerator === "string" && raw.accelerator.trim()
				? raw.accelerator.trim()
				: DEFAULT_ACCELERATOR,
	};
}

module.exports = {
	HOTKEY_PREFS_FILE,
	DEFAULT_ACCELERATOR,
	defaultHotkeyPreferences,
	normalizeHotkeyPreferences,
};
