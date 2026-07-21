const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen } = require("electron");
const { autoUpdater } = require("electron-updater");

const { AtlasDatabase } = require("./db.cjs");
const { ActivityTracker } = require("./activity-tracker.cjs");
const { EventLog } = require("./services/event-log.cjs");
const { loadAiPreferences } = require("./ai.cjs");
const { NOTCH_PREFS_FILE, defaultNotchPreferences, normalizeNotchPreferences } = require("./config/notch-prefs.cjs");
const { GLOBAL_DEFAULT_NOTCH_LAYOUT_ID } = require("./config/notch-layouts.cjs");
const { createNotchWindowManager } = require("./windows/notch-windows.cjs");
const { createTrayManager } = require("./services/tray.cjs");
const { createSettingsWindow: createSettingsWindowModule } = require("./windows/settings-window.cjs");
const {
	createActionEditorWindow: createActionEditorWindowModule,
} = require("./windows/action-editor-window.cjs");
const { createNotchInputWindow: createNotchInputWindowModule } = require("./windows/notch-input-window.cjs");
const {
	DASHBOARD_PREFS_FILE,
	defaultDashboardPreferences,
	normalizeDashboardPreferences,
} = require("./config/dashboard-prefs.cjs");
const {
	getUpdatePreferences,
	loadUpdatePreferences,
	saveUpdatePreferences,
	fetchReleases,
	checkLatestGitHubVersion,
	performInAppUpdate,
} = require("./services/updater.cjs");
const {
	getFocusState,
	rollFocusStatsIfNeeded,
	loadFocusPreferences,
	startFocusEngine,
	startFocus,
	pauseFocus,
	resumeFocus,
	advanceFocusPhase,
	stopFocus,
	setFocusGoal,
	updateFocusConfig,
} = require("./services/focus-engine.cjs");
const { register: registerTaskIpc } = require("./ipc/tasks.cjs");
const { register: registerNoteIpc } = require("./ipc/notes.cjs");
const { register: registerEnvironmentIpc } = require("./ipc/environments.cjs");
const { register: registerSessionIpc } = require("./ipc/sessions.cjs");
const { register: registerActivityIpc } = require("./ipc/activity.cjs");
const { register: registerInsightsIpc } = require("./ipc/insights.cjs");
const { register: registerWindowsIpc } = require("./ipc/windows.cjs");
const { register: registerAppIpc } = require("./ipc/app.cjs");
const { register: registerFocusIpc } = require("./ipc/focus.cjs");
const { register: registerNotchIpc } = require("./ipc/notch.cjs");
const { register: registerAiIpc } = require("./ipc/ai.cjs");
const { register: registerSystemIpc } = require("./ipc/system.cjs");
const { register: registerIsolationIpc } = require("./ipc/isolation.cjs");

let mainWindow = null;
let miniWindow = null;
let welcomeWindow = null;
let settingsWindow = null;
let actionEditorWindow = null;
let notchInputWindow = null;
// Payload (what to capture, for which environment) handed to the notch input
// popup once it loads, since a freshly created window can't receive it on the
// constructor.
let pendingNotchInputPayload = null;
let isQuitting = false;
let db = null;
let tracker = null;
let eventLog = null;

const isDev = !app.isPackaged;
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

// Windows draws its own minimize/maximize/close glyphs into our frameless
// window via titleBarOverlay, so unlike the rest of the UI those buttons
// can't pick up dark: classes - they need their colors pushed from here,
// in sync with whatever theme is currently active.
function getTitleBarOverlay() {
	if (!isWindows) {
		return false;
	}
	return nativeTheme.shouldUseDarkColors
		? { color: "#2a2a2a", symbolColor: "#e2e2e2", height: 49 }
		: { color: "#f7f7f7", symbolColor: "#4a4a4a", height: 49 };
}
const APP_USER_MODEL_ID = isDev ? "com.atlas.app.dev" : "com.atlas.app";

let notchPreferences = { ...defaultNotchPreferences };
let dashboardPreferences = { ...defaultDashboardPreferences };
// WP-1.3: which environment is currently active, for Notch layout
// resolution purposes -- set by setActiveEnvironment(), called from the
// `environment:switch` IPC handler (environments.cjs) whenever the renderer
// reports a switch (App.tsx and NotchApp.tsx's own environment switcher both
// call it). `null` until the first switch happens (e.g. at boot, before any
// window has reported anything), which resolves to the global default --
// exactly like an environment whose own config has no override.
let currentEnvironmentId = null;
// Tracks which notch_layouts row `notchPreferences` currently reflects --
// GLOBAL_DEFAULT_NOTCH_LAYOUT_ID, or a specific environment's own layout id
// -- so saveNotchPreferences() (live edits made through the Notch itself:
// dragging the free-floating window, opacity/lock/activation toggles, the
// tray's "Toggle Smart Notch") writes back to the SAME row the in-memory
// value was resolved from, rather than always writing the default.
let activeNotchLayoutId = GLOBAL_DEFAULT_NOTCH_LAYOUT_ID;

if (isDev) {
	// Keep development state fully isolated from the installed production app.
	const devUserDataPath = path.join(app.getPath("appData"), "Atlas-Dev");
	app.setPath("userData", devUserDataPath);
}

function createMainWindow() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.show();
		mainWindow.focus();
		syncNotchWindows();
		return mainWindow;
	}

	const iconPath = isDev
		? path.join(__dirname, "..", "src", "assets", "logosmall.png")
		: path.join(__dirname, "..", "dist", "assets", "logosmall.png");

	mainWindow = new BrowserWindow({
		width: 1320,
		height: 860,
		minWidth: 760,
		minHeight: 600,
		backgroundColor: "#070707",
		icon: iconPath,
		frame: isMac,
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		titleBarOverlay: getTitleBarOverlay(),
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		mainWindow.loadURL("http://localhost:5173");
	} else {
		mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
	}

	mainWindow.on("close", (event) => {
		if (isQuitting) {
			return;
		}
		const hasActiveSession = Boolean(db && db.getActiveSession());
		if (hasActiveSession || miniWindow) {
			event.preventDefault();
			if (hasActiveSession) {
				createMiniWindow();
			}
			mainWindow.hide();
			ensureTray();
		}
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
		syncNotchWindows();
	});

	applyNativeTheme(
		nativeTheme.themeSource === "system" ? "system" : nativeTheme.shouldUseDarkColors ? "dark" : "light",
	);

	if (welcomeWindow && !welcomeWindow.isDestroyed()) {
		welcomeWindow.close();
	}

	syncNotchWindows();
	return mainWindow;
}

function createWelcomeWindow() {
	if (welcomeWindow && !welcomeWindow.isDestroyed()) {
		welcomeWindow.show();
		welcomeWindow.focus();
		return welcomeWindow;
	}

	welcomeWindow = new BrowserWindow({
		width: 720,
		height: 660,
		minWidth: 620,
		minHeight: 560,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		title: "Atlas - Welcome",
		backgroundColor: "#070707",
		icon: isDev
			? path.join(__dirname, "..", "src", "assets", "logosmall.png")
			: path.join(__dirname, "..", "dist", "assets", "logosmall.png"),
		frame: isMac,
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		titleBarOverlay: getTitleBarOverlay(),
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		welcomeWindow.loadURL("http://localhost:5173?mode=welcome");
	} else {
		welcomeWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
			query: { mode: "welcome" },
		});
	}

	welcomeWindow.on("closed", () => {
		welcomeWindow = null;
	});

	if (miniWindow && !miniWindow.isDestroyed()) {
		miniWindow.destroy();
	}

	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.destroy();
	}

	return welcomeWindow;
}

// Resolved once (isDev/__dirname never change at runtime) and shared by the
// three secondary window wrappers below. createMainWindow/createWelcomeWindow/
// createMiniWindow intentionally keep their own inline copies of these same
// paths -- out of scope for this extraction (WP-0.2).
const secondaryWindowPaths = {
	iconPath: isDev
		? path.join(__dirname, "..", "src", "assets", "logosmall.png")
		: path.join(__dirname, "..", "dist", "assets", "logosmall.png"),
	preloadPath: path.join(__dirname, "preload.cjs"),
	distIndexPath: path.join(__dirname, "..", "dist", "index.html"),
};
const traySvgPath = isDev
	? path.join(__dirname, "..", "public", "favicon.svg")
	: path.join(__dirname, "..", "dist", "favicon.svg");

// See electron/windows/notch-windows.cjs's header for why this is a factory
// call (not a per-call `deps` argument like the window factories above) and
// why getNotchPreferences/getMainWindow are getters rather than values.
//
// `ensureTray` is a lazy reference (`() => trayManager.ensureTray()`), not the
// plain value it looks like it should be, to break a construction-order cycle:
// this manager needs `ensureTray` (from `trayManager`, built below) and
// `trayManager` needs `applyNotchPreferences` (from this manager) -- neither
// is actually *called* until well after both factories have finished
// constructing (a notch window isn't created, and the tray isn't built,
// during this synchronous setup), so the arrow function's `trayManager`
// reference only needs to resolve by call time, not by the time this object
// literal is evaluated. Same trick as every other getter here, just closing
// over a `const` assigned two statements down instead of a reassigned `let`.
const notchWindowManager = createNotchWindowManager({
	getNotchPreferences: () => notchPreferences,
	saveNotchPreferences,
	getMainWindow: () => mainWindow,
	ensureTray: () => trayManager.ensureTray(),
	isDev,
	paths: secondaryWindowPaths,
});
const {
	notchWindows,
	positionNotchWindow,
	shouldNotchBeActive,
	syncNotchWindows,
	applyNotchPreferences,
	renderNotchPreferences,
} = notchWindowManager;

// `quitApp` is a callback (not inlined in tray.cjs) because flipping
// `isQuitting` is main.cjs's own state mutation, read by the main/mini window
// "close" handlers below -- tray.cjs never touches that `let` directly.
const trayManager = createTrayManager({
	svgPath: traySvgPath,
	showMainWindow,
	createMiniWindow,
	getNotchPreferences: () => notchPreferences,
	applyNotchPreferences,
	quitApp: () => {
		isQuitting = true;
		app.quit();
	},
});
const { ensureTray } = trayManager;

function createSettingsWindow(parentWindow = null) {
	settingsWindow = createSettingsWindowModule(parentWindow, {
		existingWindow: settingsWindow,
		isDev,
		isMac,
		titleBarOverlay: getTitleBarOverlay(),
		paths: secondaryWindowPaths,
		onClosed: () => {
			settingsWindow = null;
		},
	});
	return settingsWindow;
}

// A standalone window for editing the notch's action-button tabs/grids —
// the same editor embedded in Settings, but reachable directly from a button
// on the notch itself without going through the full Settings window.
function createActionEditorWindow(parentWindow = null) {
	actionEditorWindow = createActionEditorWindowModule(parentWindow, {
		existingWindow: actionEditorWindow,
		isDev,
		isMac,
		titleBarOverlay: getTitleBarOverlay(),
		paths: secondaryWindowPaths,
		onClosed: () => {
			actionEditorWindow = null;
		},
	});
	return actionEditorWindow;
}

// A tiny always-on-top popup the notch opens when you tap a "capture" widget
// (add a task / note). Keeping input in its own focused window beats cramming
// a field into the notch itself, and it can be positioned wherever.
function createNotchInputWindow(payload) {
	notchInputWindow = createNotchInputWindowModule(payload, {
		existingWindow: notchInputWindow,
		isDev,
		paths: secondaryWindowPaths,
		setPendingPayload: (value) => {
			pendingNotchInputPayload = value;
		},
		onClosed: () => {
			notchInputWindow = null;
		},
	});
	return notchInputWindow;
}

function hasAnyEnvironments() {
	return Boolean(db && db.listEnvironments().length > 0);
}

function openPrimaryWindowByEnvironmentState() {
	if (hasAnyEnvironments()) {
		createMainWindow();
	} else {
		createWelcomeWindow();
	}
	syncNotchWindows();
}

function applyNativeTheme(theme) {
	if (!isWindows) {
		return;
	}

	if (theme === "system") {
		nativeTheme.themeSource = "system";
		const systemTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
		applyNativeTheme(systemTheme);
		return;
	}

	nativeTheme.themeSource = theme;
	const overlay = getTitleBarOverlay();

	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.setTitleBarOverlay(overlay);
	}

	if (settingsWindow && !settingsWindow.isDestroyed()) {
		settingsWindow.setTitleBarOverlay(overlay);
	}

	if (welcomeWindow && !welcomeWindow.isDestroyed()) {
		welcomeWindow.setTitleBarOverlay(overlay);
	}

	if (actionEditorWindow && !actionEditorWindow.isDestroyed()) {
		actionEditorWindow.setTitleBarOverlay(overlay);
	}
}

nativeTheme.on("updated", () => {
	if (nativeTheme.themeSource === "system") {
		applyNativeTheme("system");
	}
});

function showMainWindow() {
	if (!hasAnyEnvironments()) {
		createWelcomeWindow();
		return;
	}

	if (!mainWindow) {
		createMainWindow();
		return;
	}
	if (mainWindow.isMinimized()) {
		mainWindow.restore();
	}
	mainWindow.show();
	mainWindow.focus();
}

function createMiniWindow() {
	if (miniWindow) {
		miniWindow.show();
		miniWindow.focus();
		return miniWindow;
	}

	miniWindow = new BrowserWindow({
		width: 320,
		height: 168,
		minWidth: 290,
		minHeight: 150,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		alwaysOnTop: true,
		autoHideMenuBar: true,
		transparent: true,
		backgroundColor: "#00000000",
		icon: isDev
			? path.join(__dirname, "..", "src", "assets", "logosmall.png")
			: path.join(__dirname, "..", "dist", "assets", "logosmall.png"),
		frame: false,
		titleBarStyle: "hidden",
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		miniWindow.loadURL("http://localhost:5173?mode=mini");
	} else {
		miniWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
			query: { mode: "mini" },
		});
	}

	miniWindow.on("close", (event) => {
		if (isQuitting) {
			return;
		}

		const hasActiveSession = Boolean(db && db.getActiveSession());
		const canRevealMain = Boolean(mainWindow && !mainWindow.isDestroyed());

		if (!hasActiveSession || canRevealMain) {
			if (canRevealMain && mainWindow.isVisible() === false) {
				showMainWindow();
			}
			return;
		}

		event.preventDefault();
	});

	miniWindow.on("closed", () => {
		miniWindow = null;
	});

	ensureTray();
	return miniWindow;
}

// WP-1.3: persists a live edit to WHICHEVER layout is currently active
// (`activeNotchLayoutId` -- the global default, or one environment's own
// override), never unconditionally to "the" layout the way the pre-WP-1.3
// version of this function did. This is what the Notch's own live controls
// (drag-to-move, opacity, lock, activation, the tray's "Toggle Smart Notch")
// go through via applyNotchPreferences -- see notch-windows.cjs. The
// Settings-window/Action-editor tabs+grid editors deliberately do NOT use
// this path (see ipc/notch.cjs's notch:setDefaultLayout/
// notch:setEnvironmentLayout) -- ambient "whatever's active" is correct for
// the live notch chrome, but would be a real bug for an editor that isn't
// necessarily showing the currently-active environment.
function saveNotchPreferences(value) {
	notchPreferences = normalizeNotchPreferences(value);
	if (db) {
		db.setNotchLayout(activeNotchLayoutId, notchPreferences);
	}
	// Keeps the legacy flat file in sync for at least one release (D3: a
	// migration must be reversible), but ONLY while editing the GLOBAL
	// DEFAULT -- a pre-WP-1.3 build has no concept of a per-environment
	// override, so writing an override's contents here would silently hand
	// an older build (or a downgrade) somebody else's environment-specific
	// layout instead of the shared default it actually expects.
	if (activeNotchLayoutId === GLOBAL_DEFAULT_NOTCH_LAYOUT_ID) {
		try {
			fs.writeFileSync(
				path.join(app.getPath("userData"), NOTCH_PREFS_FILE),
				JSON.stringify(notchPreferences, null, 2),
				"utf8",
			);
		} catch {
			// Non-blocking: notch still works with in-memory preferences.
		}
	}
	return notchPreferences;
}

// Re-resolves the effective Notch preferences for whichever environment is
// currently active (`currentEnvironmentId`) and re-renders every notch
// window to match, WITHOUT touching storage -- the DB already has whatever
// `db.getEffectiveNotchPreferences` returns; this only updates the in-memory
// mirror (`notchPreferences`/`activeNotchLayoutId`) that saveNotchPreferences
// and the IPC layer read. Called on every environment switch (live
// switching, WP-1.3's headline feature) and after any editor-driven change
// to a layout that might affect what's currently showing.
//
// Falls back to schema defaults directly (not through the db) when `db`
// isn't open yet -- this can run once, at boot, before AtlasDatabase.create()
// resolves.
function refreshActiveNotchPreferences() {
	const resolved = db
		? db.getEffectiveNotchPreferences(currentEnvironmentId)
		: { usesDefault: true, layoutId: GLOBAL_DEFAULT_NOTCH_LAYOUT_ID, preferences: { ...defaultNotchPreferences } };
	notchPreferences = resolved.preferences;
	activeNotchLayoutId = resolved.layoutId;
	renderNotchPreferences(notchPreferences);
	return resolved;
}

// The live-switching wire-up (WP-1.3): called from the `environment:switch`
// IPC handler whenever the renderer (App.tsx, or the Notch's own environment
// switcher -- see NotchApp.tsx's onSwitchEnvironment) reports the active
// environment changed. Updates which environment Notch resolution follows,
// then immediately re-resolves and re-renders -- no restart, matching this
// package's acceptance criteria.
function setActiveEnvironment(environmentId) {
	currentEnvironmentId = environmentId || null;
	return refreshActiveNotchPreferences();
}

function loadDashboardPreferences() {
	try {
		const raw = fs.readFileSync(path.join(app.getPath("userData"), DASHBOARD_PREFS_FILE), "utf8");
		dashboardPreferences = normalizeDashboardPreferences(JSON.parse(raw));
	} catch {
		dashboardPreferences = normalizeDashboardPreferences(null);
	}
	return dashboardPreferences;
}

function saveDashboardPreferences(value) {
	dashboardPreferences = normalizeDashboardPreferences(value);
	try {
		fs.writeFileSync(
			path.join(app.getPath("userData"), DASHBOARD_PREFS_FILE),
			JSON.stringify(dashboardPreferences, null, 2),
			"utf8",
		);
	} catch {
		// Non-blocking: dashboard still works with in-memory preferences.
	}
	// Broadcast so a layout edited in one window (e.g. the main window's own
	// edit mode) reflects anywhere else the dashboard might be shown.
	for (const browserWindow of BrowserWindow.getAllWindows()) {
		if (!browserWindow.isDestroyed()) {
			browserWindow.webContents.send("dashboard:layout-changed", dashboardPreferences);
		}
	}
	return dashboardPreferences;
}


function wireIpc() {
	registerEnvironmentIpc(ipcMain, {
		getDb: () => db,
		openPrimaryWindowByEnvironmentState,
		getEventLog: () => eventLog,
		setActiveEnvironment,
	});

	registerSessionIpc(ipcMain, {
		getDb: () => db,
		getTracker: () => tracker,
		getMiniWindow: () => miniWindow,
		getEventLog: () => eventLog,
	});

	registerActivityIpc(ipcMain, { getDb: () => db, getTracker: () => tracker });

	registerTaskIpc(ipcMain, { getDb: () => db, getEventLog: () => eventLog });

	registerNoteIpc(ipcMain, { getDb: () => db, getEventLog: () => eventLog });

	registerInsightsIpc(ipcMain, { getDb: () => db, getEventLog: () => eventLog });

	registerWindowsIpc(ipcMain, {
		getMainWindow: () => mainWindow,
		getWelcomeWindow: () => welcomeWindow,
		getMiniWindow: () => miniWindow,
		getDb: () => db,
		applyNativeTheme,
		createMiniWindow,
		createSettingsWindow,
		createActionEditorWindow,
		createNotchInputWindow,
		showMainWindow,
	});

	registerAppIpc(ipcMain, {
		getUpdatePreferences,
		saveUpdatePreferences,
		fetchReleases,
		performInAppUpdate,
		isWindows,
	});

	registerFocusIpc(ipcMain, {
		getFocusState,
		rollFocusStatsIfNeeded,
		startFocus,
		pauseFocus,
		resumeFocus,
		advanceFocusPhase,
		stopFocus,
		setFocusGoal,
		updateFocusConfig,
	});

	registerNotchIpc(ipcMain, {
		getDb: () => db,
		getNotchPreferences: () => notchPreferences,
		applyNotchPreferences,
		positionNotchWindow,
		getPendingNotchInputPayload: () => pendingNotchInputPayload,
		getCurrentEnvironmentId: () => currentEnvironmentId,
		refreshActiveNotchPreferences,
	});

	registerSystemIpc(ipcMain, {
		getDashboardPreferences: () => dashboardPreferences,
		saveDashboardPreferences,
	});

	registerAiIpc(ipcMain);

	registerIsolationIpc(ipcMain);
}

app.whenReady().then(async () => {
	loadUpdatePreferences();
	loadDashboardPreferences();
	loadFocusPreferences();
	loadAiPreferences();
	startFocusEngine();
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;

	const iconPath = isDev
		? path.join(__dirname, "..", "src", "assets", "logosmall.png")
		: path.join(__dirname, "..", "dist", "assets", "logosmall.png");

	const dbPath = path.join(app.getPath("userData"), "atlas.db");
	try {
		db = await AtlasDatabase.create(dbPath);
	} catch (error) {
		// AtlasDatabase.create() throws if an existing (pre-WP-0.3) database
		// fails to import into the new engine — e.g. a row-count mismatch or a
		// corrupt/partial file. In every such case it has already left the
		// original database untouched and (if it got far enough to attempt the
		// import) saved a timestamped backup alongside it, so this is safe to
		// surface rather than silently crash: nothing about the user's data has
		// been destroyed.
		console.error("[Atlas] Failed to open the database:", error);
		dialog.showErrorBox(
			"Atlas failed to start",
			"Atlas could not open its database and cannot continue.\n\n" +
				`${error instanceof Error ? error.message : String(error)}\n\n` +
				"Your existing data has not been modified.",
		);
		app.quit();
		return;
	}

	// WP-1.3: now that the database (and therefore the Notch layout store) is
	// open, resolve the in-memory notch preferences from it instead of the
	// schema-default placeholder `notchPreferences` was declared with. No
	// environment is active yet at boot (`currentEnvironmentId` starts null),
	// so this resolves straight to the global default -- the seeded/migrated
	// contents of the pre-existing notch-preferences.json (see
	// electron/migrations/notch-layout-seed.cjs), exactly what
	// loadNotchPreferences() used to read directly from that same file.
	refreshActiveNotchPreferences();

	// CRITICAL: Finalize any stranded sessions from crashes or ungraceful shutdowns
	// This prevents old sessions from being resumed and continuing to accumulate time
	const repairResults = db.finalizeStrandedSessions();
	if (repairResults.finalized > 0) {
		console.log(`[Atlas] Finalized ${repairResults.finalized} stranded session(s) from previous crash.`);
	}

	// Event log (WP-0.5). Prune before anything can write, inside a
	// transaction, so a database that's been sitting around across an update
	// doesn't carry more history than the retention policy allows for even one
	// extra boot. Start the writer's flush timer only after that.
	eventLog = new EventLog(db);
	try {
		const pruned = eventLog.pruneNow();
		if (pruned.deletedByAge > 0 || pruned.deletedByCap > 0) {
			console.log(
				`[Atlas] Event log retention: pruned ${pruned.deletedByAge} event(s) past the retention window and ${pruned.deletedByCap} over the row cap.`,
			);
		}
	} catch (error) {
		console.error("[Atlas] Event log retention prune failed:", error);
	}
	eventLog.start();

	tracker = new ActivityTracker(db, eventLog);
	tracker.start();

	const activeSession = db.getActiveSession();
	if (activeSession) {
		tracker.setCurrentSession(activeSession.id);
	}

	// Set app icon for dock and taskbar
	if (isMac) {
		app.dock.setIcon(iconPath);
	} else {
		app.setAppUserModelId(APP_USER_MODEL_ID);
	}

	wireIpc();
	openPrimaryWindowByEnvironmentState();
	if (getUpdatePreferences().autoCheck) {
		void checkLatestGitHubVersion(getUpdatePreferences().includeBeta);
	}

	// Re-sync notch windows whenever a monitor is connected/disconnected so the
	// selection (and the "always at least one" fallback) stays accurate.
	screen.on("display-added", () => syncNotchWindows());
	screen.on("display-removed", () => syncNotchWindows());

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			openPrimaryWindowByEnvironmentState();
		} else {
			openPrimaryWindowByEnvironmentState();
		}
	});

	if (process.env.ATLAS_WINDOW_SELFCHECK === "1") {
		runWindowSelfCheck();
	}
});

// Opens every window type once and reports whether each was actually created,
// then exits. Gated behind an env var and invoked by `npm run smoke:windows`.
//
// This exists because nothing else can verify the window layer: a vitest suite
// cannot construct a BrowserWindow, and a plain boot only proves the first
// window opened. Moving window code between modules (WP-0.2) can easily break
// a window that is only created on demand, and without this the breakage would
// not surface until a user clicked the thing.
function runWindowSelfCheck() {
	const results = [];
	const record = (label, ok) => results.push({ label, ok: Boolean(ok) });

	const alive = (win) => win && !win.isDestroyed();

	record("primary (main or welcome)", alive(mainWindow) || alive(welcomeWindow));

	createMiniWindow();
	record("mini", alive(miniWindow));

	createSettingsWindow();
	record("settings", alive(settingsWindow));

	createActionEditorWindow();
	record("action editor", alive(actionEditorWindow));

	createNotchInputWindow({ kind: "task" });
	record("notch input", alive(notchInputWindow));

	// The notch is only expected to exist when preferences say it should be
	// active, so an inactive notch is a pass, not a missing window.
	syncNotchWindows();
	record("notch", shouldNotchBeActive() ? notchWindows.size > 0 : true);

	let failed = 0;
	for (const result of results) {
		if (!result.ok) {
			failed += 1;
		}
		console.log(`  ${result.ok ? "PASS" : "FAIL"}  window: ${result.label}`);
	}

	console.log(failed === 0 ? "ALL WINDOWS OPENED" : `${failed} WINDOW(S) FAILED`);
	app.exit(failed === 0 ? 0 : 1);
}

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("before-quit", () => {
	isQuitting = true;
	if (tracker) {
		tracker.stop();
	}
	if (eventLog) {
		// Nothing may be lost on a clean quit: stop the timer (no point letting
		// it fire again) and flush whatever is still buffered, synchronously,
		// before the process actually exits.
		eventLog.stop();
		eventLog.flushNow();
	}
});
