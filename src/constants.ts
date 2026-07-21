import {
	BoltIcon,
	ChartBarIcon,
	ClipboardDocumentListIcon,
	Cog6ToothIcon,
	DocumentTextIcon,
	Squares2X2Icon,
} from "@heroicons/react/24/outline";
import {
	BoltIcon as BoltIconSolid,
	ChartBarIcon as ChartBarIconSolid,
	ClipboardDocumentListIcon as ClipboardDocumentListIconSolid,
	Cog6ToothIcon as Cog6ToothIconSolid,
	DocumentTextIcon as DocumentTextIconSolid,
	Squares2X2Icon as Squares2X2IconSolid,
} from "@heroicons/react/24/solid";
import type { AtlasNavItem } from "./components/atlas-layout.types";
import type { DashboardOverview, TaskColumn } from "./types";

export const TASK_ORDER_KEY = "atlas.taskOrderByEnvironment";
export const TASK_COLUMNS_KEY = "atlas.taskColumnsByEnvironment";
export const THEME_KEY = "atlas.theme";
export const SIDEBAR_HIDDEN_KEY = "atlas.sidebarHidden";

export const defaultDashboard: DashboardOverview = {
	totalTodayMs: 0,
	timePerApp: [],
	timePerEnvironment: [],
	quickStats: {
		sessionsToday: 0,
		openTasks: 0,
	},
};

export const defaultTaskColumns: TaskColumn[] = [
	{ status: "todo", label: "Todo" },
	{ status: "in_progress", label: "In progress" },
	{ status: "done", label: "Done" },
];

export const viewItems: AtlasNavItem[] = [
	{ id: "dashboard", label: "Dashboard", outlineIcon: Squares2X2Icon, solidIcon: Squares2X2IconSolid },
	{ id: "activity", label: "Activity", outlineIcon: ChartBarIcon, solidIcon: ChartBarIconSolid },
	{
		id: "tasks",
		label: "Tasks",
		outlineIcon: ClipboardDocumentListIcon,
		solidIcon: ClipboardDocumentListIconSolid,
	},
	{ id: "notes", label: "Notes", outlineIcon: DocumentTextIcon, solidIcon: DocumentTextIconSolid },
	{ id: "focus", label: "Focus", outlineIcon: BoltIcon, solidIcon: BoltIconSolid },
	{ id: "settings", label: "Settings", outlineIcon: Cog6ToothIcon, solidIcon: Cog6ToothIconSolid },
];
