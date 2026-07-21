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
// main.cjs reassigns every time preferences load, save, or the active
// environment changes (see `saveNotchPreferences`/`applyNotchPreferences`/
// `refreshActiveNotchPreferences` there) -- a value capture here would
// freeze this module onto whatever `notchPreferences` was at require time,
// before any prefs are ever read.
//
// `getPendingNotchInputPayload` is a getter for the same reason:
// `pendingNotchInputPayload` is reassigned by the `setPendingPayload`
// callback `createNotchInputWindow` hands to the notch-input window module,
// which runs long after this module is required.
//
// `applyNotchPreferences` and `positionNotchWindow` are passed as plain
// values: both are `function` declarations in main.cjs that are never
// reassigned, so (unlike the two getters above) there's no stale-capture
// risk in holding onto them directly. `refreshActiveNotchPreferences` is
// the same kind of plain value -- also a `function` declaration -- added for
// WP-1.3 below.
//
// WP-1.3 (per-environment Notch layouts): `getDb` and `getCurrentEnvironmentId`
// are getters for the usual reason (`db` and `currentEnvironmentId` are both
// `let`s main.cjs reassigns after this module is required -- `db` once, at
// boot, `currentEnvironmentId` on every environment switch).
//
// `notch:getPreferences`/`notch:setPreferences` below are UNCHANGED in
// shape from before this package -- they still read/write "whatever's
// currently active". The three new `notch:*Layout*` channels are what the
// Settings-window/Action-editor tabs+grid editors use INSTEAD: those editors
// name their target explicitly (the global default, or one specific
// environment) rather than relying on "whatever's active", because the
// Action Editor window is not modal (see electron/windows/action-editor-
// window.cjs) -- the active environment really can change while it's open,
// and an ambient write there would silently land on the wrong environment.
// ---------------------------------------------------------------------------

const { BrowserWindow, screen } = require("electron");

function register(ipcMain, deps) {
	const {
		getNotchPreferences,
		applyNotchPreferences,
		positionNotchWindow,
		getPendingNotchInputPayload,
		getDb,
		getCurrentEnvironmentId,
		refreshActiveNotchPreferences,
	} = deps;

	ipcMain.handle("notch:getPreferences", () => getNotchPreferences());

	ipcMain.handle("notch:setPreferences", (_event, prefs) =>
		applyNotchPreferences({ ...getNotchPreferences(), ...(prefs || {}) }),
	);

	// Read-only resolve: does this environment have its own layout, or is it
	// inheriting the global default? Backs the editors' "uses default / has
	// its own layout" toggle.
	ipcMain.handle("notch:getLayoutForEnvironment", (_event, environmentId) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}
		return getDb().getEffectiveNotchPreferences(environmentId);
	});

	// Edits the GLOBAL DEFAULT layout directly -- what every environment
	// with no override of its own inherits. Refreshes the live notch
	// unconditionally afterward: the default may affect the currently active
	// environment (or may not, if it has its own override), and re-resolving
	// is cheap and always correct either way.
	ipcMain.handle("notch:setDefaultLayout", (_event, patch) => {
		const resolved = getDb().updateGlobalDefaultNotchLayout(patch || {});
		refreshActiveNotchPreferences?.();
		return resolved;
	});

	// Forks-or-updates `environmentId`'s OWN layout. Only refreshes the live
	// notch if this environment happens to be the currently active one --
	// editing some OTHER environment's layout must never visibly change what
	// the notch is showing right now.
	ipcMain.handle("notch:setEnvironmentLayout", (_event, environmentId, patch) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}
		const resolved = getDb().setEnvironmentNotchLayout(environmentId, patch || {});
		if (environmentId === getCurrentEnvironmentId?.()) {
			refreshActiveNotchPreferences?.();
		}
		return resolved;
	});

	// Reverts `environmentId` to the global default (its own layout row, if
	// it had one, is left in place -- see db.cjs#clearEnvironmentNotchLayout
	// -- never deleted here).
	ipcMain.handle("notch:clearEnvironmentLayout", (_event, environmentId) => {
		if (!environmentId) {
			throw new Error("Environment id missing.");
		}
		const resolved = getDb().clearEnvironmentNotchLayout(environmentId);
		if (environmentId === getCurrentEnvironmentId?.()) {
			refreshActiveNotchPreferences?.();
		}
		return resolved;
	});

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
