import {
	ChartBarIcon,
	ClipboardDocumentListIcon,
	ClockIcon,
	Cog6ToothIcon,
	DocumentTextIcon,
	Squares2X2Icon,
} from "@heroicons/react/24/outline";
import {
	ChartBarIcon as ChartBarIconSolid,
	ClipboardDocumentListIcon as ClipboardDocumentListIconSolid,
	ClockIcon as ClockIconSolid,
	Cog6ToothIcon as Cog6ToothIconSolid,
	DocumentTextIcon as DocumentTextIconSolid,
	Squares2X2Icon as Squares2X2IconSolid,
} from "@heroicons/react/24/solid";
import type { AtlasNavItem } from "./components/atlas-layout.types";
import type { DashboardOverview, TaskColumn } from "./types";

export const TASK_ORDER_KEY = "atlas.taskOrderByMap";
export const TASK_COLUMNS_KEY = "atlas.taskColumnsByMap";
export const THEME_KEY = "atlas.theme";
export const QUICK_ACTIONS_KEY = "atlas.quickActions";

export const defaultDashboard: DashboardOverview = {
	totalTodayMs: 0,
	timePerApp: [],
	timePerMap: [],
	quickStats: {
		sessionsToday: 0,
		openTasks: 0,
	},
};

export const defaultQuickActions = [
	{ id: "vscode", label: "Open VS Code", command: "code" },
	{ id: "figma", label: "Open Figma", command: "figma" },
	{ id: "chrome", label: "Open Chrome", command: "chrome" },
];

export const defaultTaskColumns: TaskColumn[] = [
	{ status: "todo", label: "Todo" },
	{ status: "in_progress", label: "In progress" },
	{ status: "done", label: "Done" },
];

export const viewItems: AtlasNavItem[] = [
	{ id: "dashboard", label: "Dashboard", outlineIcon: Squares2X2Icon, solidIcon: Squares2X2IconSolid },
	{ id: "logbook", label: "Logbook", outlineIcon: ClockIcon, solidIcon: ClockIconSolid },
	{
		id: "tasks",
		label: "Tasks",
		outlineIcon: ClipboardDocumentListIcon,
		solidIcon: ClipboardDocumentListIconSolid,
	},
	{ id: "analysis", label: "Analyse", outlineIcon: ChartBarIcon, solidIcon: ChartBarIconSolid },
	{ id: "notes", label: "Notes", outlineIcon: DocumentTextIcon, solidIcon: DocumentTextIconSolid },
	{ id: "settings", label: "Settings", outlineIcon: Cog6ToothIcon, solidIcon: Cog6ToothIconSolid },
];
