import type { DashboardWidgetId, DashboardWidgetPlacement } from "../../../types";

// The dashboard lays cards out on a responsive column grid. These are the
// design maximums; the live grid renders fewer columns as the window narrows
// (see DashboardGrid), and each card's width is clamped to the columns that
// actually fit, so the layout reflows instead of overflowing.
export const DASHBOARD_MAX_COLS = 4;
export const DASHBOARD_ROW_PX = 88;
export const DASHBOARD_GAP_PX = 12;
export const DASHBOARD_MIN_COL_PX = 240;
export const DASHBOARD_WIDGET_MIN_H = 1;
export const DASHBOARD_WIDGET_MAX_H = 4;

export const DASHBOARD_WIDGET_LABELS: Record<DashboardWidgetId, string> = {
	totalTimeToday: "Total time today",
	quickStats: "Quick stats",
	sessionsToday: "Sessions today",
	openTasks: "Open tasks",
	timePerApp: "Time per app",
	timePerEnvironment: "Time per environment",
	quickActions: "Quick actions",
	activityTimeline: "Activity timeline (24h)",
	topApp: "Top app",
	currentApp: "Current app",
	currentEnvironment: "Current environment",
	taskProgress: "Task progress",
	notesCount: "Notebook",
};

// A short blurb shown under each widget in the "add card" library.
export const DASHBOARD_WIDGET_DESCRIPTIONS: Record<DashboardWidgetId, string> = {
	totalTimeToday: "Big read-out of today's tracked time",
	quickStats: "Sessions, tasks, app and environment at a glance",
	sessionsToday: "Count of today's sessions",
	openTasks: "Number of open tasks",
	timePerApp: "Ranked bar list of time spent per app",
	timePerEnvironment: "Time totals per environment",
	quickActions: "Buttons that launch your saved commands",
	activityTimeline: "When you were active across the day",
	topApp: "The app you spent the most time in",
	currentApp: "The app in the foreground right now",
	currentEnvironment: "The active environment",
	taskProgress: "Completed vs. total tasks",
	notesCount: "Words in this environment's notebook",
};

export const DASHBOARD_WIDGET_DEFAULT_SIZE: Record<DashboardWidgetId, { w: number; h: number }> = {
	totalTimeToday: { w: 2, h: 1 },
	quickStats: { w: 2, h: 2 },
	sessionsToday: { w: 1, h: 1 },
	openTasks: { w: 1, h: 1 },
	timePerApp: { w: 2, h: 2 },
	timePerEnvironment: { w: 2, h: 2 },
	quickActions: { w: 2, h: 1 },
	activityTimeline: { w: 4, h: 1 },
	topApp: { w: 1, h: 1 },
	currentApp: { w: 1, h: 1 },
	currentEnvironment: { w: 1, h: 1 },
	taskProgress: { w: 2, h: 1 },
	notesCount: { w: 1, h: 1 },
};

export const DASHBOARD_WIDGET_IDS = Object.keys(DASHBOARD_WIDGET_LABELS) as DashboardWidgetId[];

// The factory layout — reproduces the original fixed dashboard so a fresh
// install (or a "reset layout") looks familiar before the user customizes it.
export const createDefaultDashboardWidgets = (): DashboardWidgetPlacement[] => [
	{ id: "dash-total", widget: "totalTimeToday", w: 2, h: 1 },
	{ id: "dash-stats", widget: "quickStats", w: 2, h: 2 },
	{ id: "dash-timeline", widget: "activityTimeline", w: 4, h: 1 },
	{ id: "dash-apps", widget: "timePerApp", w: 2, h: 2 },
	{ id: "dash-envs", widget: "timePerEnvironment", w: 2, h: 2 },
	{ id: "dash-actions", widget: "quickActions", w: 2, h: 1 },
];

let nextDashboardSuffix = 0;
export const createDashboardPlacementId = () => `dash-${Date.now()}-${nextDashboardSuffix++}`;
