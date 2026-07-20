const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	Notification,
	Tray,
	nativeImage,
	nativeTheme,
	screen,
} = require("electron");
const { autoUpdater } = require("electron-updater");

const { AtlasDatabase } = require("./db.cjs");
const { ActivityTracker } = require("./activity-tracker.cjs");
const { getSystemStats, listOpenApps } = require("./system-info.cjs");
const { loadAiPreferences, getPublicAiConfig, setAiConfig, aiComplete } = require("./ai.cjs");
const { compareVersionStrings, normalizeReleaseList } = require("./services/version.cjs");
const { NOTCH_PREFS_FILE, defaultNotchPreferences, normalizeNotchPreferences } = require("./config/notch-prefs.cjs");
const { computeNotchBounds, selectTargetDisplays } = require("./windows/notch-geometry.cjs");
const {
	DASHBOARD_PREFS_FILE,
	defaultDashboardPreferences,
	normalizeDashboardPreferences,
} = require("./config/dashboard-prefs.cjs");
const { fetchJson } = require("./services/http.cjs");
const {
	UPDATE_PREFS_FILE,
	defaultUpdatePreferences,
	normalizeUpdatePreferences,
} = require("./config/update-prefs.cjs");
const {
	FOCUS_PREFS_FILE,
	FOCUS_NUDGE_KINDS,
	defaultFocusConfig,
	NUDGE_COPY,
	todayKey,
	normalizeFocusConfig,
	normalizeFocusStats,
} = require("./config/focus-prefs.cjs");

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
// Keyed by display id, since the notch can be shown on multiple screens at once.
let notchWindows = new Map();
let tray = null;
let isQuitting = false;
let db = null;
let tracker = null;

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
const GITHUB_OWNER = "ntnthefirst";
const GITHUB_REPO = "Atlas";
let updatePreferences = { ...defaultUpdatePreferences };

// ---------------------------------------------------------------------------
// Focus mode (Pomodoro) + wellbeing nudges engine.
//
// This is the single source of truth shared by every window. Config + daily
// stats are persisted; the live `runtime` is intentionally not (a focus cycle
// doesn't survive an app restart). A 1s interval advances phases and fires the
// recurring nudges as native notifications, broadcasting state to all windows
// only when something actually changes (renderers tick their own countdowns).
// Mirrors src/types.ts FocusState.
// ---------------------------------------------------------------------------
let focusState = {
	config: { ...defaultFocusConfig, nudges: defaultFocusConfig.nudges.map((nudge) => ({ ...nudge })) },
	runtime: null,
	stats: { day: todayKey(), focusRoundsCompleted: 0, focusMsCompleted: 0 },
};
// Per-nudge timestamp (epoch ms) of the last time it fired, kept in memory so
// nudges pace from when they were enabled / the engine started, never persisted.
let nudgeLastFired = {};
let focusTimer = null;

// Reset the daily counters in place if the calendar day has rolled over.
function rollFocusStatsIfNeeded() {
	const today = todayKey();
	if (focusState.stats.day !== today) {
		focusState.stats = { day: today, focusRoundsCompleted: 0, focusMsCompleted: 0 };
	}
}

function loadFocusPreferences() {
	try {
		const raw = fs.readFileSync(path.join(app.getPath("userData"), FOCUS_PREFS_FILE), "utf8");
		const parsed = JSON.parse(raw);
		focusState = {
			config: normalizeFocusConfig(parsed.config),
			runtime: null,
			stats: normalizeFocusStats(parsed.stats),
		};
	} catch {
		focusState = {
			config: normalizeFocusConfig(null),
			runtime: null,
			stats: normalizeFocusStats(null),
		};
	}
	rollFocusStatsIfNeeded();
	return focusState;
}

function persistFocusPreferences() {
	try {
		fs.writeFileSync(
			path.join(app.getPath("userData"), FOCUS_PREFS_FILE),
			JSON.stringify({ config: focusState.config, stats: focusState.stats }, null, 2),
			"utf8",
		);
	} catch {
		// Non-blocking: focus still works from in-memory state this session.
	}
}

function broadcastFocusState() {
	for (const browserWindow of BrowserWindow.getAllWindows()) {
		if (!browserWindow.isDestroyed()) {
			browserWindow.webContents.send("focus:state-changed", focusState);
		}
	}
}

function phaseDurationMs(phase) {
	const config = focusState.config;
	if (phase === "shortBreak") return config.shortBreakMinutes * 60000;
	if (phase === "longBreak") return config.longBreakMinutes * 60000;
	return config.focusMinutes * 60000;
}

function notify(title, body) {
	try {
		if (Notification.isSupported()) {
			new Notification({ title, body, silent: false }).show();
		}
	} catch {
		// Notifications are best-effort; never let one crash the engine.
	}
}

// Build a runtime for a phase, honoring whether it should auto-start or wait
// paused for a manual start.
function makePhaseRuntime(phase, roundIndex, goal, startedAt, autoStart) {
	const duration = phaseDurationMs(phase);
	const now = Date.now();
	return {
		phase,
		roundIndex,
		phaseDurationMs: duration,
		phaseEndsAt: now + duration,
		isPaused: !autoStart,
		remainingMs: duration,
		goal: goal || "",
		startedAt: startedAt || now,
	};
}

// Advance to the next phase when the current one elapses (or is skipped).
function advanceFocusPhase(skipped) {
	const runtime = focusState.runtime;
	if (!runtime) return;
	const config = focusState.config;
	const goal = runtime.goal;
	const startedAt = runtime.startedAt;

	if (runtime.phase === "focus") {
		// Credit the completed focus round (a skip still ended the work block).
		rollFocusStatsIfNeeded();
		focusState.stats.focusRoundsCompleted += 1;
		focusState.stats.focusMsCompleted += runtime.phaseDurationMs;
		const completedRounds = runtime.roundIndex + 1;
		const longBreakDue = completedRounds % config.roundsBeforeLongBreak === 0;
		const nextPhase = longBreakDue ? "longBreak" : "shortBreak";
		focusState.runtime = makePhaseRuntime(nextPhase, runtime.roundIndex, goal, startedAt, config.autoStartBreaks);
		if (!skipped) {
			notify(
				longBreakDue ? "Long break time" : "Break time",
				`Focus round done. ${longBreakDue ? config.longBreakMinutes : config.shortBreakMinutes} min break.`,
			);
		}
	} else {
		// A break finished → next focus round. After a long break the cycle resets.
		const wasLong = runtime.phase === "longBreak";
		const nextRoundIndex = wasLong ? 0 : runtime.roundIndex + 1;
		focusState.runtime = makePhaseRuntime("focus", nextRoundIndex, goal, startedAt, config.autoStartFocus);
		if (!skipped) {
			notify("Back to focus", goal ? `Next up: ${goal}` : "Break over — back to it.");
		}
	}
	persistFocusPreferences();
	broadcastFocusState();
}

function maybeFireNudges(now) {
	const config = focusState.config;
	const runtime = focusState.runtime;
	const active = config.nudgesOnlyDuringFocus
		? Boolean(runtime && runtime.phase === "focus" && !runtime.isPaused)
		: true;
	if (!active) return;
	for (const nudge of config.nudges) {
		if (!nudge.enabled) continue;
		const last = nudgeLastFired[nudge.kind] || 0;
		if (now - last >= nudge.everyMinutes * 60000) {
			nudgeLastFired[nudge.kind] = now;
			const copy = NUDGE_COPY[nudge.kind];
			if (copy) notify(copy.title, copy.body);
		}
	}
}

// Single 1s heartbeat: advances an elapsed phase and paces the nudges. Kept
// running for the app's lifetime — cheap, and nudges fire without a focus cycle.
function startFocusEngine() {
	if (focusTimer) return;
	// Pace nudges from "now" so enabling one never fires it instantly.
	const now = Date.now();
	for (const kind of FOCUS_NUDGE_KINDS) nudgeLastFired[kind] = now;
	focusTimer = setInterval(() => {
		const tickNow = Date.now();
		const runtime = focusState.runtime;
		if (runtime && !runtime.isPaused && tickNow >= runtime.phaseEndsAt) {
			advanceFocusPhase(false);
		}
		maybeFireNudges(tickNow);
	}, 1000);
	if (typeof focusTimer.unref === "function") focusTimer.unref();
}

function startFocus(goal) {
	rollFocusStatsIfNeeded();
	if (focusState.runtime) {
		// Already mid-cycle: just (re)start the clock and clear any pause.
		const runtime = focusState.runtime;
		runtime.isPaused = false;
		runtime.phaseEndsAt = Date.now() + runtime.remainingMs;
		if (typeof goal === "string") runtime.goal = goal;
	} else {
		focusState.runtime = makePhaseRuntime("focus", 0, typeof goal === "string" ? goal : "", Date.now(), true);
	}
	broadcastFocusState();
	return focusState;
}

function pauseFocus() {
	const runtime = focusState.runtime;
	if (runtime && !runtime.isPaused) {
		runtime.remainingMs = Math.max(0, runtime.phaseEndsAt - Date.now());
		runtime.isPaused = true;
		broadcastFocusState();
	}
	return focusState;
}

function resumeFocus() {
	const runtime = focusState.runtime;
	if (runtime && runtime.isPaused) {
		runtime.isPaused = false;
		runtime.phaseEndsAt = Date.now() + runtime.remainingMs;
		broadcastFocusState();
	}
	return focusState;
}

function stopFocus() {
	focusState.runtime = null;
	broadcastFocusState();
	return focusState;
}

function setFocusGoal(goal) {
	if (focusState.runtime) {
		focusState.runtime.goal = typeof goal === "string" ? goal : "";
		broadcastFocusState();
	}
	return focusState;
}

function updateFocusConfig(patch) {
	focusState.config = normalizeFocusConfig({ ...focusState.config, ...(patch || {}) });
	persistFocusPreferences();
	broadcastFocusState();
	return focusState;
}

let notchPreferences = { ...defaultNotchPreferences };
let dashboardPreferences = { ...defaultDashboardPreferences };

if (isDev) {
	// Keep development state fully isolated from the installed production app.
	const devUserDataPath = path.join(app.getPath("appData"), "Atlas-Dev");
	app.setPath("userData", devUserDataPath);
}

function getUpdatePrefsPath() {
	return path.join(app.getPath("userData"), UPDATE_PREFS_FILE);
}

function loadUpdatePreferences() {
	try {
		const rawContent = fs.readFileSync(getUpdatePrefsPath(), "utf8");
		const parsed = JSON.parse(rawContent);
		updatePreferences = normalizeUpdatePreferences(parsed);
	} catch {
		updatePreferences = { ...defaultUpdatePreferences };
	}

	return updatePreferences;
}

function saveUpdatePreferences(nextValue) {
	updatePreferences = normalizeUpdatePreferences(nextValue);

	try {
		fs.writeFileSync(getUpdatePrefsPath(), JSON.stringify(updatePreferences, null, 2), "utf8");
	} catch {
		// Non-blocking: update checks should still work with in-memory preferences.
	}

	return updatePreferences;
}

async function fetchReleases(includePrerelease) {
	const releaseList = await fetchJson(
		`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`,
	);
	return normalizeReleaseList(releaseList, includePrerelease);
}

async function checkLatestGitHubVersion(includePrerelease) {
	const localVersion = app.getVersion();

	try {
		const releases = await fetchReleases(includePrerelease);
		const latestRelease = releases[0];
		if (!latestRelease) {
			return;
		}

		if (compareVersionStrings(latestRelease.version, localVersion) > 0) {
			console.log(`[Atlas] New version available: ${latestRelease.tag} (local: v${localVersion}).`);
		}
	} catch {
		console.log("[Atlas] Version check skipped (offline or GitHub unavailable). Continuing startup.");
	}
}

async function performInAppUpdate(includePrerelease) {
	if (!app.isPackaged) {
		return {
			started: false,
			error: "In-app install is only available in packaged builds.",
		};
	}

	try {
		autoUpdater.allowPrerelease = includePrerelease;
		autoUpdater.allowDowngrade = includePrerelease;
		autoUpdater.autoDownload = true;

		const result = await autoUpdater.checkForUpdates();
		if (!result?.downloadPromise) {
			return {
				started: false,
				error: "No update download started.",
			};
		}

		await result.downloadPromise;
		setImmediate(() => {
			autoUpdater.quitAndInstall(false, true);
		});

		return { started: true };
	} catch (error) {
		return {
			started: false,
			error: error instanceof Error ? error.message : "Unknown update error",
		};
	}
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

function createSettingsWindow(parentWindow = null) {
	if (settingsWindow && !settingsWindow.isDestroyed()) {
		settingsWindow.show();
		settingsWindow.focus();
		return settingsWindow;
	}

	settingsWindow = new BrowserWindow({
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
		icon: isDev
			? path.join(__dirname, "..", "src", "assets", "logosmall.png")
			: path.join(__dirname, "..", "dist", "assets", "logosmall.png"),
		frame: isMac,
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		titleBarOverlay: getTitleBarOverlay(),
		parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
		modal: Boolean(parentWindow && !parentWindow.isDestroyed()),
		resizable: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		settingsWindow.loadURL("http://localhost:5173?mode=settings");
	} else {
		settingsWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
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
		settingsWindow = null;
	});

	return settingsWindow;
}

// A standalone window for editing the notch's action-button tabs/grids —
// the same editor embedded in Settings, but reachable directly from a button
// on the notch itself without going through the full Settings window.
function createActionEditorWindow(parentWindow = null) {
	if (actionEditorWindow && !actionEditorWindow.isDestroyed()) {
		actionEditorWindow.show();
		actionEditorWindow.focus();
		return actionEditorWindow;
	}

	actionEditorWindow = new BrowserWindow({
		width: 900,
		height: 720,
		minWidth: 640,
		minHeight: 480,
		autoHideMenuBar: true,
		show: false,
		center: true,
		backgroundColor: "#070707",
		icon: isDev
			? path.join(__dirname, "..", "src", "assets", "logosmall.png")
			: path.join(__dirname, "..", "dist", "assets", "logosmall.png"),
		frame: isMac,
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		titleBarOverlay: getTitleBarOverlay(),
		parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		actionEditorWindow.loadURL("http://localhost:5173?mode=actions");
	} else {
		actionEditorWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
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
		actionEditorWindow = null;
	});

	return actionEditorWindow;
}

// A tiny always-on-top popup the notch opens when you tap a "capture" widget
// (add a task / note). Keeping input in its own focused window beats cramming
// a field into the notch itself, and it can be positioned wherever.
function createNotchInputWindow(payload) {
	pendingNotchInputPayload = payload;

	if (notchInputWindow && !notchInputWindow.isDestroyed()) {
		notchInputWindow.webContents.send("notchInput:payload", payload);
		notchInputWindow.show();
		notchInputWindow.focus();
		return notchInputWindow;
	}

	notchInputWindow = new BrowserWindow({
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
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	notchInputWindow.setAlwaysOnTop(true, "screen-saver");

	if (isDev) {
		notchInputWindow.loadURL("http://localhost:5173?mode=notch-input");
	} else {
		notchInputWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
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
		if (notchInputWindow && !notchInputWindow.isDestroyed()) {
			notchInputWindow.close();
		}
	});

	notchInputWindow.on("closed", () => {
		notchInputWindow = null;
		pendingNotchInputPayload = null;
	});

	return notchInputWindow;
}

function hasAnyMaps() {
	return Boolean(db && db.listMaps().length > 0);
}

function openPrimaryWindowByMapState() {
	if (hasAnyMaps()) {
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

function getTrayIcon() {
	const svgPath = isDev
		? path.join(__dirname, "..", "public", "favicon.svg")
		: path.join(__dirname, "..", "dist", "favicon.svg");
	const icon = nativeImage.createFromPath(svgPath);
	if (!icon.isEmpty()) {
		return icon.resize({ width: 16, height: 16 });
	}
	return nativeImage.createFromDataURL(
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z6xQAAAAASUVORK5CYII=",
	);
}

function showMainWindow() {
	if (!hasAnyMaps()) {
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

function loadNotchPreferences() {
	try {
		const raw = fs.readFileSync(path.join(app.getPath("userData"), NOTCH_PREFS_FILE), "utf8");
		notchPreferences = normalizeNotchPreferences(JSON.parse(raw));
	} catch {
		notchPreferences = { ...defaultNotchPreferences };
	}
	return notchPreferences;
}

function saveNotchPreferences(value) {
	notchPreferences = normalizeNotchPreferences(value);
	try {
		fs.writeFileSync(
			path.join(app.getPath("userData"), NOTCH_PREFS_FILE),
			JSON.stringify(notchPreferences, null, 2),
			"utf8",
		);
	} catch {
		// Non-blocking: notch still works with in-memory preferences.
	}
	return notchPreferences;
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

// Resolves which displays should currently show a notch. Falls back to the
// primary display whenever the saved selection is empty or none of the saved
// ids are connected, so there's always at least one.
function getTargetDisplays() {
	const displays = screen.getAllDisplays();
	const primary = screen.getPrimaryDisplay();
	return selectTargetDisplays(displays, primary, notchPreferences.displayIds);
}

function positionNotchWindow(notchWindow, display, width, height) {
	if (!notchWindow || notchWindow.isDestroyed()) {
		return;
	}
	const isPrimary = display.id === screen.getPrimaryDisplay().id;
	const bounds = computeNotchBounds({
		workArea: display.workArea,
		width,
		height,
		position: notchPreferences.position,
		isPrimary,
		freeX: notchPreferences.x,
		freeY: notchPreferences.y,
	});

	notchWindow.setBounds(bounds);
}

function createNotchWindowForDisplay(display) {
	const existing = notchWindows.get(display.id);
	if (existing && !existing.isDestroyed()) {
		existing.show();
		return existing;
	}

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
		movable: notchPreferences.position === "free" && !notchPreferences.locked,
		focusable: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	notchWindow.notchDisplayId = display.id;
	notchWindow.setAlwaysOnTop(true, "screen-saver");

	if (isDev) {
		notchWindow.loadURL("http://localhost:5173?mode=notch");
	} else {
		notchWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
			query: { mode: "notch" },
		});
	}

	notchWindow.on("moved", () => {
		if (notchWindow.isDestroyed()) {
			return;
		}
		// Only the primary display's free position is persisted; other displays
		// keep their own default placement.
		if (notchPreferences.position === "free" && display.id === screen.getPrimaryDisplay().id) {
			const [x, y] = notchWindow.getPosition();
			notchPreferences.x = x;
			notchPreferences.y = y;
			saveNotchPreferences(notchPreferences);
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
	if (!notchPreferences.enabled) {
		return false;
	}
	if (notchPreferences.activation === "withMain") {
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

function applyNotchPreferences(next) {
	notchPreferences = saveNotchPreferences(next);

	syncNotchWindows();
	for (const [displayId, notchWindow] of notchWindows) {
		if (notchWindow.isDestroyed()) {
			continue;
		}
		notchWindow.setMovable(notchPreferences.position === "free" && !notchPreferences.locked);
		const display =
			screen.getAllDisplays().find((item) => item.id === displayId) ?? screen.getPrimaryDisplay();
		const [width, height] = notchWindow.getContentSize();
		positionNotchWindow(notchWindow, display, width, height);
	}

	for (const browserWindow of BrowserWindow.getAllWindows()) {
		if (!browserWindow.isDestroyed()) {
			browserWindow.webContents.send("notch:preferences-changed", notchPreferences);
		}
	}
	return notchPreferences;
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
			click: () => applyNotchPreferences({ ...notchPreferences, enabled: !notchPreferences.enabled }),
		},
		{ type: "separator" },
		{
			label: "Quit",
			click: () => {
				isQuitting = true;
				app.quit();
			},
		},
	]);
	tray.setContextMenu(contextMenu);
	return tray;
}

function wireIpc() {
	ipcMain.handle("map:list", () => db.listMaps());

	ipcMain.handle("map:create", (_event, name, options = {}) => {
		if (!name || !name.trim()) {
			throw new Error("Environment name is required.");
		}
		const createdMap = db.createMap(name.trim(), {
			icon: options?.icon ?? null,
			accent: options?.accent ?? null,
			preset: options?.preset ?? null,
		});
		openPrimaryWindowByMapState();
		return createdMap;
	});

	ipcMain.handle("map:rename", (_event, mapId, name) => {
		if (!mapId) {
			throw new Error("Environment id missing.");
		}
		if (!name || !name.trim()) {
			throw new Error("Environment name is required.");
		}
		return db.renameMap(mapId, name.trim());
	});

	ipcMain.handle("map:update", (_event, mapId, fields = {}) => {
		if (!mapId) {
			throw new Error("Environment id missing.");
		}
		const sanitized = {};
		if (typeof fields?.name === "string" && fields.name.trim()) sanitized.name = fields.name.trim();
		if (typeof fields?.icon === "string" || fields?.icon === null) sanitized.icon = fields.icon;
		if (typeof fields?.accent === "string" || fields?.accent === null) sanitized.accent = fields.accent;
		if (typeof fields?.preset === "string" || fields?.preset === null) sanitized.preset = fields.preset;
		return db.updateMap(mapId, sanitized);
	});

	ipcMain.handle("map:delete", (_event, mapId) => {
		if (!mapId) {
			throw new Error("Map id missing.");
		}
		const deleted = db.deleteMap(mapId);
		openPrimaryWindowByMapState();
		return deleted;
	});

	ipcMain.handle("session:active", () => db.getActiveSession());

	ipcMain.handle("session:start", (_event, mapId) => {
		if (!mapId) {
			throw new Error("Map id missing.");
		}

		const session = db.startSession(mapId);
		tracker.setCurrentSession(session.id);
		return session;
	});

	ipcMain.handle("session:pause", (_event, sessionId) => {
		const session = db.pauseSession(sessionId);
		tracker.closeOpenBlockNow(sessionId);
		return session;
	});

	ipcMain.handle("session:resume", (_event, sessionId) => db.resumeSession(sessionId));

	ipcMain.handle("session:stop", (_event, sessionId) => {
		// Finalize the last activity block
		tracker.closeOpenBlockNow(sessionId);

		// Immediately mark session as inactive in tracker to stop accepting new data
		// This must happen BEFORE db.stopSession to prevent race conditions
		if (tracker.currentSessionId === sessionId) {
			tracker.clearCurrentSession();
		}

		// Mark session as ended in database
		const session = db.stopSession(sessionId);

		// Close mini window if open
		if (miniWindow && !miniWindow.isDestroyed()) {
			miniWindow.close();
		}

		return session;
	});

	ipcMain.handle("session:listByMap", (_event, mapId) => {
		if (!mapId) {
			return [];
		}
		return db.listSessionsByMap(mapId);
	});

	ipcMain.handle("session:delete", (_event, sessionId) => {
		if (!sessionId) {
			throw new Error("Session id missing.");
		}
		return db.deleteSession(sessionId);
	});

	ipcMain.handle("activity:listBySession", (_event, sessionId) => {
		if (!sessionId) {
			return [];
		}
		return db.listActivityBlocksBySession(sessionId);
	});

	ipcMain.handle("activity:current-app", () => tracker.getCurrentAppName());

	ipcMain.handle("task:listByMap", (_event, mapId) => {
		if (!mapId) {
			return [];
		}
		return db.listTasksByMap(mapId);
	});

	ipcMain.handle("task:create", (_event, mapId, title, description, fields) => {
		if (!mapId || !title || !title.trim()) {
			throw new Error("Task map and title are required.");
		}
		return db.createTask(mapId, title.trim(), (description || "").trim(), fields || {});
	});

	ipcMain.handle("task:updateStatus", (_event, taskId, status) => {
		if (!taskId || !status) {
			throw new Error("Task id and status are required.");
		}
		return db.updateTaskStatus(taskId, status);
	});

	ipcMain.handle("task:update", (_event, taskId, fields) => {
		if (!taskId || !fields || typeof fields !== "object") {
			throw new Error("Task id and fields are required.");
		}
		return db.updateTask(taskId, fields);
	});

	ipcMain.handle("task:delete", (_event, taskId) => {
		if (!taskId) {
			throw new Error("Task id is required.");
		}
		return db.deleteTask(taskId);
	});

	ipcMain.handle("note:listByMap", (_event, mapId) => {
		if (!mapId) {
			return [];
		}
		return db.listNotesByMap(mapId);
	});

	ipcMain.handle("note:create", (_event, mapId, content) => {
		if (!mapId) {
			throw new Error("Map id is required.");
		}
		return db.createNote(mapId, (content || "").trim());
	});

	ipcMain.handle("note:update", (_event, noteId, content) => {
		if (!noteId) {
			throw new Error("Note id is required.");
		}
		return db.updateNote(noteId, content || "");
	});

	ipcMain.handle("note:delete", (_event, noteId) => {
		if (!noteId) {
			throw new Error("Note id is required.");
		}
		db.deleteNote(noteId);
		return true;
	});

	ipcMain.handle("notebook:getByMap", (_event, mapId) => {
		if (!mapId) {
			throw new Error("Map id is required.");
		}
		return db.getNotebookByMap(mapId);
	});

	ipcMain.handle("notebook:updateByMap", (_event, mapId, content) => {
		if (!mapId) {
			throw new Error("Map id is required.");
		}
		if (typeof content !== "string") {
			throw new Error("Notebook content must be a string.");
		}
		return db.updateNotebookByMap(mapId, content);
	});

	ipcMain.handle("dashboard:overview", (_event, mapId) => {
		if (!mapId) {
			return {
				totalTodayMs: 0,
				timePerApp: [],
				timePerMap: [],
				quickStats: { sessionsToday: 0, openTasks: 0 },
			};
		}
		return db.getDashboardOverview(mapId);
	});

	ipcMain.handle("data:repairCorruptedSessions", () => {
		console.log("[Atlas] Starting repair of corrupted session data...");
		const results = db.repairCorruptedSessions();
		console.log(
			`[Atlas] Repair complete: ${results.sessionsRepaired} sessions checked, ${results.blocksNormalized} blocks normalized.`,
		);
		return results;
	});

	ipcMain.handle("app:launch", (_event, command) => {
		if (!command || !command.trim()) {
			throw new Error("Command is required.");
		}
		spawn(command, {
			shell: true,
			detached: true,
			stdio: "ignore",
		});
		return true;
	});

	ipcMain.handle("window:minimize", (event) => {
		const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? welcomeWindow;
		if (targetWindow && !targetWindow.isDestroyed()) {
			targetWindow.minimize();
		}
		return true;
	});

	ipcMain.handle("app:platform", () => process.platform);

	ipcMain.handle("window:setTheme", (_event, theme) => {
		applyNativeTheme(theme);
		return true;
	});

	ipcMain.handle("app:setAccent", (_event, value) => {
		// Relay the accent change to every window so the whole app updates live.
		for (const browserWindow of BrowserWindow.getAllWindows()) {
			if (!browserWindow.isDestroyed()) {
				browserWindow.webContents.send("accent:changed", value);
			}
		}
		return true;
	});

	ipcMain.handle("notch:getPreferences", () => notchPreferences);

	ipcMain.handle("notch:setPreferences", (_event, prefs) =>
		applyNotchPreferences({ ...notchPreferences, ...(prefs || {}) }),
	);

	ipcMain.handle("dashboard:getLayout", () => dashboardPreferences);

	ipcMain.handle("dashboard:setLayout", (_event, prefs) =>
		saveDashboardPreferences({ ...dashboardPreferences, ...(prefs || {}) }),
	);

	ipcMain.handle("focus:getState", () => {
		rollFocusStatsIfNeeded();
		return focusState;
	});
	ipcMain.handle("focus:start", (_event, goal) => startFocus(goal));
	ipcMain.handle("focus:pause", () => pauseFocus());
	ipcMain.handle("focus:resume", () => resumeFocus());
	ipcMain.handle("focus:skip", () => {
		if (focusState.runtime) advanceFocusPhase(true);
		return focusState;
	});
	ipcMain.handle("focus:stop", () => stopFocus());
	ipcMain.handle("focus:setGoal", (_event, goal) => setFocusGoal(goal));
	ipcMain.handle("focus:setConfig", (_event, patch) => updateFocusConfig(patch));

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

	ipcMain.handle("window:openMini", () => {
		createMiniWindow();
		return true;
	});

	ipcMain.handle("window:openSettings", (event) => {
		const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? welcomeWindow;
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

	ipcMain.handle("notchInput:getPayload", () => pendingNotchInputPayload ?? {});

	ipcMain.handle("app:pickFile", async (event) => {
		const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
		const result = await dialog.showOpenDialog(ownerWindow, {
			properties: ["openFile"],
			filters: isWindows
				? [
						{ name: "Programs", extensions: ["exe", "bat", "cmd"] },
						{ name: "All files", extensions: ["*"] },
					]
				: [{ name: "All files", extensions: ["*"] }],
		});
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		return result.filePaths[0];
	});

	ipcMain.handle("app:getFileIcon", async (_event, filePath) => {
		if (!filePath) return null;
		// A quoted path (the common case — paths with spaces, e.g. under
		// "Program Files", get auto-quoted when picked) keeps everything
		// between the quotes intact. An unquoted command may have trailing
		// arguments after the first space, which get dropped.
		const trimmed = filePath.trim();
		const quotedMatch = trimmed.match(/^"([^"]+)"/);
		const target = quotedMatch ? quotedMatch[1] : trimmed.split(" ")[0];
		try {
			const icon = await app.getFileIcon(target, { size: "normal" });
			return icon.isEmpty() ? null : icon.toDataURL();
		} catch {
			return null;
		}
	});

	ipcMain.handle("system:listOpenApps", () => listOpenApps());

	ipcMain.handle("system:getStats", () => getSystemStats());

	ipcMain.handle("window:resizeMini", (_event, width, height) => {
		if (!miniWindow || miniWindow.isDestroyed()) {
			return false;
		}

		const safeWidth = Math.max(220, Math.min(900, Math.ceil(Number(width) || 0)));
		const safeHeight = Math.max(40, Math.min(260, Math.ceil(Number(height) || 0)));
		miniWindow.setContentSize(safeWidth, safeHeight);
		return true;
	});

	ipcMain.handle("window:showMain", () => {
		showMainWindow();
		return true;
	});

	// Brings the main window forward only if it already exists, without launching
	// it — the notch can run fully standalone, so this never force-opens the app.
	ipcMain.handle("window:focusMainIfOpen", () => {
		if (!mainWindow || mainWindow.isDestroyed()) {
			return false;
		}
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.focus();
		return true;
	});

	ipcMain.handle("window:navigate", (_event, view) => {
		showMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("window:navigate-changed", view);
		}
		return true;
	});

	ipcMain.handle("window:closeMini", () => {
		if (!miniWindow || miniWindow.isDestroyed()) {
			return false;
		}

		const hasActiveSession = Boolean(db && db.getActiveSession());
		const canRevealMain = Boolean(mainWindow && !mainWindow.isDestroyed());
		if (hasActiveSession && canRevealMain && mainWindow.isVisible() === false) {
			showMainWindow();
		}

		miniWindow.close();
		return true;
	});

	ipcMain.handle("window:toggleMaximize", () => {
		if (!mainWindow) {
			return false;
		}
		if (mainWindow.isMaximized()) {
			mainWindow.unmaximize();
			return false;
		}
		mainWindow.maximize();
		return true;
	});

	ipcMain.handle("window:close", (event) => {
		const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? welcomeWindow;
		if (targetWindow && !targetWindow.isDestroyed()) {
			targetWindow.close();
		}
		return true;
	});

	ipcMain.handle("app:version", () => {
		return app.getVersion();
	});

	ipcMain.handle("app:getUpdatePreferences", () => {
		return updatePreferences;
	});

	ipcMain.handle("app:setUpdatePreferences", (_event, nextPreferences) => {
		return saveUpdatePreferences(nextPreferences);
	});

	ipcMain.handle("app:checkUpdates", async (_event, options = {}) => {
		const includePrerelease =
			typeof options?.includePrerelease === "boolean"
				? options.includePrerelease
				: updatePreferences.includeBeta;
		const localVersion = app.getVersion();

		try {
			const releases = await fetchReleases(includePrerelease);
			const latestRelease = releases[0] ?? null;
			if (!latestRelease) {
				return {
					hasUpdate: false,
					local: localVersion,
					latest: null,
					error: "No published releases available",
				};
			}

			const isOutdated = compareVersionStrings(latestRelease.version, localVersion) > 0;

			return {
				hasUpdate: isOutdated,
				local: localVersion,
				latest: latestRelease.version,
				releaseUrl: latestRelease.url,
				publishedAt: latestRelease.publishedAt,
				downloadUrl: isOutdated ? (latestRelease.installerUrl ?? undefined) : undefined,
			};
		} catch (error) {
			return {
				hasUpdate: false,
				local: localVersion,
				latest: null,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	ipcMain.handle("app:releaseHistory", async (_event, options = {}) => {
		const includePrerelease =
			typeof options?.includePrerelease === "boolean"
				? options.includePrerelease
				: updatePreferences.includeBeta;

		try {
			const releases = await fetchReleases(includePrerelease);

			return { releases };
		} catch (error) {
			return {
				releases: [],
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	ipcMain.handle("app:downloadAndInstallUpdate", async (_event, options = {}) => {
		const includePrerelease =
			typeof options?.includePrerelease === "boolean"
				? options.includePrerelease
				: updatePreferences.includeBeta;
		return performInAppUpdate(includePrerelease);
	});

	// AI provider integrations. Keys stay in the main process (see ai.cjs); the
	// renderer only ever gets masked config back and sends prompts to run.
	ipcMain.handle("ai:getConfig", () => getPublicAiConfig());
	ipcMain.handle("ai:setConfig", (_event, patch) => setAiConfig(patch));
	ipcMain.handle("ai:complete", async (_event, args) => {
		try {
			const result = await aiComplete(args);
			return { ok: true, ...result };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : "AI request failed." };
		}
	});
}

app.whenReady().then(async () => {
	loadUpdatePreferences();
	loadNotchPreferences();
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
	db = await AtlasDatabase.create(dbPath);

	// CRITICAL: Finalize any stranded sessions from crashes or ungraceful shutdowns
	// This prevents old sessions from being resumed and continuing to accumulate time
	const repairResults = db.finalizeStrandedSessions();
	if (repairResults.finalized > 0) {
		console.log(`[Atlas] Finalized ${repairResults.finalized} stranded session(s) from previous crash.`);
	}

	tracker = new ActivityTracker(db);
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
	openPrimaryWindowByMapState();
	if (updatePreferences.autoCheck) {
		void checkLatestGitHubVersion(updatePreferences.includeBeta);
	}

	// Re-sync notch windows whenever a monitor is connected/disconnected so the
	// selection (and the "always at least one" fallback) stays accurate.
	screen.on("display-added", () => syncNotchWindows());
	screen.on("display-removed", () => syncNotchWindows());

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			openPrimaryWindowByMapState();
		} else {
			openPrimaryWindowByMapState();
		}
	});
});

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
});
