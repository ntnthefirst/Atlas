const { Menu, Tray, nativeImage } = require("electron");

// ---------------------------------------------------------------------------
// System tray icon + context menu.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. `Menu`, `Tray`,
// and `nativeImage` are required directly from `electron` -- stateless APIs,
// not main.cjs state.
//
// Like windows/notch-windows.cjs, this is a factory -- `createTrayManager(deps)`
// is called once and returns `ensureTray`, which every call site (the main and
// mini window close handlers, the notch window manager, the tray's own
// double-click) then calls with no arguments, exactly as it did when it was a
// bare `function ensureTray()` in main.cjs. The `tray` reference itself moves
// here too, as ordinary closure state (created once, reused after).
//
// deps:
// - `getNotchPreferences` is a getter, not a value, because `notchPreferences`
//   is a `let` main.cjs reassigns whenever preferences load or save -- a value
//   capture would freeze the tray's "Toggle Smart Notch" item onto whatever
//   preferences existed when the tray was first built, and it would keep
//   toggling that stale snapshot's `enabled` forever instead of the current one.
// - `showMainWindow` and `createMiniWindow` are plain values: both are
//   `function` declarations in main.cjs that are never reassigned.
// - `applyNotchPreferences` is likewise a plain value -- it's the stable
//   function windows/notch-windows.cjs's factory returns, not something
//   main.cjs itself reassigns.
// - `quitApp` is a callback, not inlined here, because setting `isQuitting`
//   is a main.cjs state mutation (read by the main/mini window "close" guards)
//   -- main.cjs owns that `let` and hands over a closure that flips it and
//   calls `app.quit()`, rather than this module reaching into main.cjs's scope.
// - `svgPath` is a plain value: main.cjs resolves the dev-vs-packaged favicon
//   path once (isDev never changes at runtime) using its own `__dirname`,
//   the same way it already pre-resolves `secondaryWindowPaths` for the
//   window factories -- rather than have this module recompute an
//   `__dirname`-relative path from one directory deeper (electron/services/
//   instead of electron/), which would be one `".."` short of correct.
// ---------------------------------------------------------------------------

function createTrayManager(deps) {
	const { svgPath, showMainWindow, createMiniWindow, getNotchPreferences, applyNotchPreferences, quitApp } = deps;

	let tray = null;

	function getTrayIcon() {
		const icon = nativeImage.createFromPath(svgPath);
		if (!icon.isEmpty()) {
			return icon.resize({ width: 16, height: 16 });
		}
		return nativeImage.createFromDataURL(
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z6xQAAAAASUVORK5CYII=",
		);
	}

	function ensureTray() {
		if (tray) {
			return tray;
		}

		tray = new Tray(getTrayIcon());
		tray.setToolTip("Atlas");
		tray.on("double-click", () => {
			showMainWindow();
		});

		const contextMenu = Menu.buildFromTemplate([
			{ label: "Show Atlas", click: () => showMainWindow() },
			{ label: "Open Mini Window", click: () => createMiniWindow() },
			{
				label: "Toggle Smart Notch",
				click: () =>
					applyNotchPreferences({ ...getNotchPreferences(), enabled: !getNotchPreferences().enabled }),
			},
			{ type: "separator" },
			{
				label: "Quit",
				click: () => {
					quitApp();
				},
			},
		]);
		tray.setContextMenu(contextMenu);
		return tray;
	}

	return { ensureTray };
}

module.exports = { createTrayManager };
