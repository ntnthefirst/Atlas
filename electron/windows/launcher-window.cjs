const { BrowserWindow } = require("electron");

// ---------------------------------------------------------------------------
// Launcher window factory (WP-2.1).
//
// Structurally the same frameless/transparent/always-on-top popup as
// windows/notch-input-window.cjs (same webPreferences, same centered
// borderless look, same isDev loadURL/loadFile-with-mode-query split) -- but
// with the one difference the sub-50ms open budget hinges on: this window is
// PRE-CREATED, ONCE, at boot (see main.cjs's app.whenReady()) and NEVER
// destroyed until the app actually quits. Every open after that is just
// `.show()` + `.focus()` -- no BrowserWindow construction, no page load, on
// the hotkey path. `createLauncherWindow()` is therefore called exactly
// once; unlike notch-input-window.cjs's factory it takes no
// `existingWindow`/`onClosed` pair, because main.cjs never needs to recreate
// or null this one out.
//
// Dismiss-on-blur mirrors the capture popup's own behaviour (losing focus
// closes it), except this one HIDES rather than closes, for the same
// pre-created-and-kept-alive reason. Esc goes through the same path via the
// renderer's `launcher:hide` IPC call (see ipc/launcher.cjs) rather than a
// window-level accelerator, so the keyboard handling lives in one place (the
// renderer) alongside the rest of the launcher's keyboard control.
//
// `getIsQuitting` is a getter (not a plain value) for the same reason
// `getMainWindow` is one in notch-windows.cjs: `isQuitting` is a `let`
// main.cjs flips to `true` in its `before-quit` handler, AFTER this window is
// created -- a value capture here would freeze at `false` forever and this
// window's own `close` handler would then block the app from ever quitting
// (see below).
// ---------------------------------------------------------------------------

function createLauncherWindow(deps) {
	const { isDev, paths, getIsQuitting } = deps;

	const launcherWindow = new BrowserWindow({
		width: 640,
		height: 420,
		resizable: false,
		maximizable: false,
		minimizable: false,
		fullscreenable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		show: false,
		center: true,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: true,
		webPreferences: {
			preload: paths.preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	launcherWindow.setAlwaysOnTop(true, "screen-saver");

	if (isDev) {
		launcherWindow.loadURL("http://localhost:5173?mode=launcher");
	} else {
		launcherWindow.loadFile(paths.distIndexPath, {
			query: { mode: "launcher" },
		});
	}

	// Spotlight-style dismiss: losing focus hides it, same as the capture
	// popup closes on blur, but hide (not close/destroy) -- this window lives
	// for the whole app session.
	launcherWindow.on("blur", () => {
		if (!launcherWindow.isDestroyed() && launcherWindow.isVisible()) {
			launcherWindow.hide();
		}
	});

	// Never actually closes except on real app quit. Without this guard, any
	// stray close (Alt+F4 while it happens to have OS focus, a future "close"
	// call added elsewhere) would destroy the one instance the sub-50ms open
	// path depends on existing already.
	launcherWindow.on("close", (event) => {
		if (!getIsQuitting()) {
			event.preventDefault();
			launcherWindow.hide();
		}
	});

	return launcherWindow;
}

module.exports = { createLauncherWindow };
