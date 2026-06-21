import type { DashboardWidgetId } from "../../../types";

// The dashboard lays cards out on a responsive column grid. These are the
// design maximums; the live grid renders fewer columns as the window narrows
// (see DashboardGrid), and each card's width is clamped to the columns that
// actually fit, so the layout reflows instead of overflowing.
export const DASHBOARD_MAX_COLS = 4;
export const DASHBOARD_ROW_PX = 88;
export const DASHBOARD_GAP_PX = 12;
export const DASHBOARD_MIN_COL_PX = 240;

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

// The fixed size variants each widget offers in the gallery, iOS-style: you
// pick one when adding the card and can't resize it afterwards (to change
// size, remove it and add it again at a different size). The first entry is
// the default/most-compact option.
export type DashboardWidgetSize = { label: string; w: number; h: number };

export const DASHBOARD_WIDGET_SIZES: Record<DashboardWidgetId, DashboardWidgetSize[]> = {
	totalTimeToday: [
		{ label: "Medium", w: 2, h: 1 },
		{ label: "Large", w: 2, h: 2 },
	],
	quickStats: [
		{ label: "Medium", w: 2, h: 2 },
		{ label: "Wide", w: 4, h: 2 },
	],
	sessionsToday: [
		{ label: "Small", w: 1, h: 1 },
		{ label: "Wide", w: 2, h: 1 },
	],
	openTasks: [
		{ label: "Small", w: 1, h: 1 },
		{ label: "Wide", w: 2, h: 1 },
	],
	timePerApp: [
		{ label: "Medium", w: 2, h: 2 },
		{ label: "Tall", w: 2, h: 3 },
		{ label: "Wide", w: 4, h: 2 },
	],
	timePerEnvironment: [
		{ label: "Medium", w: 2, h: 2 },
		{ label: "Tall", w: 2, h: 3 },
	],
	quickActions: [
		{ label: "Wide", w: 2, h: 1 },
		{ label: "Medium", w: 2, h: 2 },
	],
	activityTimeline: [
		{ label: "Wide", w: 4, h: 1 },
		{ label: "Large", w: 4, h: 2 },
	],
	topApp: [
		{ label: "Small", w: 1, h: 1 },
		{ label: "Wide", w: 2, h: 1 },
	],
	currentApp: [
		{ label: "Small", w: 1, h: 1 },
		{ label: "Wide", w: 2, h: 1 },
	],
	currentEnvironment: [
		{ label: "Small", w: 1, h: 1 },
		{ label: "Wide", w: 2, h: 1 },
	],
	taskProgress: [
		{ label: "Wide", w: 2, h: 1 },
		{ label: "Medium", w: 2, h: 2 },
	],
	notesCount: [
		{ label: "Small", w: 1, h: 1 },
		{ label: "Wide", w: 2, h: 1 },
	],
};

export const DASHBOARD_WIDGET_IDS = Object.keys(DASHBOARD_WIDGET_LABELS) as DashboardWidgetId[];

let nextDashboardSuffix = 0;
export const createDashboardPlacementId = () => `dash-${Date.now()}-${nextDashboardSuffix++}`;
