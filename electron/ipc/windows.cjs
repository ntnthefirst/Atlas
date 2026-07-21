// ---------------------------------------------------------------------------
// Window IPC handlers (window:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. These
// handlers reach into the app's top-level windows (main/welcome/mini) to
// minimize, resize, close, navigate, or reveal them, plus a couple that hand
// off to the settings/action-editor/notch-input window factories.
//
// `getMainWindow`, `getWelcomeWindow`, and `getMiniWindow` are getters rather
// than plain values because `mainWindow`, `welcomeWindow`, and `miniWindow`
// are all `let` bindings main.cjs reassigns throughout each window's
// lifecycle (created, closed, destroyed) -- a value captured at require time
// (when all three are still `null`) would freeze at `null` and never see a
// window that's created later. Every handler below calls the getter again
// each time it needs the window rather than caching it in a local, mirroring
// how sessions.cjs's session:stop handler repeats `getMiniWindow()` -- the
// live window is what must be acted on, not a snapshot from earlier in the
// same handler.
//
// `getDb` is a getter for the same reason `db` needs one everywhere else: it
// is assigned during app.whenReady(), after this module is required, so a
// value capture would freeze it at `null`.
//
// `createMiniWindow`, `createSettingsWindow`, `createActionEditorWindow`,
// `createNotchInputWindow`, and `showMainWindow` are passed as plain values:
// each is a `function` declaration in main.cjs that is never reassigned, so
// there's no stale-capture risk in holding onto them directly (unlike the
// window variables above).
//
// `setGlobalTheme` (WP-1.4) is what `window:setTheme` actually calls -- it is
// main.cjs's own wrapper around `applyNativeTheme` that ALSO remembers the
// value as the user's global theme preference (`globalThemePreference`),
// which is what an environment switch falls back to for any environment
// whose own theme is "system" (no opinion). It is named differently from
// `applyNativeTheme` on purpose: this channel is the one and only place a
// GENUINE user preference change comes from (this hook fires on mount and on
// every manual toggle), as opposed to main.cjs's other internal calls to the
// raw `applyNativeTheme` (re-asserting the current native theme on a newly
// created window, or applying an environment's OWN override on switch),
// neither of which should overwrite what "system" means for next time.
// ---------------------------------------------------------------------------

const { BrowserWindow } = require("electron");

function register(ipcMain, deps) {
	const {
		getMainWindow,
		getWelcomeWindow,
		getMiniWindow,
		getDb,
		setGlobalTheme,
		createMiniWindow,
		createSettingsWindow,
		createActionEditorWindow,
		createNotchInputWindow,
		showMainWindow,
	} = deps;

	ipcMain.handle("window:minimize", (event) => {
		const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow() ?? getWelcomeWindow();
		if (targetWindow && !targetWindow.isDestroyed()) {
			targetWindow.minimize();
		}
		return true;
	});

	ipcMain.handle("window:setTheme", (_event, theme) => {
		setGlobalTheme(theme);
		return true;
	});

	ipcMain.handle("window:openMini", () => {
		createMiniWindow();
		return true;
	});

	ipcMain.handle("window:openSettings", (event) => {
		const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow() ?? getWelcomeWindow();
		createSettingsWindow(parentWindow);
		return true;
	});

	ipcMain.handle("window:openActionEditor", () => {
		// No parent window: this is opened from the notch as often as from
		// Settings, and should stay open/independent either way rather than
		// being tied to (and modal-blocked behind) whichever window asked.
		createActionEditorWindow(null);
		return true;
	});

	ipcMain.handle("window:openNotchInput", (_event, payload) => {
		createNotchInputWindow(payload && typeof payload === "object" ? payload : {});
		return true;
	});

	ipcMain.handle("window:resizeMini", (_event, width, height) => {
		if (!getMiniWindow() || getMiniWindow().isDestroyed()) {
			return false;
		}

		const safeWidth = Math.max(220, Math.min(900, Math.ceil(Number(width) || 0)));
		const safeHeight = Math.max(40, Math.min(260, Math.ceil(Number(height) || 0)));
		getMiniWindow().setContentSize(safeWidth, safeHeight);
		return true;
	});

	ipcMain.handle("window:showMain", () => {
		showMainWindow();
		return true;
	});

	// Brings the main window forward only if it already exists, without launching
	// it — the notch can run fully standalone, so this never force-opens the app.
	ipcMain.handle("window:focusMainIfOpen", () => {
		if (!getMainWindow() || getMainWindow().isDestroyed()) {
			return false;
		}
		if (getMainWindow().isMinimized()) {
			getMainWindow().restore();
		}
		getMainWindow().show();
		getMainWindow().focus();
		return true;
	});

	ipcMain.handle("window:navigate", (_event, view) => {
		showMainWindow();
		if (getMainWindow() && !getMainWindow().isDestroyed()) {
			getMainWindow().webContents.send("window:navigate-changed", view);
		}
		return true;
	});

	ipcMain.handle("window:closeMini", () => {
		if (!getMiniWindow() || getMiniWindow().isDestroyed()) {
			return false;
		}

		const hasActiveSession = Boolean(getDb() && getDb().getActiveSession());
		const canRevealMain = Boolean(getMainWindow() && !getMainWindow().isDestroyed());
		if (hasActiveSession && canRevealMain && getMainWindow().isVisible() === false) {
			showMainWindow();
		}

		getMiniWindow().close();
		return true;
	});

	ipcMain.handle("window:toggleMaximize", () => {
		if (!getMainWindow()) {
			return false;
		}
		if (getMainWindow().isMaximized()) {
			getMainWindow().unmaximize();
			return false;
		}
		getMainWindow().maximize();
		return true;
	});

	ipcMain.handle("window:close", (event) => {
		const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow() ?? getWelcomeWindow();
		if (targetWindow && !targetWindow.isDestroyed()) {
			targetWindow.close();
		}
		return true;
	});
}

module.exports = { register };
