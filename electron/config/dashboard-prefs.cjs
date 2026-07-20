// ---------------------------------------------------------------------------
// Dashboard preference schema, defaults and normalization.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. Everything here is
// pure — no window, app or filesystem access — so the defensive parsing that
// keeps a hand-edited or outdated dashboard-preferences.json from crashing the
// app can be tested directly. Loading and saving the file stays in main.cjs.
// ---------------------------------------------------------------------------

const { clampNumber } = require("./prefs-utils.cjs");

const DASHBOARD_PREFS_FILE = "dashboard-preferences.json";
// Mirrors src/components/main-content/dashboard/catalog.ts — kept as plain
// strings here since main.cjs only validates them, not renders them.
const DASHBOARD_WIDGET_IDS = [
	"totalTimeToday",
	"activityTimeline",
	"untrackedToday",
	"avgSessionLength",
	"sessionsToday",
	"quickStats",
	"topApp",
	"timePerApp",
	"timePerEnvironment",
	"currentApp",
	"currentEnvironment",
	"openTasks",
	"dueTasks",
	"taskProgress",
	"taskColumnsOverview",
	"upcomingTasks",
	"notesCount",
	"lastNote",
	"clock",
	"date",
	"greeting",
	"focusToday",
	"launchApp",
	"openUrl",
];
const DASHBOARD_MAX_COLS = 4;
const DASHBOARD_WIDGET_MAX_H = 4;
const defaultDashboardWidgets = [
	{ id: "dash-total", widget: "totalTimeToday", w: 2, h: 1 },
	{ id: "dash-stats", widget: "quickStats", w: 2, h: 2 },
	{ id: "dash-timeline", widget: "activityTimeline", w: 4, h: 1 },
	{ id: "dash-apps", widget: "timePerApp", w: 2, h: 2 },
	{ id: "dash-envs", widget: "timePerEnvironment", w: 2, h: 2 },
];
const defaultDashboardPreferences = { widgets: defaultDashboardWidgets };

// Normalizes the dashboard layout: keeps only known widgets with unique ids,
// clamps each card's span to the grid bounds, and falls back to the default
// layout wholesale when the saved value is missing or empty (a blank
// dashboard isn't recoverable card-by-card).
function normalizeDashboardPreferences(value) {
	const fallback = () => ({ widgets: defaultDashboardWidgets.map((w) => ({ ...w })) });
	if (!value || typeof value !== "object" || !Array.isArray(value.widgets)) {
		return fallback();
	}
	const seen = new Set();
	const widgets = [];
	value.widgets.forEach((entry, index) => {
		if (!entry || typeof entry !== "object" || !DASHBOARD_WIDGET_IDS.includes(entry.widget)) {
			return;
		}
		const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `dash-${index}`;
		if (seen.has(id)) return;
		seen.add(id);
		const placement = {
			id,
			widget: entry.widget,
			w: clampNumber(entry.w, 1, 1, DASHBOARD_MAX_COLS),
			h: clampNumber(entry.h, 1, 1, DASHBOARD_WIDGET_MAX_H),
		};
		if (typeof entry.config === "string" && entry.config.trim()) {
			placement.config = entry.config.trim().slice(0, 500);
		}
		widgets.push(placement);
	});
	return widgets.length > 0 ? { widgets } : fallback();
}

module.exports = {
	DASHBOARD_PREFS_FILE,
	DASHBOARD_WIDGET_IDS,
	DASHBOARD_MAX_COLS,
	DASHBOARD_WIDGET_MAX_H,
	defaultDashboardWidgets,
	defaultDashboardPreferences,
	normalizeDashboardPreferences,
};
