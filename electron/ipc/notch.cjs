// ---------------------------------------------------------------------------
// Notch IPC handlers (notch:*, notchInput:*, screen:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change.
// These read/write the notch's persisted preferences and reposition/toggle
// individual notch windows (one per display); `notchInput:getPayload` and
// `screen:listDisplays` ride along since they're the notch's own small
// popup-input and multi-monitor concerns respectively.
//
// `BrowserWindow` and `screen` are required directly from `electron` --
// they're stateless Electron APIs, not main.cjs state, so there's nothing to
// thread through `deps` for them.
//
// `getNotchPreferences` is a getter because `notchPreferences` is a `let`
// main.cjs reassigns every time preferences load or save (see
// `loadNotchPreferences`/`saveNotchPreferences`/`applyNotchPreferences`
// there) -- a value capture here would freeze this module onto whatever
// `notchPreferences` was at require time, before any prefs file is ever read.
//
// `getPendingNotchInputPayload` is a getter for the same reason:
// `pendingNotchInputPayload` is reassigned by the `setPendingPayload`
// callback `createNotchInputWindow` hands to the notch-input window module,
// which runs long after this module is required.
//
// `applyNotchPreferences` and `positionNotchWindow` are passed as plain
// values: both are `function` declarations in main.cjs that are never
// reassigned, so (unlike the two getters above) there's no stale-capture
// risk in holding onto them directly.
// ---------------------------------------------------------------------------

const { BrowserWindow, screen } = require("electron");

function register(ipcMain, deps) {
	const { getNotchPreferences, applyNotchPreferences, positionNotchWindow, getPendingNotchInputPayload } = deps;

	ipcMain.handle("notch:getPreferences", () => getNotchPreferences());

	ipcMain.handle("notch:setPreferences", (_event, prefs) =>
		applyNotchPreferences({ ...getNotchPreferences(), ...(prefs || {}) }),
	);

	ipcMain.handle("notch:resize", (event, width, height) => {
		const notchWindow = BrowserWindow.fromWebContents(event.sender);
		if (!notchWindow || notchWindow.isDestroyed()) {
			return false;
		}
		const display =
			screen.getAllDisplays().find((item) => item.id === notchWindow.notchDisplayId) ??
			screen.getPrimaryDisplay();
		const safeWidth = Math.max(120, Math.min(900, Math.ceil(Number(width) || 0)));
		const safeHeight = Math.max(44, Math.min(600, Math.ceil(Number(height) || 0)));
		positionNotchWindow(notchWindow, display, safeWidth, safeHeight);
		return true;
	});

	// Toggles the notch window's click-through state. When the card is retracted
	// (or the pointer is over the transparent margins), the renderer flips this on
	// so clicks pass straight to whatever is behind the notch instead of the
	// invisible window swallowing them. `forward: true` keeps mouse-move events
	// flowing to the renderer so it can detect the pointer re-entering the peek
	// and flip interactivity back on. Never made click-through while free-floating
	// (it must stay grabbable) — the renderer enforces that too.
	ipcMain.handle("notch:setIgnoreMouse", (event, ignore) => {
		const notchWindow = BrowserWindow.fromWebContents(event.sender);
		if (!notchWindow || notchWindow.isDestroyed()) {
			return false;
		}
		if (ignore) {
			notchWindow.setIgnoreMouseEvents(true, { forward: true });
		} else {
			notchWindow.setIgnoreMouseEvents(false);
		}
		return true;
	});

	ipcMain.handle("screen:listDisplays", () => {
		const primaryId = screen.getPrimaryDisplay().id;
		return screen.getAllDisplays().map((display, index) => ({
			id: display.id,
			label: `Display ${index + 1} (${display.size.width}x${display.size.height})${display.id === primaryId ? " — Primary" : ""}`,
			isPrimary: display.id === primaryId,
			width: display.size.width,
			height: display.size.height,
		}));
	});

	ipcMain.handle("notchInput:getPayload", () => getPendingNotchInputPayload() ?? {});
}

module.exports = { register };
