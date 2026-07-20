const { BrowserWindow } = require("electron");

// ---------------------------------------------------------------------------
// Settings window factory.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. main.cjs keeps
// ownership of the `settingsWindow` module-level reference and assigns this
// function's return value to it, exactly as before. Anything this factory
// used to read from main.cjs's module scope (isDev/isMac, the computed title
// bar overlay, resolved asset paths) is passed in through `deps` instead;
// anything it used to mutate on close (nulling the reference) is a callback.
// ---------------------------------------------------------------------------

// Opens (or focuses, if already open) the Settings window.
//
// `deps.existingWindow` is the caller's current settingsWindow reference —
// passed as a plain value since it is read once, synchronously, at the top
// of this call, the same instant main.cjs would have read its own module
// variable. `deps.onClosed` is a callback because the "closed" handler fires
// later, asynchronously, and must reach back into main.cjs to null its ref.
function createSettingsWindow(parentWindow, deps) {
	const { existingWindow, isDev, isMac, titleBarOverlay, paths, onClosed } = deps;

	if (existingWindow && !existingWindow.isDestroyed()) {
		existingWindow.show();
		existingWindow.focus();
		return existingWindow;
	}

	const settingsWindow = new BrowserWindow({
		width: 980,
		height: 680,
		minWidth: 980,
		minHeight: 680,
		maxWidth: 980,
		maxHeight: 680,
		maximizable: false,
		fullscreenable: false,
		autoHideMenuBar: true,
		show: false,
		center: true,
		backgroundColor: "#070707",
		icon: paths.iconPath,
		frame: isMac,
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		titleBarOverlay,
		parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
		modal: Boolean(parentWindow && !parentWindow.isDestroyed()),
		resizable: false,
		webPreferences: {
			preload: paths.preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		settingsWindow.loadURL("http://localhost:5173?mode=settings");
	} else {
		settingsWindow.loadFile(paths.distIndexPath, {
			query: { mode: "settings" },
		});
	}

	settingsWindow.once("ready-to-show", () => {
		if (!settingsWindow || settingsWindow.isDestroyed()) {
			return;
		}
		settingsWindow.show();
		settingsWindow.focus();
	});

	settingsWindow.on("closed", () => {
		onClosed();
	});

	return settingsWindow;
}

module.exports = { createSettingsWindow };
