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
	activityTimeline: "Activity timeline (24h)",
	untrackedToday: "Untracked time",
	avgSessionLength: "Average session",
	sessionsToday: "Sessions today",
	quickStats: "Quick stats",
	topApp: "Top app",
	timePerApp: "Time per app",
	timePerEnvironment: "Time per environment",
	currentApp: "Current app",
	currentEnvironment: "Current environment",
	openTasks: "Open tasks",
	dueTasks: "Due tasks",
	taskProgress: "Task progress",
	taskColumnsOverview: "Task columns",
	upcomingTasks: "Upcoming tasks",
	notesCount: "Notebook",
	lastNote: "Latest note",
	clock: "Clock",
	date: "Date",
	greeting: "Greeting",
	quickActions: "Quick actions",
	launchApp: "Launch app",
	openUrl: "Open link",
};

// A short blurb shown under each widget in the "add card" gallery.
export const DASHBOARD_WIDGET_DESCRIPTIONS: Record<DashboardWidgetId, string> = {
	totalTimeToday: "Big read-out of today's tracked time",
	activityTimeline: "When you were active across the day",
	untrackedToday: "Time today with no session running",
	avgSessionLength: "Average length of today's sessions",
	sessionsToday: "Count of today's sessions",
	quickStats: "Sessions, tasks, app and environment at a glance",
	topApp: "The app you spent the most time in",
	timePerApp: "Ranked bar list of time spent per app",
	timePerEnvironment: "Time totals per environment",
	currentApp: "The app in the foreground right now",
	currentEnvironment: "The active environment",
	openTasks: "Number of open tasks",
	dueTasks: "Tasks due today or overdue",
	taskProgress: "Completed vs. total tasks",
	taskColumnsOverview: "Task count in every board column",
	upcomingTasks: "Your next few open tasks",
	notesCount: "Words in this environment's notebook",
	lastNote: "A snippet of your latest note",
	clock: "The current time",
	date: "Today's day and date",
	greeting: "A friendly, time-aware greeting",
	quickActions: "Buttons that launch your saved commands",
	launchApp: "A button that opens a program you pick",
	openUrl: "A button that opens a website you pick",
};

// The fixed size variants each widget offers in the gallery, iOS-style: you
// pick one when adding the card and can't resize it afterwards. The first
// entry is the default / most-compact option.
export type DashboardWidgetSize = { label: string; w: number; h: number };

const SMALL_WIDE: DashboardWidgetSize[] = [
	{ label: "Small", w: 1, h: 1 },
	{ label: "Wide", w: 2, h: 1 },
];

export const DASHBOARD_WIDGET_SIZES: Record<DashboardWidgetId, DashboardWidgetSize[]> = {
	totalTimeToday: [
		{ label: "Medium", w: 2, h: 1 },
		{ label: "Large", w: 2, h: 2 },
	],
	activityTimeline: [
		{ label: "Wide", w: 4, h: 1 },
		{ label: "Large", w: 4, h: 2 },
	],
	untrackedToday: SMALL_WIDE,
	avgSessionLength: SMALL_WIDE,
	sessionsToday: SMALL_WIDE,
	quickStats: [
		{ label: "Medium", w: 2, h: 2 },
		{ label: "Wide", w: 4, h: 2 },
	],
	topApp: SMALL_WIDE,
	timePerApp: [
		{ label: "Medium", w: 2, h: 2 },
		{ label: "Tall", w: 2, h: 3 },
		{ label: "Wide", w: 4, h: 2 },
	],
	timePerEnvironment: [
		{ label: "Medium", w: 2, h: 2 },
		{ label: "Tall", w: 2, h: 3 },
	],
	currentApp: SMALL_WIDE,
	currentEnvironment: SMALL_WIDE,
	openTasks: SMALL_WIDE,
	dueTasks: SMALL_WIDE,
	taskProgress: [
		{ label: "Wide", w: 2, h: 1 },
		{ label: "Medium", w: 2, h: 2 },
	],
	taskColumnsOverview: [
		{ label: "Wide", w: 2, h: 1 },
		{ label: "Medium", w: 2, h: 2 },
	],
	upcomingTasks: [
		{ label: "Medium", w: 2, h: 2 },
		{ label: "Tall", w: 2, h: 3 },
	],
	notesCount: SMALL_WIDE,
	lastNote: [
		{ label: "Medium", w: 2, h: 2 },
		{ label: "Wide", w: 4, h: 2 },
	],
	clock: SMALL_WIDE,
	date: SMALL_WIDE,
	greeting: [
		{ label: "Wide", w: 2, h: 1 },
		{ label: "Large", w: 4, h: 1 },
	],
	quickActions: [
		{ label: "Wide", w: 2, h: 1 },
		{ label: "Medium", w: 2, h: 2 },
	],
	launchApp: SMALL_WIDE,
	openUrl: SMALL_WIDE,
};

// Gallery grouping so the (now full-screen) picker reads as organized sections
// rather than one long list.
export const DASHBOARD_WIDGET_CATEGORIES: Array<{ label: string; widgets: DashboardWidgetId[] }> = [
	{
		label: "Time",
		widgets: ["totalTimeToday", "activityTimeline", "untrackedToday", "avgSessionLength", "sessionsToday"],
	},
	{
		label: "Overview",
		widgets: ["quickStats", "topApp", "timePerApp", "timePerEnvironment", "currentApp", "currentEnvironment"],
	},
	{ label: "Tasks", widgets: ["openTasks", "dueTasks", "taskProgress", "taskColumnsOverview", "upcomingTasks"] },
	{ label: "Notes", widgets: ["notesCount", "lastNote"] },
	{ label: "Clock", widgets: ["clock", "date", "greeting"] },
	{ label: "Apps & links", widgets: ["quickActions", "launchApp", "openUrl"] },
];

// Widgets that carry a per-instance `config` string and need setting up after
// they're added (a program to launch, a URL to open).
export const DASHBOARD_CONFIG_WIDGETS = new Set<DashboardWidgetId>(["launchApp", "openUrl"]);

export const DASHBOARD_WIDGET_IDS = Object.keys(DASHBOARD_WIDGET_LABELS) as DashboardWidgetId[];

let nextDashboardSuffix = 0;
export const createDashboardPlacementId = () => `dash-${Date.now()}-${nextDashboardSuffix++}`;
