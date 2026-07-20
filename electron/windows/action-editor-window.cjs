const { BrowserWindow } = require("electron");

// ---------------------------------------------------------------------------
// Action editor window factory.
//
// A standalone window for editing the notch's action-button tabs/grids — the
// same editor embedded in Settings, but reachable directly from a button on
// the notch itself without going through the full Settings window.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. Same
// dependency-injection shape as settings-window.cjs: main.cjs keeps ownership
// of the `actionEditorWindow` module-level reference and assigns this
// function's return value to it; construction-time reads (isDev/isMac, the
// title bar overlay, resolved asset paths) are plain values in `deps`, and
// the "closed" side effect is a callback.
// ---------------------------------------------------------------------------

function createActionEditorWindow(parentWindow, deps) {
	const { existingWindow, isDev, isMac, titleBarOverlay, paths, onClosed } = deps;

	if (existingWindow && !existingWindow.isDestroyed()) {
		existingWindow.show();
		existingWindow.focus();
		return existingWindow;
	}

	const actionEditorWindow = new BrowserWindow({
		width: 900,
		height: 720,
		minWidth: 640,
		minHeight: 480,
		autoHideMenuBar: true,
		show: false,
		center: true,
		backgroundColor: "#070707",
		icon: paths.iconPath,
		frame: isMac,
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		titleBarOverlay,
		parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
		webPreferences: {
			preload: paths.preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		actionEditorWindow.loadURL("http://localhost:5173?mode=actions");
	} else {
		actionEditorWindow.loadFile(paths.distIndexPath, {
			query: { mode: "actions" },
		});
	}

	actionEditorWindow.once("ready-to-show", () => {
		if (!actionEditorWindow || actionEditorWindow.isDestroyed()) {
			return;
		}
		actionEditorWindow.show();
		actionEditorWindow.focus();
	});

	actionEditorWindow.on("closed", () => {
		onClosed();
	});

	return actionEditorWindow;
}

module.exports = { createActionEditorWindow };
