import { useEffect, useRef, useState } from "react";
import {
	ArrowPathIcon,
	ArrowUpOnSquareStackIcon,
	CheckIcon,
	ClockIcon,
	Cog6ToothIcon,
	FolderOpenIcon,
	GlobeAltIcon,
	HomeIcon,
	ListBulletIcon,
	LockClosedIcon,
	MinusIcon,
	NewspaperIcon,
	PauseIcon,
	PlayCircleIcon,
	PlusIcon,
	RocketLaunchIcon,
	Squares2X2Icon,
	SunIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import type { NotchTab, NotchWidgetId, NotchWidgetPlacement } from "../../types";
import { defaultTaskColumns } from "../../constants";
import { getActiveMapTaskColumns } from "../../utils";

// Mirrors NotchApp.tsx's own lastEnvironmentId() — reading the same
// localStorage key lets this editor (a separate window) show the active
// environment's real task columns instead of always falling back to the
// hardcoded defaults.
const lastEnvironmentId = () => {
	try {
		return localStorage.getItem("atlas.lastEnvironmentId");
	} catch {
		return null;
	}
};

// Matches tailwind's w-10/h-10 (grid cell) and gap-1.5 (gutter) — kept
// identical to NotchApp.tsx's GRID_CELL_PX/GRID_GAP_PX so what's designed
// here renders pixel-for-pixel the same on the notch itself.
const GRID_CELL_PX = 40;
const GRID_GAP_PX = 6;

export const GRID_MIN_COLS = 5;
export const GRID_MAX_COLS = 20;
export const GRID_MIN_ROWS = 1;
export const GRID_MAX_ROWS = 20;

const WIDGET_CATEGORIES: Array<{ label: string; widgets: NotchWidgetId[] }> = [
	{
		label: "Timer / session",
		widgets: [
			"timerStartStop",
			"timerPause",
			"timerDisplay",
			"timerStatusDot",
			"sessionStateLabel",
			"lockToggle",
		],
	},
	{
		label: "Time / stats",
		widgets: [
			"timeSpentToday",
			"activityTimeline",
			"topApp",
			"topAppCompact",
			"sessionsTodayCount",
			"openTasksCount",
			"untrackedToday",
		],
	},
	{
		label: "Tasks",
		widgets: [
			"firstTodoList",
			"taskCount",
			"quickAddTask",
			"nextTaskOnly",
			"taskColumnsOverview",
			"taskProgressBar",
		],
	},
	{ label: "Notes", widgets: ["notesCount", "lastNoteSnippet"] },
	{
		label: "Environment",
		widgets: ["environmentName", "environmentAccentDot", "environmentSwitcher", "environmentList"],
	},
	{
		label: "Launch / navigate",
		widgets: [
			"launchAppButton",
			"openUrlButton",
			"openDashboardButton",
			"openActivityButton",
			"openTasksButton",
			"openNotesButton",
			"openSettingsButton",
			"openMiniPlayerButton",
		],
	},
	{
		label: "Clock / date",
		widgets: ["currentTime", "currentDate", "dayOfWeek", "clockWithSeconds", "timeUntilMidnight"],
	},
	{
		label: "System",
		widgets: [
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
		],
	},
	{ label: "Visual / utility", widgets: ["divider", "label", "spacer", "accentSwatch", "themeToggle"] },
];

export const WIDGET_LABELS: Record<NotchWidgetId, string> = {
	timerStartStop: "Timer start/stop",
	timerPause: "Timer pause",
	timerDisplay: "Timer display",
	timerStatusDot: "Timer status dot",
	sessionStateLabel: "Session state",
	lockToggle: "Lock toggle",
	timeSpentToday: "Time spent today",
	activityTimeline: "Activity timeline (24h)",
	topApp: "Top app",
	topAppCompact: "Top app (compact)",
	sessionsTodayCount: "Sessions today",
	openTasksCount: "Open tasks count",
	untrackedToday: "Untracked today",
	firstTodoList: "First to-dos",
	taskCount: "Task count",
	quickAddTask: "Add task",
	nextTaskOnly: "Next task",
	taskColumnsOverview: "Task columns overview",
	taskProgressBar: "Task progress bar",
	notesCount: "Notes count",
	lastNoteSnippet: "Last note",
	environmentName: "Environment name",
	environmentAccentDot: "Environment color dot",
	environmentSwitcher: "Switch environment",
	environmentList: "Environment list",
	launchAppButton: "Launch app",
	openUrlButton: "Open URL",
	openDashboardButton: "Open dashboard",
	openActivityButton: "Open activity",
	openTasksButton: "Open tasks",
	openNotesButton: "Open notes",
	openSettingsButton: "Open settings",
	openMiniPlayerButton: "Open mini player",
	currentTime: "Current time",
	currentDate: "Current date",
	dayOfWeek: "Day of week",
	clockWithSeconds: "Clock with seconds",
	timeUntilMidnight: "Time until midnight",
	currentAppName: "Foreground app",
	platformBadge: "Platform badge",
	appVersionBadge: "App version",
	updateAvailableBadge: "Update available",
	minimizeButton: "Minimize window",
	focusMainButton: "Focus Atlas",
	cpuUsagePercent: "CPU usage",
	cpuUsageGraph: "CPU usage graph",
	memoryUsagePercent: "Memory usage",
	memoryUsageGraph: "Memory usage graph",
	divider: "Divider",
	label: "Custom label",
	spacer: "Spacer",
	accentSwatch: "Accent swatch",
	themeToggle: "Theme toggle",
};

export const NOTCH_WIDGET_IDS = Object.keys(WIDGET_LABELS) as NotchWidgetId[];

// Widgets with a single configurable string (a command, a URL, or text),
// edited via the inline field shown below the grid when one is selected.
const CONFIG_LABELS: Partial<Record<NotchWidgetId, string>> = {
	launchAppButton: "Program to launch",
	openUrlButton: "URL to open",
	label: "Label text",
};

const CONFIG_PLACEHOLDERS: Partial<Record<NotchWidgetId, string>> = {
	openUrlButton: "https://example.com",
	label: "Custom text",
};

// Task columns are custom per environment (the Tasks board lets each map
// define its own column set), so these widgets need to be told which column
// they're about rather than always defaulting to "the first one".
const COLUMN_CONFIG_WIDGETS = new Set<NotchWidgetId>([
	"quickAddTask",
	"firstTodoList",
	"nextTaskOnly",
	"taskCount",
	"taskProgressBar",
]);

// The size (in grid cells) a widget is given the moment it's dropped from
// the library onto an empty patch of grid. Clamped to fit on drop, so these
// are just sensible starting points, not hard requirements.
const WIDGET_DEFAULT_SIZE: Record<NotchWidgetId, { w: number; h: number }> = {
	timerStartStop: { w: 1, h: 1 },
	timerPause: { w: 1, h: 1 },
	timerDisplay: { w: 2, h: 1 },
	timerStatusDot: { w: 1, h: 1 },
	sessionStateLabel: { w: 2, h: 1 },
	lockToggle: { w: 1, h: 1 },
	timeSpentToday: { w: 5, h: 2 },
	activityTimeline: { w: 6, h: 2 },
	topApp: { w: 3, h: 2 },
	topAppCompact: { w: 2, h: 1 },
	sessionsTodayCount: { w: 2, h: 1 },
	openTasksCount: { w: 2, h: 1 },
	untrackedToday: { w: 2, h: 1 },
	firstTodoList: { w: 3, h: 3 },
	taskCount: { w: 2, h: 1 },
	quickAddTask: { w: 1, h: 1 },
	nextTaskOnly: { w: 3, h: 1 },
	taskColumnsOverview: { w: 3, h: 1 },
	taskProgressBar: { w: 3, h: 1 },
	notesCount: { w: 2, h: 1 },
	lastNoteSnippet: { w: 4, h: 2 },
	environmentName: { w: 3, h: 1 },
	environmentAccentDot: { w: 1, h: 1 },
	environmentSwitcher: { w: 1, h: 1 },
	environmentList: { w: 3, h: 3 },
	launchAppButton: { w: 1, h: 1 },
	openUrlButton: { w: 1, h: 1 },
	openDashboardButton: { w: 1, h: 1 },
	openActivityButton: { w: 1, h: 1 },
	openTasksButton: { w: 1, h: 1 },
	openNotesButton: { w: 1, h: 1 },
	openSettingsButton: { w: 1, h: 1 },
	openMiniPlayerButton: { w: 1, h: 1 },
	currentTime: { w: 2, h: 2 },
	currentDate: { w: 2, h: 1 },
	dayOfWeek: { w: 2, h: 1 },
	clockWithSeconds: { w: 3, h: 1 },
	timeUntilMidnight: { w: 3, h: 1 },
	currentAppName: { w: 3, h: 1 },
	platformBadge: { w: 2, h: 1 },
	appVersionBadge: { w: 2, h: 1 },
	updateAvailableBadge: { w: 3, h: 1 },
	minimizeButton: { w: 1, h: 1 },
	focusMainButton: { w: 1, h: 1 },
	cpuUsagePercent: { w: 2, h: 1 },
	cpuUsageGraph: { w: 3, h: 2 },
	memoryUsagePercent: { w: 2, h: 1 },
	memoryUsageGraph: { w: 3, h: 2 },
	divider: { w: 1, h: 2 },
	label: { w: 2, h: 1 },
	spacer: { w: 1, h: 1 },
	accentSwatch: { w: 1, h: 1 },
	themeToggle: { w: 1, h: 1 },
};

const NEW_WIDGET_MIME = "application/x-atlas-notch-new-widget";
const MOVE_PLACEMENT_MIME = "application/x-atlas-notch-move-placement";

let nextPlacementSuffix = 0;
const createPlacementId = () => `placement-${Date.now()}-${nextPlacementSuffix++}`;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

// Native HTML5 drag-and-drop doesn't auto-scroll its container, so a long
// widget list or a tall grid leaves whatever's off-screen unreachable while
// dragging. Walking up from the point under the cursor finds the nearest
// scrollable ancestor (the settings panel, almost always) to scroll instead.
function getScrollParent(node: HTMLElement | null): HTMLElement | null {
	let current = node;
	while (current && current !== document.body) {
		const style = window.getComputedStyle(current);
		if (
			(style.overflowY === "auto" || style.overflowY === "scroll") &&
			current.scrollHeight > current.clientHeight
		) {
			return current;
		}
		current = current.parentElement;
	}
	return null;
}

type Rect = { x: number; y: number; w: number; h: number };

const rectsOverlap = (a: Rect, b: Rect) =>
	a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// When the grid shrinks, every placement is pulled back inside the new
// bounds. Shrinking can put two placements on top of each other (e.g. a 3x2
// dragged out near the new edge collapses onto its neighbor), so each one is
// checked against the ones already kept and dropped — rather than silently
// overlapped — if it no longer fits cleanly.
const clampPlacementsToGrid = (
	placements: NotchWidgetPlacement[],
	cols: number,
	rows: number,
): NotchWidgetPlacement[] => {
	const kept: NotchWidgetPlacement[] = [];
	for (const placement of placements) {
		const w = Math.min(placement.w, cols);
		const h = Math.min(placement.h, rows);
		const x = Math.min(placement.x, cols - w);
		const y = Math.min(placement.y, rows - h);
		const next = { ...placement, w, h, x, y };
		if (kept.some((existing) => rectsOverlap(next, existing))) continue;
		kept.push(next);
	}
	return kept;
};

// Lets the user pick a launch command from whatever's currently running,
// instead of having to browse for the .exe themselves — fetched on open
// rather than kept polling, since the list only matters while choosing.
function RunningAppsPicker({ onSelect }: { onSelect: (command: string) => void }) {
	const [open, setOpen] = useState(false);
	const [apps, setApps] = useState<Array<{ name: string; path: string | null }> | null>(null);

	const toggle = () => {
		setOpen((next) => !next);
		if (!apps) {
			window.atlas
				.listOpenApps()
				.then(setApps)
				.catch(() => setApps([]));
		}
	};

	return (
		<div className="relative">
			<button
				type="button"
				onClick={toggle}
				className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
			>
				Running apps...
			</button>
			{open && (
				<>
					<div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
					<div className="absolute right-0 top-full z-50 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-0 p-1 shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
						{apps === null ? (
							<div className="px-2 py-1.5 text-xs text-neutral-400">Loading...</div>
						) : apps.length === 0 ? (
							<div className="px-2 py-1.5 text-xs text-neutral-400">No running apps found</div>
						) : (
							apps.map((item) => (
								<button
									key={item.name}
									type="button"
									onClick={() => {
										if (!item.path) return;
										const command = item.path.includes(" ") ? `"${item.path}"` : item.path;
										onSelect(command);
										setOpen(false);
									}}
									disabled={!item.path}
									className="flex w-full items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-xs text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
								>
									<span className="truncate">{item.name}</span>
								</button>
							))
						)}
					</div>
				</>
			)}
		</div>
	);
}

function NumberStepper({
	value,
	min,
	max,
	onChange,
}: {
	value: number;
	min: number;
	max: number;
	onChange: (value: number) => void;
}) {
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-600">
			<button
				type="button"
				onClick={() => onChange(Math.max(min, value - 1))}
				disabled={value <= min}
				className="flex h-7 w-7 items-center justify-center text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-700"
			>
				<MinusIcon className="h-3.5 w-3.5" />
			</button>
			<span className="w-7 text-center font-data text-sm text-neutral-700 dark:text-neutral-100">
				{value}
			</span>
			<button
				type="button"
				onClick={() => onChange(Math.min(max, value + 1))}
				disabled={value >= max}
				className="flex h-7 w-7 items-center justify-center text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-700"
			>
				<PlusIcon className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

// A plain centered icon, for the many widgets whose preview is just "this
// icon, nothing else" (mostly the navigation/action buttons).
function IconPreview({ icon: Icon }: { icon: typeof ClockIcon }) {
	return (
		<div className="flex h-full w-full items-center justify-center">
			<Icon className="h-4.5 w-4.5 text-neutral-600 dark:text-neutral-200" />
		</div>
	);
}

// A plain centered text sample, for the many widgets that are just "one line
// of text" on the real notch.
function TextPreview({ text, dim = false }: { text: string; dim?: boolean }) {
	return (
		<div className="flex h-full w-full items-center justify-center px-1">
			<span
				className={`truncate text-[10px] ${
					dim
						? "text-neutral-500 dark:text-neutral-300"
						: "font-medium text-neutral-700 dark:text-neutral-100"
				}`}
			>
				{text}
			</span>
		</div>
	);
}

const ICON_PREVIEWS: Partial<Record<NotchWidgetId, typeof ClockIcon>> = {
	lockToggle: LockClosedIcon,
	environmentSwitcher: ArrowPathIcon,
	launchAppButton: RocketLaunchIcon,
	openUrlButton: GlobeAltIcon,
	openDashboardButton: Squares2X2Icon,
	openActivityButton: ClockIcon,
	openTasksButton: ListBulletIcon,
	openNotesButton: NewspaperIcon,
	openSettingsButton: Cog6ToothIcon,
	openMiniPlayerButton: ArrowUpOnSquareStackIcon,
	minimizeButton: MinusIcon,
	focusMainButton: HomeIcon,
	themeToggle: SunIcon,
	quickAddTask: PlusIcon,
};

const TEXT_PREVIEWS: Partial<Record<NotchWidgetId, string>> = {
	topAppCompact: "Chrome",
	openTasksCount: "5 open",
	untrackedToday: "1h 10m untracked",
	taskCount: "4 to do",
	taskColumnsOverview: "3 · 2 · 1",
	notesCount: "12 notes",
	environmentName: "Coding",
	currentDate: "20 Jun",
	dayOfWeek: "Saturday",
	clockWithSeconds: "14:32:08",
	timeUntilMidnight: "9h 28m left",
	currentAppName: "Visual Studio Code",
	platformBadge: "win32",
	appVersionBadge: "v1.0.0",
	sessionStateLabel: "Running",
	lastNoteSnippet: "Remember to...",
	updateAvailableBadge: "Up to date",
	cpuUsagePercent: "42% CPU",
	memoryUsagePercent: "61% RAM",
};

// Caches fetched app icons by command/path so re-rendering (e.g. re-selecting
// the same placement) doesn't refetch — icons don't change without the user
// picking a different program.
const fileIconCache = new Map<string, string | null>();

function AppIconPreview({ command }: { command: string }) {
	const [dataUrl, setDataUrl] = useState<string | null>(fileIconCache.get(command) ?? null);

	useEffect(() => {
		if (fileIconCache.has(command)) {
			setDataUrl(fileIconCache.get(command) ?? null);
			return;
		}
		window.atlas
			.getFileIcon(command)
			.then((icon) => {
				fileIconCache.set(command, icon);
				setDataUrl(icon);
			})
			.catch(() => fileIconCache.set(command, null));
	}, [command]);

	if (!dataUrl) return <IconPreview icon={RocketLaunchIcon} />;
	return (
		<div className="flex h-full w-full items-center justify-center">
			<img src={dataUrl} alt="" className="h-4.5 w-4.5" />
		</div>
	);
}

// Mirrors NotchApp.tsx's renderWidget output (same icons, same layout,
// relative to the identical cell size) but with sample data instead of live
// data, so the grid here is a true visual preview of what the notch will
// show rather than a text label standing in for it.
function WidgetPreview({ widgetId, config }: { widgetId: NotchWidgetId; config?: string }) {
	if (widgetId === "launchAppButton") {
		return config ? <AppIconPreview command={config} /> : <IconPreview icon={RocketLaunchIcon} />;
	}
	const icon = ICON_PREVIEWS[widgetId];
	if (icon) return <IconPreview icon={icon} />;
	const text = TEXT_PREVIEWS[widgetId];
	if (text)
		return (
			<TextPreview text={text} dim={widgetId !== "environmentName" && widgetId !== "sessionStateLabel"} />
		);

	switch (widgetId) {
		case "timerStartStop":
			return <IconPreview icon={PlayCircleIcon} />;
		case "timerPause":
			return <IconPreview icon={PauseIcon} />;
		case "timerDisplay":
			return <TextPreview text="00:12:34" />;
		case "timerStatusDot":
			return (
				<div className="flex h-full w-full items-center justify-center">
					<span className="h-2.5 w-2.5 rounded-full bg-primary" />
				</div>
			);
		case "timeSpentToday":
			return (
				<div className="flex h-full w-full flex-col justify-center gap-1.5 px-2">
					<div className="relative h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-600">
						<span className="absolute inset-y-0 left-0 w-2/3 bg-neutral-700 dark:bg-neutral-100" />
					</div>
					<div className="flex items-center justify-between gap-1 text-[10px] text-neutral-500 dark:text-neutral-300">
						<span>10:42</span>
						<span className="font-medium text-neutral-700 dark:text-neutral-100">2h 15m</span>
					</div>
				</div>
			);
		case "activityTimeline":
			return (
				<div className="flex h-full w-full flex-col justify-center gap-1 px-2">
					<div className="relative h-3 w-full overflow-hidden rounded-md bg-neutral-200 dark:bg-neutral-600">
						<span className="absolute top-0 left-[8%] h-full w-[15%] bg-primary" />
						<span className="absolute top-0 left-[40%] h-full w-[10%] bg-primary" />
						<span className="absolute top-0 left-[65%] h-full w-[20%] bg-primary" />
					</div>
					<div className="flex justify-between text-[9px] text-neutral-500 dark:text-neutral-300">
						<span>00</span>
						<span>06</span>
						<span>12</span>
						<span>18</span>
						<span>24</span>
					</div>
				</div>
			);
		case "topApp":
			return (
				<div className="flex h-full w-full items-center justify-center gap-2 px-2">
					<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-400/20 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300">
						<RocketLaunchIcon className="h-3.5 w-3.5" />
					</div>
					<span className="truncate text-[11px] font-medium text-neutral-700 dark:text-neutral-100">
						Chrome · 1h 20m
					</span>
				</div>
			);
		case "sessionsTodayCount":
			return (
				<div className="flex h-full w-full items-center justify-center gap-1">
					<span className="font-data text-[12px] font-semibold text-neutral-800 dark:text-neutral-0">3</span>
					<span className="text-[9px] text-neutral-500 dark:text-neutral-300">of 14 sessions</span>
				</div>
			);
		case "cpuUsageGraph":
		case "memoryUsageGraph":
			return (
				<div className="relative flex h-full w-full items-end gap-0.5 px-2 py-2">
					<span className="absolute left-1.5 top-1 text-[10px] text-neutral-500 dark:text-neutral-300">
						42% {widgetId === "cpuUsageGraph" ? "CPU" : "RAM"}
					</span>
					{[30, 55, 40, 70, 50, 65, 45, 80, 60, 35].map((value, index) => (
						<span key={index} className="flex-1 rounded-sm bg-primary/60" style={{ height: `${value}%` }} />
					))}
				</div>
			);
		case "firstTodoList":
			return (
				<div className="flex h-full w-full flex-col justify-center gap-1 px-2">
					{["Buy groceries", "Write report"].map((title) => (
						<div key={title} className="flex items-center justify-between gap-1">
							<span className="truncate text-[10px] text-neutral-700 dark:text-neutral-100">{title}</span>
							<CheckIcon className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-300" />
						</div>
					))}
				</div>
			);
		case "nextTaskOnly":
			return (
				<div className="flex h-full w-full items-center justify-between gap-1 px-2">
					<span className="truncate text-[10px] text-neutral-700 dark:text-neutral-100">Buy groceries</span>
					<CheckIcon className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-300" />
				</div>
			);
		case "taskProgressBar":
			return (
				<div className="flex h-full w-full flex-col justify-center gap-1 px-2">
					<div className="relative h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-600">
						<span className="absolute inset-y-0 left-0 w-1/3 bg-primary" />
					</div>
					<span className="text-[9px] text-neutral-500 dark:text-neutral-300">2/6 done</span>
				</div>
			);
		case "lastNoteSnippet":
			return <TextPreview text="Remember to follow up..." dim />;
		case "environmentAccentDot":
		case "accentSwatch":
			return (
				<div className="flex h-full w-full items-center justify-center">
					<span className="h-3.5 w-3.5 rounded-md bg-primary" />
				</div>
			);
		case "environmentList":
			return (
				<div className="flex h-full w-full flex-col justify-center gap-0.5 px-1.5">
					{["Coding", "Writing", "Study"].map((name) => (
						<span key={name} className="truncate text-[10px] text-neutral-600 dark:text-neutral-300">
							{name}
						</span>
					))}
				</div>
			);
		case "currentTime":
			return (
				<div className="flex h-full w-full items-center justify-center">
					<span className="font-data text-[12px] text-neutral-700 dark:text-neutral-100">
						{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
					</span>
				</div>
			);
		case "divider":
			return (
				<div className="flex h-full w-full items-center justify-center">
					<span className="h-full w-px bg-neutral-300 dark:bg-neutral-500" />
				</div>
			);
		case "label":
			return <TextPreview text="Label" />;
		case "spacer":
			return (
				<div className="flex h-full w-full items-center justify-center text-[9px] text-neutral-300">∅</div>
			);
		default:
			return null;
	}
}

// What's currently being dragged, tracked via component state rather than
// dataTransfer.getData (which browsers don't reliably expose during
// dragover, only on the final drop) so the live preview below can know the
// dragged item's footprint while the pointer moves.
type DraggingInfo = { kind: "new"; widget: NotchWidgetId } | { kind: "move"; placementId: string };

export function NotchTabGridEditor({ tab, onChange }: { tab: NotchTab; onChange: (next: NotchTab) => void }) {
	const [draggingInfo, setDraggingInfo] = useState<DraggingInfo | null>(null);
	const [dragPreview, setDragPreview] = useState<(Rect & { valid: boolean }) | null>(null);
	const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
	const dragPointerRef = useRef<{ x: number; y: number } | null>(null);

	// Auto-scroll whatever's scrollable under the cursor while dragging, since
	// the browser won't do it on its own — without this, a widget or grid spot
	// below the fold is simply unreachable.
	useEffect(() => {
		if (!draggingInfo) {
			dragPointerRef.current = null;
			return;
		}
		const EDGE_PX = 60;
		const SCROLL_SPEED = 14;

		const handleDragOver = (event: DragEvent) => {
			dragPointerRef.current = { x: event.clientX, y: event.clientY };
		};
		window.addEventListener("dragover", handleDragOver);

		const interval = window.setInterval(() => {
			const pointer = dragPointerRef.current;
			if (!pointer) return;
			const elementUnderPointer = document.elementFromPoint(pointer.x, pointer.y) as HTMLElement | null;
			const scrollParent = elementUnderPointer && getScrollParent(elementUnderPointer);
			if (!scrollParent) return;
			const rect = scrollParent.getBoundingClientRect();
			if (pointer.y - rect.top < EDGE_PX) {
				scrollParent.scrollTop -= SCROLL_SPEED;
			} else if (rect.bottom - pointer.y < EDGE_PX) {
				scrollParent.scrollTop += SCROLL_SPEED;
			}
		}, 16);

		return () => {
			window.removeEventListener("dragover", handleDragOver);
			window.clearInterval(interval);
		};
	}, [draggingInfo]);

	const cellPitch = GRID_CELL_PX + GRID_GAP_PX;

	const cellFromPointer = (event: { clientX: number; clientY: number; currentTarget: HTMLDivElement }) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const x = clamp(Math.floor((event.clientX - rect.left) / cellPitch), 0, tab.gridCols - 1);
		const y = clamp(Math.floor((event.clientY - rect.top) / cellPitch), 0, tab.gridRows - 1);
		return { x, y };
	};

	// Where the currently-dragged item would land if dropped here right now,
	// clamped to the grid and checked against every other placement — used
	// both to paint the live preview and, on drop, to decide whether to
	// accept it at all.
	const previewForDrag = (
		info: DraggingInfo,
		anchor: { x: number; y: number },
	): (Rect & { valid: boolean }) | null => {
		const size =
			info.kind === "new"
				? (WIDGET_DEFAULT_SIZE[info.widget] ?? { w: 2, h: 2 })
				: tab.placements.find((placement) => placement.id === info.placementId);
		if (!size) return null;
		const w = Math.min(size.w, tab.gridCols);
		const h = Math.min(size.h, tab.gridRows);
		const x = clamp(anchor.x, 0, tab.gridCols - w);
		const y = clamp(anchor.y, 0, tab.gridRows - h);
		const rect = { x, y, w, h };
		const collides = tab.placements.some(
			(placement) =>
				!(info.kind === "move" && placement.id === info.placementId) && rectsOverlap(rect, placement),
		);
		return { ...rect, valid: !collides };
	};

	const setGridSize = (gridCols: number, gridRows: number) => {
		onChange({
			...tab,
			gridCols,
			gridRows,
			placements: clampPlacementsToGrid(tab.placements, gridCols, gridRows),
		});
	};

	const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		const anchor = cellFromPointer(event);
		setDragPreview(null);
		setDraggingInfo(null);

		const newWidget = event.dataTransfer.getData(NEW_WIDGET_MIME) as NotchWidgetId | "";
		if (newWidget) {
			const preview = previewForDrag({ kind: "new", widget: newWidget }, anchor);
			if (!preview || !preview.valid) return;
			const placement: NotchWidgetPlacement = {
				id: createPlacementId(),
				widget: newWidget,
				x: preview.x,
				y: preview.y,
				w: preview.w,
				h: preview.h,
			};
			onChange({ ...tab, placements: [...tab.placements, placement] });
			setSelectedPlacementId(placement.id);
			return;
		}

		const movedId = event.dataTransfer.getData(MOVE_PLACEMENT_MIME);
		if (movedId) {
			const existing = tab.placements.find((placement) => placement.id === movedId);
			if (!existing) return;
			const preview = previewForDrag({ kind: "move", placementId: movedId }, anchor);
			if (!preview || !preview.valid) return;
			onChange({
				...tab,
				placements: tab.placements.map((placement) =>
					placement.id === movedId ? { ...placement, x: preview.x, y: preview.y } : placement,
				),
			});
		}
	};

	const removePlacement = (id: string) => {
		onChange({ ...tab, placements: tab.placements.filter((placement) => placement.id !== id) });
		if (selectedPlacementId === id) setSelectedPlacementId(null);
	};

	const selectedPlacement = tab.placements.find((placement) => placement.id === selectedPlacementId) ?? null;
	const configLabel = selectedPlacement ? CONFIG_LABELS[selectedPlacement.widget] : undefined;
	const isLaunchAppButton = selectedPlacement?.widget === "launchAppButton";
	const isColumnWidget = selectedPlacement ? COLUMN_CONFIG_WIDGETS.has(selectedPlacement.widget) : false;
	const taskColumns = getActiveMapTaskColumns(lastEnvironmentId(), defaultTaskColumns);

	const setSelectedConfig = (config: string) => {
		if (!selectedPlacement) return;
		onChange({
			...tab,
			placements: tab.placements.map((placement) =>
				placement.id === selectedPlacement.id ? { ...placement, config } : placement,
			),
		});
	};

	return (
		<div className="grid gap-3">
			<div className="flex flex-wrap items-center gap-4">
				<label className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-300">
					Columns
					<NumberStepper
						value={tab.gridCols}
						min={GRID_MIN_COLS}
						max={GRID_MAX_COLS}
						onChange={(value) => setGridSize(value, tab.gridRows)}
					/>
				</label>
				<label className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-300">
					Rows
					<NumberStepper
						value={tab.gridRows}
						min={GRID_MIN_ROWS}
						max={GRID_MAX_ROWS}
						onChange={(value) => setGridSize(tab.gridCols, value)}
					/>
				</label>
			</div>

			<div
				onDragOver={(event) => {
					event.preventDefault();
					if (!draggingInfo) return;
					setDragPreview(previewForDrag(draggingInfo, cellFromPointer(event)));
				}}
				onDragLeave={() => setDragPreview(null)}
				onDrop={handleDrop}
				className="relative inline-grid rounded-xl border border-dashed border-neutral-300 bg-neutral-50 p-2 dark:border-neutral-600 dark:bg-neutral-800/40"
				style={{
					gridTemplateColumns: `repeat(${tab.gridCols}, ${GRID_CELL_PX}px)`,
					gridTemplateRows: `repeat(${tab.gridRows}, ${GRID_CELL_PX}px)`,
					gap: `${GRID_GAP_PX}px`,
				}}
			>
				{Array.from({ length: tab.gridCols * tab.gridRows }).map((_, index) => {
					const x = index % tab.gridCols;
					const y = Math.floor(index / tab.gridCols);
					return (
						<div
							key={index}
							className="rounded-md bg-neutral-200/60 dark:bg-neutral-700/40"
							style={{ gridColumn: x + 1, gridRow: y + 1 }}
						/>
					);
				})}

				{tab.placements.map((placement) => (
					<div
						key={placement.id}
						draggable
						onDragStart={(event) => {
							event.dataTransfer.setData(MOVE_PLACEMENT_MIME, placement.id);
							setDraggingInfo({ kind: "move", placementId: placement.id });
						}}
						onDragEnd={() => {
							setDraggingInfo(null);
							setDragPreview(null);
						}}
						onClick={() => setSelectedPlacementId(placement.id)}
						style={{
							gridColumn: `${placement.x + 1} / span ${placement.w}`,
							gridRow: `${placement.y + 1} / span ${placement.h}`,
						}}
						className={`group relative cursor-grab overflow-hidden rounded-lg border bg-neutral-0 transition-shadow active:cursor-grabbing dark:bg-neutral-800 ${
							selectedPlacementId === placement.id
								? "border-primary ring-2 ring-primary/50"
								: "border-neutral-200 hover:ring-2 hover:ring-primary/30 dark:border-neutral-600"
						}`}
						title={WIDGET_LABELS[placement.widget]}
					>
						<WidgetPreview widgetId={placement.widget} config={placement.config} />
						<button
							type="button"
							onClick={(event) => {
								event.stopPropagation();
								removePlacement(placement.id);
							}}
							title="Remove"
							aria-label="Remove widget"
							className="absolute right-1 top-1 hidden h-4.5 w-4.5 items-center justify-center rounded-full bg-neutral-900/70 text-white group-hover:flex"
						>
							<XMarkIcon className="h-3 w-3" />
						</button>
					</div>
				))}

				{dragPreview && (
					<div
						className={`pointer-events-none rounded-lg border-2 ${
							dragPreview.valid ? "border-primary bg-primary/15" : "border-red-500 bg-red-500/15"
						}`}
						style={{
							gridColumn: `${dragPreview.x + 1} / span ${dragPreview.w}`,
							gridRow: `${dragPreview.y + 1} / span ${dragPreview.h}`,
						}}
					/>
				)}
			</div>

			{selectedPlacement && isLaunchAppButton && (
				<div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-600 dark:bg-neutral-800/40">
					<span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-300">Program to launch</span>
					<input
						type="text"
						value={selectedPlacement.config ?? ""}
						onChange={(event) => setSelectedConfig(event.target.value)}
						placeholder="Pick a program below"
						className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-primary dark:border-neutral-600"
					/>
					<RunningAppsPicker onSelect={setSelectedConfig} />
					<button
						type="button"
						onClick={async () => {
							const filePath = await window.atlas.pickAppFile();
							if (!filePath) return;
							setSelectedConfig(filePath.includes(" ") ? `"${filePath}"` : filePath);
						}}
						className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
					>
						<FolderOpenIcon className="h-3.5 w-3.5" />
						Browse...
					</button>
				</div>
			)}

			{selectedPlacement && isColumnWidget && (
				<div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-600 dark:bg-neutral-800/40">
					<span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-300">Task column</span>
					<select
						value={selectedPlacement.config ?? ""}
						onChange={(event) => setSelectedConfig(event.target.value)}
						className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-primary dark:border-neutral-600"
					>
						<option value="">Default (first column)</option>
						{taskColumns.map((column) => (
							<option key={column.status} value={column.status}>
								{column.label}
							</option>
						))}
					</select>
				</div>
			)}

			{selectedPlacement && !isLaunchAppButton && !isColumnWidget && configLabel && (
				<div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-600 dark:bg-neutral-800/40">
					<span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-300">{configLabel}</span>
					<input
						type="text"
						value={selectedPlacement.config ?? ""}
						onChange={(event) => setSelectedConfig(event.target.value)}
						placeholder={CONFIG_PLACEHOLDERS[selectedPlacement.widget]}
						className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-primary dark:border-neutral-600"
					/>
				</div>
			)}

			<div className="grid gap-3">
				<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
					Drag onto the grid
				</span>
				{WIDGET_CATEGORIES.map((category) => (
					<div key={category.label} className="grid gap-1.5">
						<span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
							{category.label}
						</span>
						<div className="flex flex-wrap gap-2">
							{category.widgets.map((widgetId) => (
								<div
									key={widgetId}
									draggable
									onDragStart={(event) => {
										event.dataTransfer.setData(NEW_WIDGET_MIME, widgetId);
										setDraggingInfo({ kind: "new", widget: widgetId });
									}}
									onDragEnd={() => {
										setDraggingInfo(null);
										setDragPreview(null);
									}}
									className="flex cursor-grab flex-col gap-1 rounded-lg border border-neutral-200 bg-neutral-0 p-1.5 transition-colors hover:border-primary/60 active:cursor-grabbing dark:border-neutral-600 dark:bg-neutral-800"
									title={`Drag onto the grid: ${WIDGET_LABELS[widgetId]}`}
								>
									<div
										className="overflow-hidden rounded-md bg-neutral-50 dark:bg-neutral-700/50"
										style={{ width: GRID_CELL_PX * 2, height: GRID_CELL_PX }}
									>
										<WidgetPreview widgetId={widgetId} />
									</div>
									<span className="max-w-20 truncate text-center text-[10px] text-neutral-500 dark:text-neutral-300">
										{WIDGET_LABELS[widgetId]}
									</span>
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
