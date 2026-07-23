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

// The launcher's own rebindable global hotkey (WP-2.1) -- a SEPARATE binding
// from the environment switcher's above, with its own accelerator and its own
// conflict reporting. See electron/services/launcher-hotkey.cjs.
export type LauncherHotkeyBinding = {
	accelerator: string;
	registered: boolean;
};

export type LauncherHotkeySetResult =
	| { ok: true; accelerator: string; registered: true }
	| { ok: false; accelerator: string; registered: boolean; error: string };

// A single launcher result row. `kind` is deliberately just `string` (not a
// union) -- WP-2.1 only ever produced "action" (the fixed stub list); the
// provider registry (electron/services/launcher-providers/index.cjs,
// WP-2.2+) brings its own kinds (task, note, app, file, ...) without a shape
// change here.
//
// `providerName`, `score`, and `icon` are new in WP-2.2 -- ADDITIVE fields
// only, so nothing that already destructured just {id, kind, title,
// subtitle} (see launcherResults.ts's reconciliation logic) breaks. `score`
// is the ranked, blended match+frecency score the registry computed (see
// launcher-providers/ranking.cjs) -- carried through mainly for debugging/
// future UI, never required for the list to render or reorder correctly.
export type LauncherResult = {
	id: string;
	kind: string;
	title: string;
	subtitle?: string | null;
	providerName?: string;
	score?: number;
	icon?: string | null;
};

export type LauncherExecuteResult = {
	ok: boolean;
	resultId: string;
	title?: string | null;
	modifier?: string | null;
};

// What main.cjs's `launcher:show` message carries: `firedAtMs` is a plain
// `Date.now()` wall-clock timestamp taken the instant the hotkey callback
// ran, in the MAIN process. The renderer is a separate OS process with its
// own `performance.now()` epoch, so wall-clock time is what makes the two
// sides comparable at all -- see LauncherWindowApp.tsx's header.
export type LauncherOpenMeta = {
	firedAtMs: number;
};

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

// WP-4.1: what a provider can do. Callers check these and degrade rather than
// assuming every provider behaves alike — which is also what lets a local
// model (D6) slot in later with a different set of answers.
export type AiCapabilities = {
	streaming: boolean;
	tools: boolean;
};

export type AiProviderPublic = {
	hasKey: boolean;
	model: string;
	label: string;
	capabilities: AiCapabilities;
};

/** One registered provider, as `ai:listProviders` describes it. Never a key. */
export type AiProviderDescription = {
	id: AiProvider;
	label: string;
	defaultModel: string;
	capabilities: AiCapabilities;
};

/** One tool offered to the model, in the canonical (provider-neutral) shape. */
export type AiToolSpec = {
	name: string;
	description?: string;
	/** A JSON Schema object describing the arguments. */
	parameters?: Record<string, unknown>;
};

/** A call the model asked for. `arguments` is always a parsed object. */
export type AiToolCall = {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** True when the model sent arguments that could not be parsed. */
	malformedArguments: boolean;
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
	/** WP-4.1: tools the model may call. Refused by a provider lacking `tools`. */
	tools?: AiToolSpec[];
	/**
	 * WP-4.3: also offer the tools of whichever MCP servers this environment
	 * has connected. Opt-in, so a caller that only wants prose is never
	 * reshaped by whatever happens to be connected.
	 */
	useTools?: boolean;
	/**
	 * WP-4.2: build this environment's context and prepend it to the system
	 * prompt. Omitted means no context at all — never "every environment".
	 */
	environmentId?: string;
	/** Set false to send the prompt with no context even when an id is given. */
	includeContext?: boolean;
	contextBudget?: Partial<AiContextBudget>;
};

// WP-4.2: what was actually assembled for one environment. Returned alongside
// every answer AND available on its own, built by the same function, so "what
// did you send" can always be answered exactly rather than approximately.
export type AiContextSection = {
	id: "memory" | "tasks" | "findings" | "notes" | "activity";
	title: string;
	lines: string[];
	includedCount: number;
	totalCount: number;
	/** True when items were dropped — by the per-section cap or the budget. */
	truncated: boolean;
};

export type AiContextBudget = {
	maxChars: number;
	maxItems: Record<AiContextSection["id"], number>;
	maxItemChars: number;
};

export type AiContext = {
	/** Exactly the text prepended to the system prompt. */
	text: string;
	sections: AiContextSection[];
	truncated: boolean;
	chars: number;
	environmentId: string | null;
	budget?: AiContextBudget;
};

// WP-4.3: MCP servers. A server belongs to exactly one environment (migration
// 016) — there is deliberately no way to express a global one, because a
// globally-reachable server would let an enclosed environment send its data out
// through a tool configured somewhere else entirely.
export type McpTransport = "stdio" | "http";

export type McpStdioConfig = {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string | null;
};

export type McpHttpConfig = {
	url: string;
	/**
	 * Non-secret headers only. Anything credential-shaped (Authorization,
	 * X-API-Key, Cookie, …) is routed to the encrypted vault instead and never
	 * appears here or in the database.
	 */
	headers: Record<string, string>;
};

export type McpServer = {
	id: string;
	environmentId: string;
	label: string;
	transport: McpTransport;
	config: Partial<McpStdioConfig & McpHttpConfig>;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
};

export type McpServerInput = {
	label?: string;
	transport?: McpTransport;
	config?: Partial<McpStdioConfig & McpHttpConfig>;
	enabled?: boolean;
};

export type McpConnectionState = "idle" | "connecting" | "ready" | "failed" | "closed";

export type McpServerStatus = {
	id: string;
	label: string;
	state: McpConnectionState;
	error: string | null;
	serverInfo: { name?: string; version?: string } | null;
	toolCount: number;
	pendingCount: number;
};

export type McpStatus = {
	environmentId: string | null;
	servers: McpServerStatus[];
};

/** One tool from one connected server. `name` is qualified `<serverId>__<tool>`. */
export type McpTool = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	serverId: string;
	rawName: string;
};

export type McpLogEntry = {
	stream: "stdout" | "stderr" | "http" | "lifecycle" | "protocol";
	line: string;
	at: number;
};

export type McpConnectResult = {
	connected: number;
	failures: Array<{ id: string; label: string; error: string }>;
	error?: string;
};

/** The outcome of one tool call the model asked for. */
export type AiToolResult = {
	id: string;
	name: string;
	/** False when the call could not be made at all. */
	ok: boolean;
	/** True when the call failed OR the tool itself reported a failure. */
	isError: boolean;
	text: string;
	error: string | null;
};

/** One durable fact the user taught the assistant, inside one environment. */
export type AiMemory = {
	id: string;
	environmentId: string;
	content: string;
	createdAt: string;
	updatedAt: string;
};

export type AiCompleteResult =
	| {
			ok: true;
			text: string;
			toolCalls: AiToolCall[];
			provider: AiProvider;
			model: string;
			/** WP-4.2: exactly the context that was sent, or null when none was. */
			context: AiContext | null;
			/**
			 * WP-4.3: the outcome of every tool call the model asked for. One
			 * round only — results are returned, not fed back for a second turn.
			 */
			toolResults: AiToolResult[];
	  }
	| { ok: false; error: string };

// WP-4.1: the same shape, plus whether it genuinely streamed. `streamed:false`
// means the provider lacks the capability and delivered its whole answer as a
// single chunk — a degrade, not a failure.
export type AiStreamResult =
	| {
			ok: true;
			text: string;
			toolCalls: AiToolCall[];
			provider: AiProvider;
			model: string;
			streamed: boolean;
			context: AiContext | null;
	  }
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

// ---------------------------------------------------------------------------
// File index (WP-2.5) -- mirrors electron/config/file-index-prefs.cjs's
// normalized shape and electron/services/file-index/crawler.cjs's status
// object exactly; the renderer never invents a shape of its own for either.
// ---------------------------------------------------------------------------

export type FileIndexRoot = {
	id: string;
	label: string;
	path: string;
	// null = global (no environment claims this root, every environment can
	// find files under it) -- see file-index-prefs.cjs's header.
	environmentId: string | null;
	enabled: boolean;
};

export type FileIndexPreferences = {
	roots: FileIndexRoot[];
	exclusions: string[];
	maxDepth: number;
	maxFiles: number;
};

export type FileIndexCrawlState = "idle" | "running" | "completed" | "cancelled" | "error";

export type FileIndexStatus = {
	state: FileIndexCrawlState;
	startedAt: number | null;
	finishedAt: number | null;
	filesScanned: number;
	dirsScanned: number;
	currentRoot: string | null;
	truncated: boolean;
	cancelled: boolean;
	error: string | null;
};

export type FileIndexRootStat = {
	root: string;
	count: number;
	lastSeenAt: number | null;
};

export type FileIndexStats = {
	totalFiles: number;
	perRoot: FileIndexRootStat[];
};

// ---------------------------------------------------------------------------
// File index watcher (WP-2.6) -- mirrors electron/services/file-index/
// watcher.cjs's own status object exactly, the same discipline
// FileIndexStatus above follows for the crawler.
// ---------------------------------------------------------------------------

export type FileIndexWatchState = "stopped" | "watching" | "error";

export type FileIndexWatchStatus = {
	state: FileIndexWatchState;
	startedAt: number | null;
	lastEventAt: number | null;
	lastFlushAt: number | null;
	pendingCount: number;
	rootsWatched: number;
	onBattery: boolean;
	error: string | null;
};

// WP-2.8: work-context adaptation. The three contexts the plan requires;
// `null` means "no sustained signal yet", which is deliberately distinct from
// any of them -- see electron/services/context-detection.cjs.
export type WorkContext = "coding" | "communication" | "browsing";

export type ContextStatus = {
	/** What detection has committed to, ignoring any pin. */
	context: WorkContext | null;
	/** What the app should actually act on: the pin if set, else `context`. */
	effectiveContext: WorkContext | null;
	pinnedContext: WorkContext | null;
	isPinned: boolean;
	/** A challenger that has not yet held the foreground long enough to win. */
	candidate: WorkContext | null;
	changedAt: number;
	/** Whether this service's own foreground poll is running. */
	polling: boolean;
	/**
	 * The Notch layout this context maps to (`context:coding`), or null when
	 * the user has configured none -- in which case the environment's own
	 * layout keeps applying.
	 */
	layoutId?: string | null;
};

// WP-3.5: suggestion surfacing. Mirrors electron/config/suggestion-prefs.cjs's
// own normalized shape -- the global "stop suggesting things" switch plus the
// plan's own two hard rate limits (at most one per session, a global cap per
// day), both kept configurable.
export type SuggestionPreferences = {
	enabled: boolean;
	maxPerSession: number;
	maxPerDay: number;
	/**
	 * WP-3.7: how many times in a row one category (a pattern type, in one
	 * environment) has to be dismissed before Atlas stops offering it.
	 */
	suppressAfterDismissals: number;
};

// WP-3.1/3.2: the Smart Function vocabulary, mirroring
// electron/services/smart-functions/model.cjs exactly. Kept as literal unions
// rather than `string` so the editor can only ever offer a type the engine
// actually understands -- adding one there and forgetting here is a type
// error, not a rule that silently never fires.
export type SmartFunctionTrigger =
	| { type: "manual" }
	| { type: "environment.switched"; environmentId: string | null }
	| { type: "session.started" }
	| { type: "session.stopped" }
	| { type: "app.launched"; processName: string | null }
	| { type: "time.of_day"; time: string }
	| { type: "display.connected" }
	| { type: "file.changed"; pattern: string | null; kind: "created" | "modified" | "removed" | null };

export type SmartFunctionCondition =
	| { type: "environment"; environmentId: string }
	| { type: "time_window"; start: string; end: string }
	| { type: "app_running"; processName: string };

export type SmartFunctionAction =
	| { type: "launchApp"; command: string }
	| { type: "openUrl"; url: string }
	| { type: "timer"; mode: "start" | "stop" }
	| { type: "switchEnvironment"; environmentId: string }
	| { type: "createTask"; title: string; column: string | null };

export type SmartFunction = {
	id: string;
	/** null means the rule applies whichever environment is active. */
	environmentId: string | null;
	label: string;
	enabled: boolean;
	trigger: SmartFunctionTrigger;
	conditions: SmartFunctionCondition[];
	actions: SmartFunctionAction[];
	source: "user" | "migrated-scene";
	migratedFrom: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	/**
	 * The plain-language preview, built in the main process from the same
	 * predicates the engine evaluates (describe.cjs). Never re-derived here --
	 * a second copy could drift from the behaviour it claims to describe.
	 */
	description: string;
};

/** What you send to create or update one; every field optional on update. */
export type SmartFunctionInput = {
	label?: string;
	environmentId?: string | null;
	enabled?: boolean;
	trigger?: SmartFunctionTrigger;
	conditions?: SmartFunctionCondition[];
	actions?: SmartFunctionAction[];
};

// WP-3.2's dry-run: what WOULD happen, computed through the engine's own
// decide() and then stopped before anything executes. `reason` is decide()'s
// own verdict ("matched", "disabled", "condition_failed", "rate_limited",
// "loop_prevented", "no_trigger_match"), so a "no" is always explainable.
export type SmartFunctionDryRun = {
	ok: boolean;
	error?: string;
	wouldFire?: boolean;
	reason?: string;
	description?: string;
	/** Each action in the same words the preview uses. */
	actions?: string[];
	context?: {
		currentEnvironmentId: string | null;
		foregroundProcessName: string | null;
		now: number;
	};
};

// WP-3.7's feedback loop, made inspectable: one row per category the user has
// given Atlas any answer about, in ONE environment. The counts are included
// deliberately -- "why has Atlas stopped offering this" should always have an
// answer the user can read, not just a boolean they have to trust.
export type SuggestionFeedbackCategory = {
	environmentId: string;
	patternType: string;
	shown: number;
	accepted: number;
	dismissed: number;
	/** Dismissals since the last accept -- the number the verdict is made on. */
	consecutiveDismissals: number;
	/** The `suppressAfterDismissals` this verdict was measured against. */
	threshold: number;
	suppressed: boolean;
	lastAcceptedAt: string | null;
	lastDismissedAt: string | null;
	/** When the user last reset this category, or null if they never have. */
	resetAt: string | null;
};

// What the Notch actually renders for a currently-surfaced suggestion --
// deliberately just enough to show and act on it (a plain-language
// description built server-side from the finding's trigger/follow event
// types), never the finding's raw evidence.
export type SurfacedSuggestion = {
	id: string;
	environmentId: string;
	patternType: string;
	description: string;
	confidence: number;
	occurrences: number;
	suggestedAt: string;
};

// The shape electron/services/pattern-miner/finding-lifecycle-service.cjs's
// acceptFinding()/ignoreFinding() resolve to (accessed here through the exact
// same findings:accept/findings:ignore channels WP-3.4 registered) -- the
// Notch only ever reads `ok`, so the rest stays loosely typed. WP-3.6's five
// further operations (convert/pause/unpause/setLabel/delete/move) all resolve
// to this same shape, with `reason` one of "not_found" | "invalid_transition"
// | "invalid_environment" | "isolation_blocked".
export type FindingActionResult = {
	ok: boolean;
	error?: string;
	reason?: string;
	[key: string]: unknown;
};

// WP-3.6: the full findings management surface. `FindingStatus` is exactly
// electron/services/pattern-miner/finding-lifecycle.cjs's STATES -- if a state
// is ever added there, this union is where the renderer finds out.
export type FindingStatus = "new" | "suggested" | "accepted" | "ignored" | "expired" | "paused";

// One mined finding, as rowToFinding (electron/services/pattern-miner/
// store.cjs) hands it back. Every field except `label` is a MINED FACT and is
// read-only everywhere in the renderer -- see migration 014's header for why
// letting the user hand-edit a statistic would mean letting them falsify the
// evidence this whole surface exists to present.
export type Finding = {
	id: string;
	environmentId: string;
	patternType: string;
	trigger: { type: string; subject: string | null };
	follow: { type: string; subject: string | null };
	windowMinutes: number;
	occurrences: number;
	trials: number;
	confidence: number;
	baselineProbability: number;
	lift: number;
	pValue: number;
	status: FindingStatus;
	createdAt: string;
	updatedAt: string;
	ignoreCount: number;
	suppressedUntil: string | null;
	suggestedAt: string | null;
	decidedAt: string | null;
	acceptedRuleId: string | null;
	/** The one user-editable field; null means "use the generated description". */
	label: string | null;
	/**
	 * Built in the main process (finding-translator.cjs#buildFindingRuleLabel,
	 * the same phrasing the Notch's suggestion uses) so the two surfaces can
	 * never describe one finding differently. A set `label` wins over it.
	 */
	description: string;
	/**
	 * Whether this pattern can become a smart function at all. False for shapes
	 * the engine has no trigger/action for yet -- accept and convert would both
	 * refuse, so the UI disables them and says why rather than offering a
	 * button that cannot work.
	 */
	convertible: boolean;
};

/** One `events` row, resolved from a `findings_evidence` id. */
export type FindingEvidenceEvent = {
	id: number;
	ts: string;
	environmentId: string | null;
	type: string;
	subject: string | null;
	payload: Record<string, unknown> | null;
	sessionId: string | null;
};

// The vision's "see the evidence behind a finding". `reason` distinguishes the
// three genuinely different empty cases electron/services/pattern-miner/
// finding-evidence.cjs separates, so the UI can word each one honestly rather
// than showing one vague "nothing here":
//   "purged_on_accept" -- accepted, so its evidence was deleted on purpose.
//   "no_evidence"      -- not accepted, yet has none (also what a moved
//                         finding shows: moving purges the trail).
//   "not_found"        -- no such finding.
export type FindingEvidence = {
	ok: boolean;
	error?: string;
	reason: "purged_on_accept" | "no_evidence" | "not_found" | null;
	pairs: Array<{ triggerEvent: FindingEvidenceEvent | null; followEvent: FindingEvidenceEvent | null }>;
};
