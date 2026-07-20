const { BrowserWindow } = require("electron");

// ---------------------------------------------------------------------------
// Notch input window factory.
//
// A tiny always-on-top popup the notch opens when you tap a "capture" widget
// (add a task / note). Keeping input in its own focused window beats cramming
// a field into the notch itself, and it can be positioned wherever.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. main.cjs keeps
// ownership of the `notchInputWindow` and `pendingNotchInputPayload`
// module-level state; `deps.setPendingPayload` and `deps.onClosed` are
// callbacks so this factory can update both without reaching into main.cjs's
// module scope directly.
// ---------------------------------------------------------------------------

function createNotchInputWindow(payload, deps) {
	const { existingWindow, isDev, paths, setPendingPayload, onClosed } = deps;

	setPendingPayload(payload);

	if (existingWindow && !existingWindow.isDestroyed()) {
		existingWindow.webContents.send("notchInput:payload", payload);
		existingWindow.show();
		existingWindow.focus();
		return existingWindow;
	}

	const notchInputWindow = new BrowserWindow({
		width: 440,
		height: 260,
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

	notchInputWindow.setAlwaysOnTop(true, "screen-saver");

	if (isDev) {
		notchInputWindow.loadURL("http://localhost:5173?mode=notch-input");
	} else {
		notchInputWindow.loadFile(paths.distIndexPath, {
			query: { mode: "notch-input" },
		});
	}

	notchInputWindow.once("ready-to-show", () => {
		if (!notchInputWindow || notchInputWindow.isDestroyed()) {
			return;
		}
		notchInputWindow.show();
		notchInputWindow.focus();
	});

	// Capture popups are dismiss-on-blur, like a spotlight field.
	notchInputWindow.on("blur", () => {
		if (!notchInputWindow.isDestroyed()) {
			notchInputWindow.close();
		}
	});

	notchInputWindow.on("closed", () => {
		onClosed();
		setPendingPayload(null);
	});

	return notchInputWindow;
}

module.exports = { createNotchInputWindow };
