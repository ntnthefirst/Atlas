const { BrowserWindow, screen } = require("electron");
const { computeNotchBounds, selectTargetDisplays } = require("./notch-geometry.cjs");

// ---------------------------------------------------------------------------
// Notch window lifecycle (the stateful half).
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. The pure geometry
// math (docked/free positioning, which displays to target) already lived in
// windows/notch-geometry.cjs; this is everything that actually creates,
// positions, and tears down the notch's BrowserWindows -- one per targeted
// display, tracked in the `notchWindows` Map this module now owns.
//
// Unlike settings-window.cjs/action-editor-window.cjs (a single factory that
// takes `deps` per call), this module exports a *factory of functions*:
// `createNotchWindowManager(deps)` is called once, near the top of main.cjs,
// and returns the same six function names plus the `notchWindows` Map, all
// closing over one shared `deps` object. That shape exists because these
// functions call each other constantly (syncNotchWindows calls
// shouldNotchBeActive, getTargetDisplays and createNotchWindowForDisplay;
// applyNotchPreferences calls syncNotchWindows and positionNotchWindow) --
// threading `deps` through every individual call, the way the per-call window
// factories do, would mean re-passing the same object at every one of those
// internal call sites for no benefit.
//
// `BrowserWindow` and `screen` are required directly from `electron` --
// they're stateless Electron APIs, not main.cjs state.
//
// deps:
// - `getNotchPreferences` is a getter, not a value, because `notchPreferences`
//   is a `let` main.cjs reassigns every time preferences load, save, or the
//   active environment changes (see main.cjs's `saveNotchPreferences`/
//   `refreshActiveNotchPreferences`, neither of which moved here) -- a value
//   capture here would freeze this module onto whatever `notchPreferences`
//   was when the manager was created, before any prefs are ever read. Every
//   function below calls it fresh rather than
//   caching the result, except where a function already holds the exact
//   object `saveNotchPreferences` just returned (see `applyNotchPreferences`)
//   -- reusing that local is equivalent, not a stale capture, since nothing
//   else can reassign `notchPreferences` in between.
// - `saveNotchPreferences` is a plain value: a `function` declaration in
//   main.cjs that is never itself reassigned. Calling it is how this module
//   propagates a change back to main.cjs's `notchPreferences` -- the same
//   mutate-then-save round trip the original code did in place.
// - `getMainWindow` is a getter for the same reason: `mainWindow` is a `let`
//   main.cjs reassigns throughout its lifecycle (created/closed/destroyed).
//   Used only by `shouldNotchBeActive`'s "withMain" activation check.
// - `ensureTray` is a plain value: a `function` declaration in main.cjs
//   (staying there until WP-0.2's tray extraction) that this module calls
//   whenever a notch window is created, exactly as main.cjs did inline.
// - `isDev` is a plain value: a `const` computed once from `app.isPackaged`
//   and never reassigned.
// - `paths` is the same shared `secondaryWindowPaths` object main.cjs already
//   builds for the other secondary window factories (only `preloadPath` and
//   `distIndexPath` are read here; the notch window sets no icon).
// ---------------------------------------------------------------------------

function createNotchWindowManager(deps) {
	const { getNotchPreferences, saveNotchPreferences, getMainWindow, ensureTray, isDev, paths } = deps;

	// Keyed by display id, since the notch can be shown on multiple screens at once.
	const notchWindows = new Map();

	// Resolves which displays should currently show a notch. Falls back to the
	// primary display whenever the saved selection is empty or none of the saved
	// ids are connected, so there's always at least one.
	function getTargetDisplays() {
		const displays = screen.getAllDisplays();
		const primary = screen.getPrimaryDisplay();
		return selectTargetDisplays(displays, primary, getNotchPreferences().displayIds);
	}

	function positionNotchWindow(notchWindow, display, width, height) {
		if (!notchWindow || notchWindow.isDestroyed()) {
			return;
		}
		const prefs = getNotchPreferences();
		const isPrimary = display.id === screen.getPrimaryDisplay().id;
		const bounds = computeNotchBounds({
			workArea: display.workArea,
			width,
			height,
			position: prefs.position,
			isPrimary,
			freeX: prefs.x,
			freeY: prefs.y,
		});

		notchWindow.setBounds(bounds);
	}

	function createNotchWindowForDisplay(display) {
		const existing = notchWindows.get(display.id);
		if (existing && !existing.isDestroyed()) {
			existing.show();
			return existing;
		}

		const prefs = getNotchPreferences();
		const notchWindow = new BrowserWindow({
			width: 300,
			height: 70,
			frame: false,
			transparent: true,
			backgroundColor: "#00000000",
			hasShadow: false,
			alwaysOnTop: true,
			skipTaskbar: true,
			resizable: false,
			maximizable: false,
			minimizable: false,
			fullscreenable: false,
			movable: prefs.position === "free" && !prefs.locked,
			focusable: true,
			webPreferences: {
				preload: paths.preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});

		notchWindow.notchDisplayId = display.id;
		notchWindow.setAlwaysOnTop(true, "screen-saver");

		if (isDev) {
			notchWindow.loadURL("http://localhost:5173?mode=notch");
		} else {
			notchWindow.loadFile(paths.distIndexPath, {
				query: { mode: "notch" },
			});
		}

		notchWindow.on("moved", () => {
			if (notchWindow.isDestroyed()) {
				return;
			}
			// Only the primary display's free position is persisted; other displays
			// keep their own default placement.
			const current = getNotchPreferences();
			if (current.position === "free" && display.id === screen.getPrimaryDisplay().id) {
				const [x, y] = notchWindow.getPosition();
				current.x = x;
				current.y = y;
				saveNotchPreferences(current);
			}
		});

		notchWindow.on("closed", () => {
			if (notchWindows.get(display.id) === notchWindow) {
				notchWindows.delete(display.id);
			}
		});

		// Lets the renderer close an open tab panel when the user clicks anywhere
		// outside the notch window (another app, the desktop, the main window).
		notchWindow.on("blur", () => {
			if (!notchWindow.isDestroyed()) {
				notchWindow.webContents.send("notch:blur");
			}
		});

		notchWindows.set(display.id, notchWindow);
		positionNotchWindow(notchWindow, display, 300, 70);
		ensureTray();
		return notchWindow;
	}

	function shouldNotchBeActive() {
		const prefs = getNotchPreferences();
		if (!prefs.enabled) {
			return false;
		}
		if (prefs.activation === "withMain") {
			const mainWindow = getMainWindow();
			return Boolean(mainWindow && !mainWindow.isDestroyed());
		}
		return true;
	}

	// Creates/destroys notch windows to match shouldNotchBeActive() and the
	// selected displays. Call this whenever notch preferences change, the main
	// window's lifecycle changes, or the connected displays change.
	function syncNotchWindows() {
		if (!shouldNotchBeActive()) {
			for (const notchWindow of notchWindows.values()) {
				if (!notchWindow.isDestroyed()) {
					notchWindow.destroy();
				}
			}
			notchWindows.clear();
			return;
		}

		const targets = getTargetDisplays();
		const targetIds = new Set(targets.map((display) => display.id));

		for (const [displayId, notchWindow] of [...notchWindows]) {
			if (!targetIds.has(displayId)) {
				if (!notchWindow.isDestroyed()) {
					notchWindow.destroy();
				}
				notchWindows.delete(displayId);
			}
		}

		for (const display of targets) {
			const existing = notchWindows.get(display.id);
			if (!existing || existing.isDestroyed()) {
				createNotchWindowForDisplay(display);
			}
		}
	}

	// Re-renders every notch window to match `prefs` and broadcasts the
	// change to every window, WITHOUT persisting anything. Split out of
	// applyNotchPreferences (WP-1.3) because "the effective preferences
	// changed" now has two different causes that must NOT both trigger a
	// save: a genuine edit (applyNotchPreferences, below, which still saves
	// first) and the active ENVIRONMENT changing, where `prefs` is already
	// exactly what's on disk (that environment's own layout, or the global
	// default) and re-saving it would be redundant at best -- and, for an
	// environment with no override, would incorrectly promote the global
	// default into a real per-environment override the instant someone
	// merely switched into it.
	function renderNotchPreferences(prefs) {
		syncNotchWindows();
		for (const [displayId, notchWindow] of notchWindows) {
			if (notchWindow.isDestroyed()) {
				continue;
			}
			notchWindow.setMovable(prefs.position === "free" && !prefs.locked);
			const display =
				screen.getAllDisplays().find((item) => item.id === displayId) ?? screen.getPrimaryDisplay();
			const [width, height] = notchWindow.getContentSize();
			positionNotchWindow(notchWindow, display, width, height);
		}

		for (const browserWindow of BrowserWindow.getAllWindows()) {
			if (!browserWindow.isDestroyed()) {
				browserWindow.webContents.send("notch:preferences-changed", prefs);
			}
		}
		return prefs;
	}

	function applyNotchPreferences(next) {
		const prefs = saveNotchPreferences(next);
		return renderNotchPreferences(prefs);
	}

	return {
		notchWindows,
		getTargetDisplays,
		positionNotchWindow,
		createNotchWindowForDisplay,
		shouldNotchBeActive,
		syncNotchWindows,
		applyNotchPreferences,
		renderNotchPreferences,
	};
}

module.exports = { createNotchWindowManager };
