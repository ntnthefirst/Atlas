export type EnvironmentPreset = "work" | "coding" | "gaming" | "montage" | "study" | "design" | "writing" | "custom";

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

export type NotchActionButtonId = "activity" | "dashboard" | "notes" | "tasks";

export type NotchActionButtonConfig = {
	id: NotchActionButtonId;
	enabled: boolean;
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
	actionButtons: NotchActionButtonConfig[];
	infoItems: NotchInfoItemConfig[];
};

export type DisplaySummary = {
	id: number;
	label: string;
	isPrimary: boolean;
	width: number;
	height: number;
};
