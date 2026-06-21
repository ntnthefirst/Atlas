export type EnvironmentPreset =
	| "work"
	| "coding"
	| "gaming"
	| "montage"
	| "study"
	| "design"
	| "writing"
	| "custom";

export type MapItem = {
	id: string;
	name: string;
	icon?: string | null;
	accent?: string | null;
	preset?: string | null;
	created_at: string;
};

export type Session = {
	id: string;
	map_id: string;
	started_at: string;
	ended_at: string | null;
	total_duration: number;
	paused_duration: number;
	is_active: number;
	is_paused: number;
	pause_started_at: string | null;
	created_at: string;
};

export type ActivityBlock = {
	id: string;
	session_id: string;
	app_name: string;
	started_at: string;
	ended_at: string | null;
	duration: number;
};

export type TaskStatus = string;

export type TaskColumn = {
	status: TaskStatus;
	label: string;
};

export type TaskItem = {
	id: string;
	map_id: string;
	title: string;
	description: string;
	status: TaskStatus;
	created_at: string;
	updated_at: string;
};

export type NoteItem = {
	id: string;
	map_id: string;
	content: string;
	created_at: string;
	updated_at: string;
};

export type NotebookNodeType = "text" | "media" | "postit";

export type NotebookNode = {
	id: string;
	type: NotebookNodeType;
	x: number;
	y: number;
	w: number;
	h: number;
	z: number;
	text?: string;
	dataUrl?: string;
	mimeType?: string;
	name?: string;
	textColor?: string;
	boxColor?: string;
	fontSize?: number;
};

export type NotebookDocument = {
	version: 1;
	viewport: {
		x: number;
		y: number;
		zoom: number;
	};
	nodes: NotebookNode[];
};

export type DashboardOverview = {
	totalTodayMs: number;
	timePerApp: Array<{ appName: string; duration: number }>;
	timePerMap: Array<{ mapName: string; duration: number }>;
	quickStats: {
		sessionsToday: number;
		openTasks: number;
	};
};

export type AtlasView = "dashboard" | "activity" | "tasks" | "notes" | "settings";

export type UpdateCheckResult = {
	hasUpdate: boolean;
	local: string;
	latest: string | null;
	downloadUrl?: string;
	releaseUrl?: string;
	publishedAt?: string | null;
	error?: string;
};

export type AppRelease = {
	tag: string;
	version: string;
	name: string;
	publishedAt: string | null;
	prerelease: boolean;
	draft: boolean;
	url: string;
	installerUrl?: string | null;
};

export type UpdatePreferences = {
	autoCheck: boolean;
	includeBeta: boolean;
};

export type DownloadAndInstallResult = {
	started: boolean;
	error?: string;
};

export type NotchPosition = "top" | "left" | "right" | "free";

export type NotchIdleOpacity = "subtle" | "balanced" | "solid";

export type NotchActivation = "always" | "withMain";

// What a tab can show in its expand panel below/beside the notch.
export type NotchWidgetId =
	// Timer/session
	| "timerStartStop"
	| "timerPause"
	| "timerDisplay"
	| "timerStatusDot"
	| "sessionStateLabel"
	| "lockToggle"
	// Time/stats
	| "timeSpentToday"
	| "activityTimeline"
	| "topApp"
	| "topAppCompact"
	| "sessionsTodayCount"
	| "openTasksCount"
	| "untrackedToday"
	// Tasks
	| "firstTodoList"
	| "taskCount"
	| "quickAddTask"
	| "nextTaskOnly"
	| "taskColumnsOverview"
	| "taskProgressBar"
	// Notes
	| "notesCount"
	| "lastNoteSnippet"
	// Environment
	| "environmentName"
	| "environmentAccentDot"
	| "environmentSwitcher"
	| "environmentList"
	// App launcher / navigation
	| "scene"
	| "launchAppButton"
	| "openUrlButton"
	| "openDashboardButton"
	| "openActivityButton"
	| "openTasksButton"
	| "openNotesButton"
	| "openSettingsButton"
	| "openMiniPlayerButton"
	// Clock/date
	| "currentTime"
	| "currentDate"
	| "dayOfWeek"
	| "clockWithSeconds"
	| "timeUntilMidnight"
	// System/app
	| "currentAppName"
	| "platformBadge"
	| "appVersionBadge"
	| "updateAvailableBadge"
	| "minimizeButton"
	| "focusMainButton"
	| "cpuUsagePercent"
	| "cpuUsageGraph"
	| "memoryUsagePercent"
	| "memoryUsageGraph"
	// Visual/utility
	| "divider"
	| "label"
	| "spacer"
	| "accentSwatch"
	| "themeToggle";

// Curated icon choices for custom tabs, picked from the grid icon-picker in
// settings. These are exactly the heroicons/24/outline export names, so a
// consuming component can build its icon map with plain object shorthand
// (e.g. `{ AcademicCapIcon, BoltIcon, ... }`) instead of a separate lookup.
export const NOTCH_TAB_ICONS = [
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
] as const;

export type NotchTabIcon = (typeof NOTCH_TAB_ICONS)[number];

// One widget dropped onto a tab's grid. x/y/w/h are in grid cells (0-indexed
// position, 1-indexed size), each cell being a fixed size (tailwind w-10/h-10)
// with a gap-1.5 gutter between cells — set in the settings grid editor and
// rendered identically on the notch itself.
export type NotchWidgetPlacement = {
	id: string;
	widget: NotchWidgetId;
	x: number;
	y: number;
	w: number;
	h: number;
	// Per-instance setting for the handful of widgets that need one:
	// launchAppButton (a command), openUrlButton (a URL), label (custom text),
	// quickAddTask/firstTodoList/nextTaskOnly/taskCount/taskProgressBar (a
	// task column's status — defaults to the first column when unset).
	config?: string;
};

// A user-defined action button. Clicking one toggles an expand panel below
// (horizontal notch) or beside (vertical/docked notch) the bar, laid out as a
// grid of widgets — it no longer navigates to the main window. There's no
// separate enabled flag: a tab either exists (and shows) or is deleted.
export type NotchTab = {
	id: string;
	label: string;
	icon: NotchTabIcon;
	gridCols: number;
	gridRows: number;
	placements: NotchWidgetPlacement[];
};

export type NotchInfoItemId = "timer" | "todo";

// Order is priority: the first enabled item that has something to show wins the
// single information slot.
export type NotchInfoItemConfig = {
	id: NotchInfoItemId;
	enabled: boolean;
};

export type NotchPreferences = {
	enabled: boolean;
	position: NotchPosition;
	x: number | null;
	y: number | null;
	idleOpacity: NotchIdleOpacity;
	locked: boolean;
	activation: NotchActivation;
	// Which displays show the notch. Empty means "primary display only", and
	// any id no longer connected falls back to the primary display.
	displayIds: number[];
	tabs: NotchTab[];
	infoItems: NotchInfoItemConfig[];
};

export type DisplaySummary = {
	id: number;
	label: string;
	isPrimary: boolean;
	width: number;
	height: number;
};
