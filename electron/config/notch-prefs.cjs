// ---------------------------------------------------------------------------
// Notch preference schema, defaults and normalization.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. Everything here is
// pure — no window, app or filesystem access — so the defensive parsing that
// keeps a hand-edited or outdated notch-preferences.json from crashing the app
// can be tested directly. Loading and saving the file stays in main.cjs.
// ---------------------------------------------------------------------------

const { clampNumber } = require("./prefs-utils.cjs");

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
	"activityTimeline",
	"topApp",
	"topAppCompact",
	"sessionsTodayCount",
	"openTasksCount",
	"untrackedToday",
	// Tasks
	"firstTodoList",
	"taskCount",
	"quickAddTask",
	"quickAddNote",
	"nextTaskOnly",
	"taskColumnsOverview",
	"taskProgressBar",
	"dueTasksCount",
	// Notes
	"notesCount",
	"lastNoteSnippet",
	// Environment
	"environmentName",
	"environmentAccentDot",
	"environmentSwitcher",
	"environmentList",
	// Focus
	"focusToggle",
	"focusStatus",
	// App launcher / navigation
	"scene",
	"launchAppButton",
	"openUrlButton",
	"openDashboardButton",
	"openActivityButton",
	"openTasksButton",
	"openNotesButton",
	"openFocusButton",
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
		// Widgets that use it (launchAppButton, openUrlButton, label, task-column
		// widgets) carry a config string; the "scene" widget stores a JSON blob
		// here, so the cap is generous enough to hold a handful of apps/urls/tasks
		// while still bounding a corrupted file defensively.
		if (typeof entry.config === "string" && entry.config.trim()) {
			placement.config = entry.config.trim().slice(0, 4000);
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

module.exports = {
	NOTCH_PREFS_FILE,
	NOTCH_POSITIONS,
	NOTCH_IDLE_OPACITIES,
	NOTCH_ACTIVATIONS,
	NOTCH_INFO_ITEM_IDS,
	NOTCH_WIDGET_IDS,
	NOTCH_TAB_ICONS,
	NOTCH_GRID_MIN_COLS,
	NOTCH_GRID_MAX_COLS,
	NOTCH_GRID_MIN_ROWS,
	NOTCH_GRID_MAX_ROWS,
	defaultNotchInfoItems,
	defaultNotchTabs,
	defaultNotchPreferences,
	normalizeIdEnabledList,
	placementsOverlap,
	normalizeNotchPlacements,
	normalizeNotchTabs,
	normalizeNotchPreferences,
};
