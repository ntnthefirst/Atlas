export type EnvironmentPreset =
	| "work"
	| "coding"
	| "gaming"
	| "montage"
	| "study"
	| "design"
	| "writing"
	| "custom";

// The two isolation modes (WP-0.8), exactly as electron/data/isolation.cjs's
// ISOLATION_MODES defines them. There are exactly two — do not add a third
// here without adding it there first; the renderer follows the data layer,
// never the other way around.
export type IsolationMode = "connected" | "enclosed";

export type Environment = {
	id: string;
	name: string;
	icon?: string | null;
	accent?: string | null;
	preset?: string | null;
	// A first-class column (WP-0.8, exposed to the renderer starting WP-1.2),
	// not part of `EnvironmentConfig` below — see that type's comment for why
	// keeping it separate matters.
	isolation_mode: IsolationMode;
	// WP-1.5: when this environment was archived (hidden from switching
	// surfaces, but with every row it owns left untouched — never a soft
	// delete), or null if it is currently visible. `listEnvironments` only
	// ever returns rows where this is null; `listArchivedEnvironments` is the
	// deliberate mirror image.
	archived_at?: string | null;
	created_at: string;
};

// WP-1.5: real per-category counts of everything deleting an environment
// would destroy (electron/db.cjs#getEnvironmentContentCounts), shown by the
// delete confirmation dialog instead of generic wording. `notes` counts the
// individual nodes on the environment's notebook canvas (what a user thinks
// of as "a note"), not the single database row that holds them all.
export type EnvironmentContentCounts = {
	tasks: number;
	sessions: number;
	notes: number;
	activityBlocks: number;
	events: number;
	hasCustomNotchLayout: boolean;
};

// One entry from the WP-0.8 cross-environment allowlist
// (electron/data/isolation.cjs's CROSS_ENVIRONMENT_ALLOWLIST), as served by
// `isolation:getAllowlist`. `label` is the plain-language description defined
// right next to that signal in isolation.cjs — the isolation-enforcement UI
// (WP-1.2) must render its "what Connected mode shares" list from an array of
// these, never from a hand-written list of strings, so that widening the
// allowlist in one place is the only change ever needed to keep the UI
// truthful.
export type IsolationAllowlistEntry = {
	signal: string;
	label: string;
};

// The per-environment settings document (WP-1.1). Mirrors
// electron/config/environment-config.cjs's schema exactly — that module is
// the source of truth (defaults, defensive parsing, the version upgrade
// path); this type just describes the shape a fully-resolved document
// always has by the time it reaches the renderer.
//
// `isolation_mode` is NOT part of this type, on purpose: it is already a
// first-class field on `Environment` itself (WP-0.8), and duplicating a
// security-relevant setting into two places is exactly the kind of drift
// this schema exists to avoid elsewhere.
export type EnvironmentThemePreference = "light" | "dark" | "system";

export type EnvironmentAppearanceConfig = {
	// Mirrors `Environment.accent` for a newly-created environment, but is
	// its own value once set — see environment-config.cjs's header comment
	// for why the two are allowed to exist side by side.
	accent: string | null;
	theme: EnvironmentThemePreference;
};

export type EnvironmentAiConfig = {
	// `null` means "inherit the app-wide default provider" (ai:getConfig),
	// not "no provider chosen".
	defaultProvider: AiProvider | null;
	systemPrompt: string;
};

// What happens when this environment is activated. Consumed starting with
// WP-1.4 ("environment switching"); this package only defines the shape and
// makes sure it round-trips.
export type EnvironmentStartupBehaviour = {
	autoStartSession: boolean;
	// Launch commands, in the same format as `window.atlas.launchApp` expects
	// (see NotchSceneConfig.apps in src/scenes.ts).
	launchApps: string[];
};

// An integration-enablement map, `{ [integrationId]: enabled }`. Empty until
// WP-5.x introduces the first integrations.
export type EnvironmentIntegrationsConfig = Record<string, boolean>;

export type EnvironmentConfig = {
	version: number;
	appearance: EnvironmentAppearanceConfig;
	// Which Notch layout this environment uses; consumed starting with
	// WP-1.3. `null` means "no layout chosen yet / use the default".
	notchLayoutId: string | null;
	ai: EnvironmentAiConfig;
	integrations: EnvironmentIntegrationsConfig;
	startupBehaviour: EnvironmentStartupBehaviour;
};

// A partial update to an environment's config — each present section is
// shallow-merged onto the current one, field by field (see
// environment-config.cjs#applyConfigPatch), so passing only `{ appearance:
// { theme: "dark" } }` leaves `appearance.accent` and every other section
// untouched.
export type EnvironmentConfigPatch = {
	appearance?: Partial<EnvironmentAppearanceConfig>;
	notchLayoutId?: string | null;
	ai?: Partial<EnvironmentAiConfig>;
	integrations?: EnvironmentIntegrationsConfig;
	startupBehaviour?: Partial<EnvironmentStartupBehaviour>;
};

// WP-1.4: what `environment:activated` broadcasts to every window whenever
// any surface (the Notch, the main app's own switcher, or the global
// hotkey's switcher) switches the active environment. Mirrors
// electron/services/environment-switch.cjs#resolveEnvironmentBundle plus the
// Notch layout resolution main.cjs adds alongside it -- see that module's
// header for why "resolve everything, then apply" is what keeps a switch
// atomic.
export type EnvironmentActivatedBundle = {
	environmentId: string | null;
	appearance: EnvironmentAppearanceConfig;
	ai: EnvironmentAiConfig;
};

// The rebindable global hotkey that opens the environment switcher (WP-1.4).
// `registered` is false when the accelerator could not be claimed --
// typically another application already holds it -- so Settings can show
// that plainly instead of a silently dead key.
export type EnvironmentHotkeyBinding = {
	accelerator: string;
	registered: boolean;
};

export type EnvironmentHotkeySetResult =
	| { ok: true; accelerator: string; registered: true }
	| { ok: false; accelerator: string; registered: boolean; error: string };

export type Session = {
	id: string;
	environment_id: string;
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

export type TaskPriority = "none" | "low" | "medium" | "high" | "urgent";

export const TASK_PRIORITIES: TaskPriority[] = ["none", "low", "medium", "high", "urgent"];

export type TaskItem = {
	id: string;
	environment_id: string;
	title: string;
	description: string;
	status: TaskStatus;
	priority: TaskPriority;
	tags: string[];
	due_date: string | null;
	created_at: string;
	updated_at: string;
};

// Fields the task detail panel can edit. All optional — only what's passed is
// written.
export type TaskUpdate = Partial<
	Pick<TaskItem, "title" | "description" | "status" | "priority" | "tags" | "due_date">
>;

export type NoteItem = {
	id: string;
	environment_id: string;
	content: string;
	created_at: string;
	updated_at: string;
};

// AI provider integrations (Claude / Gemini / OpenAI). Keys live in the main
// process; the renderer only ever receives whether a key is set.
export type AiProvider = "anthropic" | "google" | "openai";

export type AiProviderPublic = {
	hasKey: boolean;
	model: string;
	label: string;
};

export type AiPublicConfig = {
	defaultProvider: AiProvider;
	providers: Record<AiProvider, AiProviderPublic>;
	// False when the OS keystore is unavailable, in which case Atlas refuses to
	// store API keys rather than falling back to plaintext on disk.
	secretsAvailable: boolean;
};

export type AiConfigPatch = {
	defaultProvider?: AiProvider;
	providers?: Partial<Record<AiProvider, { apiKey?: string; model?: string }>>;
};

export type AiCompleteArgs = {
	provider?: AiProvider;
	model?: string;
	system?: string;
	prompt: string;
	maxTokens?: number;
};

export type AiCompleteResult =
	| { ok: true; text: string; provider: AiProvider; model: string }
	| { ok: false; error: string };

// What the notch's separate capture popup should collect, and the context it
// writes back into.
export type NotchInputPayload = {
	kind: "task" | "note";
	environmentId?: string;
	environmentName?: string;
	status?: string;
	columnLabel?: string;
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
	timePerEnvironment: Array<{ environmentName: string; duration: number }>;
	quickStats: {
		sessionsToday: number;
		openTasks: number;
	};
};

export type AtlasView = "dashboard" | "activity" | "tasks" | "notes" | "focus" | "settings";

// ---------------------------------------------------------------------------
// Focus mode (Pomodoro-style timer) + wellbeing nudges.
//
// The engine lives in the Electron main process so a single source of truth is
// shared across every window (main + notch) and so phase transitions and break
// nudges keep firing even when no window is focused. Each renderer computes its
// own smooth countdown from the absolute `phaseEndsAt` timestamp.
// ---------------------------------------------------------------------------

export type FocusPhase = "focus" | "shortBreak" | "longBreak";

// Recurring wellbeing reminders shown as native notifications while you work.
export type FocusNudgeKind = "stand" | "eyes" | "hydrate" | "posture";

export type FocusNudge = {
	kind: FocusNudgeKind;
	enabled: boolean;
	everyMinutes: number;
};

export type FocusConfig = {
	focusMinutes: number;
	shortBreakMinutes: number;
	longBreakMinutes: number;
	// How many focus rounds before a long break is offered.
	roundsBeforeLongBreak: number;
	// Whether the next phase starts on its own or waits for a manual start.
	autoStartBreaks: boolean;
	autoStartFocus: boolean;
	// When true, nudges only fire during an active (unpaused) focus phase;
	// otherwise they fire continuously while Atlas is running.
	nudgesOnlyDuringFocus: boolean;
	nudges: FocusNudge[];
};

// The live timer. `null` whenever no focus cycle is running.
export type FocusRuntime = {
	phase: FocusPhase;
	// Completed focus rounds in the current long-break cycle (0-based while the
	// first round runs).
	roundIndex: number;
	// Absolute epoch ms when the current phase ends — renderers derive the
	// countdown locally so the main process needn't broadcast every second.
	phaseEndsAt: number;
	phaseDurationMs: number;
	isPaused: boolean;
	// Frozen remaining ms while paused (phaseEndsAt is meaningless then).
	remainingMs: number;
	goal: string;
	startedAt: number;
};

// Daily counters, reset automatically when the calendar day rolls over.
export type FocusStats = {
	day: string; // YYYY-MM-DD the counters below belong to
	focusRoundsCompleted: number;
	focusMsCompleted: number;
};

export type FocusState = {
	config: FocusConfig;
	runtime: FocusRuntime | null;
	stats: FocusStats;
};

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
	| "quickAddNote"
	| "nextTaskOnly"
	| "taskColumnsOverview"
	| "taskProgressBar"
	| "dueTasksCount"
	// Notes
	| "notesCount"
	| "lastNoteSnippet"
	// Environment
	| "environmentName"
	| "environmentAccentDot"
	| "environmentSwitcher"
	| "environmentList"
	// Focus
	| "focusToggle"
	| "focusStatus"
	// App launcher / navigation
	| "scene"
	| "launchAppButton"
	| "openUrlButton"
	| "openDashboardButton"
	| "openActivityButton"
	| "openTasksButton"
	| "openNotesButton"
	| "openFocusButton"
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

// The result of resolving which Notch layout applies to a given environment
// (WP-1.3). Mirrors electron/config/notch-layouts.cjs's resolveNotchLayout()
// exactly -- `usesDefault: true` means `preferences` is the shared global
// default (edited via `setDefaultNotchLayout`); `false` means this
// environment has its own layout (`layoutId` identifies it, edited via
// `setEnvironmentNotchLayout`).
export type NotchLayoutResolution = {
	usesDefault: boolean;
	layoutId: string;
	preferences: NotchPreferences;
};

export type DisplaySummary = {
	id: number;
	label: string;
	isPrimary: boolean;
	width: number;
	height: number;
};

// What a card on the customizable main dashboard can show. Unlike the notch
// widgets (small, single-purpose), these are full dashboard cards built from
// the data already loaded for the dashboard view.
export type DashboardWidgetId =
	// Time
	| "totalTimeToday"
	| "activityTimeline"
	| "untrackedToday"
	| "avgSessionLength"
	| "sessionsToday"
	// Stats / overview
	| "quickStats"
	| "topApp"
	| "timePerApp"
	| "timePerEnvironment"
	| "currentApp"
	| "currentEnvironment"
	// Tasks
	| "openTasks"
	| "dueTasks"
	| "taskProgress"
	| "taskColumnsOverview"
	| "upcomingTasks"
	// Notes
	| "notesCount"
	| "lastNote"
	// Clock
	| "clock"
	| "date"
	| "greeting"
	// Focus
	| "focusToday"
	// Apps & links
	| "launchApp"
	| "openUrl";

// One card placed on the dashboard. Order in the array is the layout order;
// w/h are spans on a responsive column grid (the rendered column count shrinks
// as the window narrows, and a card's width is clamped to whatever columns are
// available), so there are no absolute x/y coordinates to keep valid.
export type DashboardWidgetPlacement = {
	id: string;
	widget: DashboardWidgetId;
	w: number;
	h: number;
	// Per-instance setting for the few configurable cards: launchApp (a launch
	// command), openUrl (a URL). Other widgets ignore it.
	config?: string;
};

export type DashboardPreferences = {
	widgets: DashboardWidgetPlacement[];
};
