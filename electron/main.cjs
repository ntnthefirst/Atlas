const path = require("node:path");
const https = require("node:https");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	Tray,
	nativeImage,
	nativeTheme,
	screen,
} = require("electron");
const { autoUpdater } = require("electron-updater");

const { AtlasDatabase } = require("./db.cjs");
const { ActivityTracker } = require("./activity-tracker.cjs");
const { getSystemStats, listOpenApps } = require("./system-info.cjs");

let mainWindow = null;
let miniWindow = null;
let welcomeWindow = null;
let settingsWindow = null;
let actionEditorWindow = null;
// Keyed by display id, since the notch can be shown on multiple screens at once.
let notchWindows = new Map();
let tray = null;
let isQuitting = false;
let db = null;
let tracker = null;

const isDev = !app.isPackaged;
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
const APP_USER_MODEL_ID = isDev ? "com.atlas.app.dev" : "com.atlas.app";
const GITHUB_OWNER = "ntnthefirst";
const GITHUB_REPO = "Atlas";
const UPDATE_PREFS_FILE = "update-preferences.json";
const defaultUpdatePreferences = {
	autoCheck: true,
	includeBeta: false,
};

let updatePreferences = { ...defaultUpdatePreferences };

const NOTCH_PREFS_FILE = "notch-preferences.json";
const NOTCH_POSITIONS = ["top", "left", "right", "free"];
const NOTCH_IDLE_OPACITIES = ["subtle", "balanced", "solid"];
const NOTCH_ACTIVATIONS = ["always", "withMain"];
const NOTCH_INFO_ITEM_IDS = ["timer", "todo"];
const defaultNotchInfoItems = NOTCH_INFO_ITEM_IDS.map((id) => ({ id, enabled: true }));

const NOTCH_WIDGET_IDS = [
	// Timer/session
	"timerStartStop",
	"timerPause",
	"timerDisplay",
	"timerStatusDot",
	"sessionStateLabel",
	"lockToggle",
	// Time/stats
	"timeSpentToday",
	"topApp",
	"topAppCompact",
	"sessionsTodayCount",
	"openTasksCount",
	"dashboardSummary",
	"untrackedToday",
	// Tasks
	"firstTodoList",
	"taskCount",
	"quickAddTask",
	"nextTaskOnly",
	"taskColumnsOverview",
	"taskProgressBar",
	// Notes
	"notesCount",
	"lastNoteSnippet",
	// Environment
	"environmentName",
	"environmentAccentDot",
	"environmentSwitcher",
	"environmentList",
	// App launcher / navigation
	"launchAppButton",
	"openUrlButton",
	"openDashboardButton",
	"openActivityButton",
	"openTasksButton",
	"openNotesButton",
	"openSettingsButton",
	"openMiniPlayerButton",
	// Clock/date
	"currentTime",
	"currentDate",
	"dayOfWeek",
	"clockWithSeconds",
	"timeUntilMidnight",
	// System/app
	"currentAppName",
	"platformBadge",
	"appVersionBadge",
	"updateAvailableBadge",
	"minimizeButton",
	"focusMainButton",
	"cpuUsagePercent",
	"cpuUsageGraph",
	"memoryUsagePercent",
	"memoryUsageGraph",
	// Visual/utility
	"divider",
	"label",
	"spacer",
	"accentSwatch",
	"themeToggle",
];
// Mirrors src/types.ts's NOTCH_TAB_ICONS — kept as plain strings here since
// main.cjs only needs to validate them, not render them.
const NOTCH_TAB_ICONS = [
	"AcademicCapIcon",
	"AdjustmentsHorizontalIcon",
	"ArchiveBoxIcon",
	"ArrowPathIcon",
	"BeakerIcon",
	"BellIcon",
	"BoltIcon",
	"BookOpenIcon",
	"BriefcaseIcon",
	"CalendarIcon",
	"CameraIcon",
	"ChartBarIcon",
	"ChatBubbleLeftIcon",
	"CheckCircleIcon",
	"ClipboardIcon",
	"ClockIcon",
	"CloudIcon",
	"CodeBracketIcon",
	"Cog6ToothIcon",
	"CommandLineIcon",
	"CpuChipIcon",
	"CreditCardIcon",
	"CubeIcon",
	"DocumentTextIcon",
	"EnvelopeIcon",
	"FaceSmileIcon",
	"FilmIcon",
	"FireIcon",
	"FlagIcon",
	"FolderIcon",
	"GiftIcon",
	"GlobeAltIcon",
	"HeartIcon",
	"HomeIcon",
	"InboxIcon",
	"KeyIcon",
	"LightBulbIcon",
	"ListBulletIcon",
	"MapIcon",
	"MegaphoneIcon",
	"MoonIcon",
	"MusicalNoteIcon",
	"NewspaperIcon",
	"PaintBrushIcon",
	"PaperAirplaneIcon",
	"PencilIcon",
	"PhotoIcon",
	"PlayIcon",
	"PuzzlePieceIcon",
	"RocketLaunchIcon",
	"ShieldCheckIcon",
	"ShoppingCartIcon",
	"SparklesIcon",
	"Squares2X2Icon",
	"StarIcon",
	"SunIcon",
	"TagIcon",
	"TrashIcon",
	"TrophyIcon",
	"UserIcon",
	"VideoCameraIcon",
	"WifiIcon",
	"WrenchIcon",
];
// The settings grid editor and the notch itself both lay tabs out on a grid
// of fixed-size (tailwind w-10/h-10) cells with a gap-1.5 gutter; 5x1 is both
// the default and the floor for a freshly added tab.
const NOTCH_GRID_MIN_COLS = 5;
const NOTCH_GRID_MAX_COLS = 20;
const NOTCH_GRID_MIN_ROWS = 1;
const NOTCH_GRID_MAX_ROWS = 20;
const defaultNotchTabs = [
	{
		id: "timer",
		label: "Timer",
		icon: "ClockIcon",
		gridCols: 5,
		gridRows: 1,
		placements: [
			{ id: "start-stop", widget: "timerStartStop", x: 0, y: 0, w: 1, h: 1 },
			{ id: "display", widget: "timerDisplay", x: 1, y: 0, w: 2, h: 1 },
		],
	},
	{
		id: "time",
		label: "Time",
		icon: "ChartBarIcon",
		gridCols: 5,
		gridRows: 4,
		placements: [
			{ id: "time-spent", widget: "timeSpentToday", x: 0, y: 0, w: 5, h: 2 },
			{ id: "top-app", widget: "topApp", x: 0, y: 2, w: 3, h: 2 },
		],
	},
	{
		id: "tasks",
		label: "Tasks",
		icon: "ListBulletIcon",
		gridCols: 5,
		gridRows: 3,
		placements: [{ id: "first-todos", widget: "firstTodoList", x: 0, y: 0, w: 3, h: 3 }],
	},
	{
		id: "notes",
		label: "Notes",
		icon: "NewspaperIcon",
		gridCols: 5,
		gridRows: 2,
		placements: [{ id: "notes-count", widget: "notesCount", x: 0, y: 0, w: 3, h: 1 }],
	},
];
const defaultNotchPreferences = {
	enabled: true,
	position: "top",
	x: null,
	y: null,
	idleOpacity: "balanced",
	locked: false,
	activation: "always",
	displayIds: [],
	tabs: defaultNotchTabs,
	infoItems: defaultNotchInfoItems,
};

// Normalizes a reorderable {id, enabled}[] list: drops invalid/duplicate ids,
// keeps the user's order, and appends any missing ids (e.g. a newly added
// feature) at the end so old saved preferences stay forward-compatible.
function normalizeIdEnabledList(value, validIds, defaults) {
	if (!Array.isArray(value)) {
		return defaults.map((entry) => ({ ...entry }));
	}
	const seen = new Set();
	const result = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || !validIds.includes(entry.id) || seen.has(entry.id)) {
			continue;
		}
		seen.add(entry.id);
		result.push({ id: entry.id, enabled: typeof entry.enabled === "boolean" ? entry.enabled : true });
	}
	for (const id of validIds) {
		if (!seen.has(id)) {
			result.push({ id, enabled: true });
		}
	}
	return result;
}

function clampNumber(value, fallback, min, max) {
	const n = Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.min(Math.max(n, min), max);
}

// Normalizes a single tab's placements against its (already-clamped) grid
// size: drops entries with an unknown widget or duplicate id, clamps each
// placement's w/h to fit inside the grid and its x/y to fit alongside that
// size, so a placement can never end up partially or fully off-grid (e.g.
// after the user shrinks the grid from settings).
// Two placements overlap if their cell rectangles intersect.
function placementsOverlap(a, b) {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function normalizeNotchPlacements(value, gridCols, gridRows) {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set();
	const result = [];
	value.forEach((entry, index) => {
		if (!entry || typeof entry !== "object" || !NOTCH_WIDGET_IDS.includes(entry.widget)) {
			return;
		}
		const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `placement-${index}`;
		if (seen.has(id)) {
			return;
		}
		const w = clampNumber(entry.w, 1, 1, gridCols);
		const h = clampNumber(entry.h, 1, 1, gridRows);
		const x = clampNumber(entry.x, 0, 0, gridCols - w);
		const y = clampNumber(entry.y, 0, 0, gridRows - h);
		const placement = { id, widget: entry.widget, x, y, w, h };
		// Never let a hand-edited or corrupted preferences file produce two
		// placements stacked on the same cells — keep whichever came first and
		// drop the rest, same as the settings grid editor does live.
		if (result.some((existing) => placementsOverlap(placement, existing))) {
			return;
		}
		seen.add(id);
		// Only the handful of widgets that use it (launchAppButton, openUrlButton,
		// label) carry a config string; cap its length defensively.
		if (typeof entry.config === "string" && entry.config.trim()) {
			placement.config = entry.config.trim().slice(0, 200);
		}
		result.push(placement);
	});
	return result;
}

// Normalizes a user-editable tab list: each tab needs a unique string id, a
// label, a valid icon, a grid size clamped to the allowed range, and a
// placements[] that fits inside that grid. A tab has no separate enabled
// flag — it either exists (and shows) or is removed. Falls back to the
// defaults wholesale if the saved value is missing/empty/malformed, since a
// half-broken custom list isn't recoverable item-by-item the way the old
// fixed-id lists were.
function normalizeNotchTabs(value, defaults) {
	const fallback = () =>
		defaults.map((tab) => ({ ...tab, placements: tab.placements.map((p) => ({ ...p })) }));
	if (!Array.isArray(value) || value.length === 0) {
		return fallback();
	}
	const seen = new Set();
	const result = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : null;
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : "Tab";
		const icon = NOTCH_TAB_ICONS.includes(entry.icon) ? entry.icon : "Squares2X2Icon";
		const gridCols = clampNumber(
			entry.gridCols,
			NOTCH_GRID_MIN_COLS,
			NOTCH_GRID_MIN_COLS,
			NOTCH_GRID_MAX_COLS,
		);
		const gridRows = clampNumber(
			entry.gridRows,
			NOTCH_GRID_MIN_ROWS,
			NOTCH_GRID_MIN_ROWS,
			NOTCH_GRID_MAX_ROWS,
		);
		const placements = normalizeNotchPlacements(entry.placements, gridCols, gridRows);
		result.push({ id, label, icon, gridCols, gridRows, placements });
	}
	return result.length > 0 ? result : fallback();
}

let notchPreferences = { ...defaultNotchPreferences };

if (isDev) {
	// Keep development state fully isolated from the installed production app.
	const devUserDataPath = path.join(app.getPath("appData"), "Atlas-Dev");
	app.setPath("userData", devUserDataPath);
}

function fetchJson(url) {
	return new Promise((resolve, reject) => {
		const request = https.get(
			url,
			{
				headers: {
					"User-Agent": "Atlas-Version-Check",
					Accept: "application/vnd.github+json",
				},
				timeout: 4000,
			},
			(response) => {
				if (!response || response.statusCode < 200 || response.statusCode >= 300) {
					reject(new Error(`HTTP ${response?.statusCode ?? "unknown"}`));
					return;
				}

				let payload = "";
				response.on("data", (chunk) => {
					payload += chunk;
				});
				response.on("end", () => {
					try {
						resolve(JSON.parse(payload));
					} catch {
						reject(new Error("Invalid JSON response."));
					}
				});
			},
		);

		request.on("timeout", () => {
			request.destroy(new Error("Version check timeout."));
		});
		request.on("error", reject);
	});
}

function getUpdatePrefsPath() {
	return path.join(app.getPath("userData"), UPDATE_PREFS_FILE);
}

function normalizeUpdatePreferences(rawValue) {
	if (!rawValue || typeof rawValue !== "object") {
		return { ...defaultUpdatePreferences };
	}

	return {
		autoCheck:
			typeof rawValue.autoCheck === "boolean" ? rawValue.autoCheck : defaultUpdatePreferences.autoCheck,
		includeBeta:
			typeof rawValue.includeBeta === "boolean" ? rawValue.includeBeta : defaultUpdatePreferences.includeBeta,
	};
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

function parseVersion(rawVersion) {
	if (!rawVersion || typeof rawVersion !== "string") {
		return null;
	}

	const cleaned = rawVersion.trim().replace(/^v/i, "");
	const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
	if (!match) {
		return null;
	}

	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4] || null,
	};
}

function comparePrerelease(left, right) {
	if (!left && !right) {
		return 0;
	}
	if (!left) {
		return 1;
	}
	if (!right) {
		return -1;
	}

	const leftParts = left.split(".");
	const rightParts = right.split(".");
	const limit = Math.max(leftParts.length, rightParts.length);

	for (let index = 0; index < limit; index += 1) {
		const leftPart = leftParts[index];
		const rightPart = rightParts[index];
		if (leftPart === undefined) {
			return -1;
		}
		if (rightPart === undefined) {
			return 1;
		}

		const leftNumber = /^\d+$/.test(leftPart) ? Number.parseInt(leftPart, 10) : null;
		const rightNumber = /^\d+$/.test(rightPart) ? Number.parseInt(rightPart, 10) : null;

		if (leftNumber !== null && rightNumber !== null) {
			if (leftNumber > rightNumber) {
				return 1;
			}
			if (leftNumber < rightNumber) {
				return -1;
			}
			continue;
		}

		if (leftNumber !== null && rightNumber === null) {
			return -1;
		}
		if (leftNumber === null && rightNumber !== null) {
			return 1;
		}

		if (leftPart > rightPart) {
			return 1;
		}
		if (leftPart < rightPart) {
			return -1;
		}
	}

	return 0;
}

function compareVersionStrings(leftVersion, rightVersion) {
	const left = parseVersion(leftVersion);
	const right = parseVersion(rightVersion);
	if (!left || !right) {
		return 0;
	}

	if (left.major !== right.major) {
		return left.major > right.major ? 1 : -1;
	}
	if (left.minor !== right.minor) {
		return left.minor > right.minor ? 1 : -1;
	}
	if (left.patch !== right.patch) {
		return left.patch > right.patch ? 1 : -1;
	}

	return comparePrerelease(left.prerelease, right.prerelease);
}

function normalizeReleaseEntry(entry) {
	const tag = typeof entry?.tag_name === "string" ? entry.tag_name.trim() : "";
	if (!tag) {
		return null;
	}

	return {
		tag,
		version: tag.replace(/^v/i, ""),
		name: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : tag,
		publishedAt: typeof entry?.published_at === "string" ? entry.published_at : null,
		prerelease: Boolean(entry?.prerelease),
		draft: Boolean(entry?.draft),
		url: typeof entry?.html_url === "string" ? entry.html_url : "",
	};
}

function pickInstallerAsset(release) {
	const assets = Array.isArray(release?.assets) ? release.assets : [];
	const names = assets
		.map((asset) => ({
			name: typeof asset?.name === "string" ? asset.name : "",
			url: typeof asset?.browser_download_url === "string" ? asset.browser_download_url : "",
		}))
		.filter((asset) => asset.name && asset.url);

	if (!names.length) {
		return null;
	}

	if (isWindows) {
		return names.find((asset) => /\.exe$/i.test(asset.name))?.url ?? null;
	}
	if (isMac) {
		return (
			names.find((asset) => /\.dmg$/i.test(asset.name))?.url ??
			names.find((asset) => /\.zip$/i.test(asset.name))?.url ??
			null
		);
	}

	return (
		names.find((asset) => /\.AppImage$/i.test(asset.name))?.url ??
		names.find((asset) => /\.deb$/i.test(asset.name))?.url ??
		null
	);
}

function normalizeReleaseList(releaseList, includePrerelease) {
	if (!Array.isArray(releaseList)) {
		return [];
	}

	return releaseList
		.filter((release) => !release?.draft)
		.filter((release) => includePrerelease || !release?.prerelease)
		.map((release) => ({
			...normalizeReleaseEntry(release),
			installerUrl: pickInstallerAsset(release),
		}))
		.filter((release) => Boolean(release?.tag));
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
		minWidth: 1080,
		minHeight: 700,
		backgroundColor: "#070707",
		icon: iconPath,
		frame: isMac,
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		titleBarOverlay: isWindows
			? {
					color: "#2a2a2a",
					symbolColor: "#e2e2e2",
					height: 49,
				}
			: false,
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
		titleBarOverlay: isWindows
			? {
					color: "#2a2a2a",
					symbolColor: "#e2e2e2",
					height: 49,
				}
			: false,
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
		titleBarOverlay: isWindows
			? {
					color: "#2a2a2a",
					symbolColor: "#e2e2e2",
					height: 49,
				}
			: false,
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
		titleBarOverlay: isWindows
			? {
					color: "#2a2a2a",
					symbolColor: "#e2e2e2",
					height: 49,
				}
			: false,
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
	const overlay =
		theme === "light"
			? {
					color: "#f7f7f7",
					symbolColor: "#4a4a4a",
					height: 49,
				}
			: {
					color: "#2a2a2a",
					symbolColor: "#e2e2e2",
					height: 49,
				};

	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.setTitleBarOverlay(overlay);
	}

	if (settingsWindow && !settingsWindow.isDestroyed()) {
		settingsWindow.setTitleBarOverlay(overlay);
	}

	if (welcomeWindow && !welcomeWindow.isDestroyed()) {
		welcomeWindow.setTitleBarOverlay(overlay);
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

function normalizeNotchPreferences(value) {
	if (!value || typeof value !== "object") {
		return { ...defaultNotchPreferences };
	}
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : defaultNotchPreferences.enabled,
		position: NOTCH_POSITIONS.includes(value.position) ? value.position : defaultNotchPreferences.position,
		x: typeof value.x === "number" ? value.x : null,
		y: typeof value.y === "number" ? value.y : null,
		idleOpacity: NOTCH_IDLE_OPACITIES.includes(value.idleOpacity)
			? value.idleOpacity
			: defaultNotchPreferences.idleOpacity,
		locked: typeof value.locked === "boolean" ? value.locked : defaultNotchPreferences.locked,
		activation: NOTCH_ACTIVATIONS.includes(value.activation)
			? value.activation
			: defaultNotchPreferences.activation,
		displayIds: Array.isArray(value.displayIds)
			? [...new Set(value.displayIds.filter((id) => typeof id === "number" && Number.isFinite(id)))]
			: defaultNotchPreferences.displayIds,
		tabs: normalizeNotchTabs(value.tabs, defaultNotchTabs),
		infoItems: normalizeIdEnabledList(value.infoItems, NOTCH_INFO_ITEM_IDS, defaultNotchInfoItems),
	};
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

// Resolves which displays should currently show a notch. Falls back to the
// primary display whenever the saved selection is empty or none of the saved
// ids are connected, so there's always at least one.
function getTargetDisplays() {
	const displays = screen.getAllDisplays();
	const primary = screen.getPrimaryDisplay();
	const selectedIds = notchPreferences.displayIds.length > 0 ? notchPreferences.displayIds : [primary.id];
	const matched = displays.filter((display) => selectedIds.includes(display.id));
	return matched.length > 0 ? matched : [primary];
}

function positionNotchWindow(notchWindow, display, width, height) {
	if (!notchWindow || notchWindow.isDestroyed()) {
		return;
	}
	const area = display.workArea;
	const margin = 10;
	const isPrimary = display.id === screen.getPrimaryDisplay().id;
	let x;
	let y;

	if (
		isPrimary &&
		notchPreferences.position === "free" &&
		typeof notchPreferences.x === "number" &&
		typeof notchPreferences.y === "number"
	) {
		x = notchPreferences.x;
		y = notchPreferences.y;
	} else if (notchPreferences.position === "left") {
		// Docked flush against the left edge, vertically centered.
		x = area.x;
		y = area.y + Math.round((area.height - height) / 2);
	} else if (notchPreferences.position === "right") {
		// Docked flush against the right edge, vertically centered.
		x = area.x + area.width - width;
		y = area.y + Math.round((area.height - height) / 2);
	} else if (notchPreferences.position === "top") {
		// Docked flush against the top edge, horizontally centered.
		x = area.x + Math.round((area.width - width) / 2);
		y = area.y;
	} else {
		// "free" without saved coordinates: centered near the top with a margin.
		x = area.x + Math.round((area.width - width) / 2);
		y = area.y + margin;
	}

	notchWindow.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
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

	ipcMain.handle("task:create", (_event, mapId, title, description) => {
		if (!mapId || !title || !title.trim()) {
			throw new Error("Task map and title are required.");
		}
		return db.createTask(mapId, title.trim(), (description || "").trim());
	});

	ipcMain.handle("task:updateStatus", (_event, taskId, status) => {
		if (!taskId || !status) {
			throw new Error("Task id and status are required.");
		}
		return db.updateTaskStatus(taskId, status);
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
		// Strip surrounding quotes and any trailing arguments a launch command
		// might have (e.g. `"C:\Program Files\App\app.exe" --flag`).
		const target = filePath
			.trim()
			.replace(/^"([^"]+)".*$/, "$1")
			.split(" ")[0];
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
}

app.whenReady().then(async () => {
	loadUpdatePreferences();
	loadNotchPreferences();
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
