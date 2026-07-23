/// <reference types="vite/client" />

import type {
	ActivityBlock,
	AiCompleteArgs,
	AiCompleteResult,
	AiContext,
	AiContextBudget,
	AiMemory,
	AiProviderDescription,
	AiStreamResult,
	AiConfigPatch,
	AiPublicConfig,
	AppRelease,
	AtlasView,
	DashboardPreferences,
	DisplaySummary,
	DownloadAndInstallResult,
	DashboardOverview,
	FileIndexPreferences,
	FileIndexStats,
	FileIndexStatus,
	FileIndexWatchStatus,
	ContextStatus,
	WorkContext,
	FocusConfig,
	FocusState,
	Environment,
	EnvironmentActivatedBundle,
	EnvironmentConfig,
	EnvironmentContentCounts,
	EnvironmentConfigPatch,
	EnvironmentHotkeyBinding,
	EnvironmentHotkeySetResult,
	IsolationAllowlistEntry,
	IsolationMode,
	LauncherExecuteResult,
	LauncherHotkeyBinding,
	LauncherHotkeySetResult,
	LauncherOpenMeta,
	LauncherResult,
	NoteItem,
	NotchInputPayload,
	NotchLayoutResolution,
	NotchPreferences,
	SmartFunction,
	SmartFunctionDryRun,
	SmartFunctionInput,
	SuggestionPreferences,
	SuggestionFeedbackCategory,
	SurfacedSuggestion,
	Finding,
	FindingActionResult,
	FindingEvidence,
	Session,
	TaskItem,
	TaskStatus,
	TaskUpdate,
	UpdatePreferences,
	UpdateCheckResult,
} from "./types";

declare global {
	interface Window {
		atlas: {
			checkForUpdates: (options?: { includePrerelease?: boolean }) => Promise<UpdateCheckResult>;
			getAppVersion: () => Promise<string>;
			listReleaseHistory: (options?: { includePrerelease?: boolean }) => Promise<{
				releases: AppRelease[];
				error?: string;
			}>;
			getUpdatePreferences: () => Promise<UpdatePreferences>;
			setUpdatePreferences: (preferences: UpdatePreferences) => Promise<UpdatePreferences>;
			downloadAndInstallUpdate: (options?: {
				includePrerelease?: boolean;
			}) => Promise<DownloadAndInstallResult>;
			listEnvironments: () => Promise<Environment[]>;
			createEnvironment: (
				name: string,
				options?: { icon?: string | null; accent?: string | null; preset?: string | null },
			) => Promise<Environment>;
			renameEnvironment: (environmentId: string, name: string) => Promise<Environment>;
			updateEnvironment: (
				environmentId: string,
				fields: Partial<Pick<Environment, "name" | "icon" | "accent" | "preset">>,
			) => Promise<Environment>;
			deleteEnvironment: (environmentId: string) => Promise<boolean>;
			// WP-1.5: full lifecycle beyond create/rename/update/delete above.
			archiveEnvironment: (environmentId: string) => Promise<Environment>;
			unarchiveEnvironment: (environmentId: string) => Promise<Environment>;
			listArchivedEnvironments: () => Promise<Environment[]>;
			getEnvironmentContentCounts: (environmentId: string) => Promise<EnvironmentContentCounts>;
			duplicateEnvironment: (environmentId: string, name?: string) => Promise<Environment>;
			notifyEnvironmentSwitch: (environmentId: string) => Promise<boolean>;
			onEnvironmentActivated: (callback: (bundle: EnvironmentActivatedBundle) => void) => () => void;
			onOpenEnvironmentSwitcher: (callback: () => void) => () => void;
			getEnvironmentConfig: (environmentId: string) => Promise<EnvironmentConfig | null>;
			setEnvironmentConfig: (environmentId: string, patch: EnvironmentConfigPatch) => Promise<EnvironmentConfig>;
			setEnvironmentIsolationMode: (environmentId: string, mode: IsolationMode) => Promise<Environment>;
			getIsolationAllowlist: () => Promise<IsolationAllowlistEntry[]>;

			getActiveSession: () => Promise<Session | null>;
			startSession: (environmentId: string) => Promise<Session>;
			pauseSession: (sessionId: string) => Promise<Session>;
			resumeSession: (sessionId: string) => Promise<Session>;
			stopSession: (sessionId: string) => Promise<Session>;
			deleteSession: (sessionId: string) => Promise<boolean>;
			listSessionsByEnvironment: (environmentId: string) => Promise<Session[]>;

			listActivityBySession: (sessionId: string) => Promise<ActivityBlock[]>;
			getCurrentApp: () => Promise<string>;

			listTasksByEnvironment: (environmentId: string) => Promise<TaskItem[]>;
			createTask: (
				environmentId: string,
				title: string,
				description?: string,
				fields?: TaskUpdate,
			) => Promise<TaskItem>;
			updateTaskStatus: (taskId: string, status: TaskStatus) => Promise<TaskItem>;
			updateTask: (taskId: string, fields: TaskUpdate) => Promise<TaskItem>;
			deleteTask: (taskId: string) => Promise<boolean>;

			listNotesByEnvironment: (environmentId: string) => Promise<NoteItem[]>;
			createNote: (environmentId: string, content?: string) => Promise<NoteItem>;
			updateNote: (noteId: string, content: string) => Promise<NoteItem>;
			deleteNote: (noteId: string) => Promise<boolean>;
			getNotebookByEnvironment: (environmentId: string) => Promise<NoteItem>;
			updateNotebookByEnvironment: (environmentId: string, content: string) => Promise<NoteItem>;

			getDashboardOverview: (environmentId: string) => Promise<DashboardOverview>;

			launchApp: (command: string) => Promise<boolean>;
			getPlatform: () => Promise<string>;
			setNativeTheme: (theme: "dark" | "light" | "system") => Promise<boolean>;
			setAccent: (value: string) => Promise<boolean>;
			onAccentChanged: (callback: (value: string) => void) => () => void;
			getEnvironmentHotkey: () => Promise<EnvironmentHotkeyBinding>;
			setEnvironmentHotkey: (accelerator: string) => Promise<EnvironmentHotkeySetResult>;
			getLauncherHotkey: () => Promise<LauncherHotkeyBinding>;
			setLauncherHotkey: (accelerator: string) => Promise<LauncherHotkeySetResult>;
			queryLauncher: (query: string) => Promise<LauncherResult[]>;
			executeLauncherResult: (resultId: string, modifier?: string | null) => Promise<LauncherExecuteResult>;
			hideLauncherWindow: () => Promise<boolean>;
			reportLauncherOpenLatency: (latencyMs: number) => Promise<boolean>;
			onLauncherShow: (callback: (meta: LauncherOpenMeta) => void) => () => void;

			getNotchPreferences: () => Promise<NotchPreferences>;
			setNotchPreferences: (preferences: Partial<NotchPreferences>) => Promise<NotchPreferences>;
			getNotchLayoutForEnvironment: (environmentId: string) => Promise<NotchLayoutResolution>;
			setDefaultNotchLayout: (patch: Partial<NotchPreferences>) => Promise<NotchLayoutResolution>;
			setEnvironmentNotchLayout: (
				environmentId: string,
				patch: Partial<NotchPreferences>,
			) => Promise<NotchLayoutResolution>;
			clearEnvironmentNotchLayout: (environmentId: string) => Promise<NotchLayoutResolution>;
			getDashboardLayout: () => Promise<DashboardPreferences>;
			setDashboardLayout: (preferences: Partial<DashboardPreferences>) => Promise<DashboardPreferences>;
			onDashboardLayoutChanged: (callback: (preferences: DashboardPreferences) => void) => () => void;
			getFocusState: () => Promise<FocusState>;
			startFocus: (goal?: string) => Promise<FocusState>;
			pauseFocus: () => Promise<FocusState>;
			resumeFocus: () => Promise<FocusState>;
			skipFocusPhase: () => Promise<FocusState>;
			stopFocus: () => Promise<FocusState>;
			setFocusGoal: (goal: string) => Promise<FocusState>;
			setFocusConfig: (patch: Partial<FocusConfig>) => Promise<FocusState>;
			onFocusStateChanged: (callback: (state: FocusState) => void) => () => void;

			resizeNotch: (width: number, height: number) => Promise<boolean>;
			setNotchIgnoreMouse: (ignore: boolean) => Promise<boolean>;
			onNotchPreferencesChanged: (callback: (preferences: NotchPreferences) => void) => () => void;
			onNotchBlur: (callback: () => void) => () => void;
			listDisplays: () => Promise<DisplaySummary[]>;

			windowMinimize: () => Promise<boolean>;
			openMiniWindow: () => Promise<boolean>;
			openSettingsWindow: () => Promise<boolean>;
			openActionEditorWindow: () => Promise<boolean>;
			openNotchInputWindow: (payload: NotchInputPayload) => Promise<boolean>;
			getNotchInputPayload: () => Promise<NotchInputPayload>;
			onNotchInputPayload: (callback: (payload: NotchInputPayload) => void) => () => void;
			getAiConfig: () => Promise<AiPublicConfig>;
			setAiConfig: (patch: AiConfigPatch) => Promise<AiPublicConfig>;
			aiComplete: (args: AiCompleteArgs) => Promise<AiCompleteResult>;
			// WP-4.1: provider capabilities, and streaming.
			listAiProviders: () => Promise<AiProviderDescription[]>;
			// WP-4.2: context inspection and per-environment memory.
			getAiContext: (environmentId: string, budget?: Partial<AiContextBudget>) => Promise<AiContext>;
			listAiMemories: (environmentId: string) => Promise<AiMemory[]>;
			addAiMemory: (environmentId: string, content: string) => Promise<AiMemory | null>;
			updateAiMemory: (environmentId: string, id: string, content: string) => Promise<AiMemory | null>;
			deleteAiMemory: (environmentId: string, id: string) => Promise<boolean>;
			aiStream: (args: AiCompleteArgs, onChunk: (chunk: string) => void) => Promise<AiStreamResult>;

			pickAppFile: () => Promise<string | null>;
			getFileIcon: (filePath: string) => Promise<string | null>;
			listOpenApps: () => Promise<Array<{ name: string; path: string | null }>>;
			getSystemStats: () => Promise<{ cpuPercent: number; memoryPercent: number }>;
			resizeMiniWindow: (width: number, height: number) => Promise<boolean>;
			showMainWindow: () => Promise<boolean>;
			focusMainIfOpen: () => Promise<boolean>;
			requestNavigate: (view: AtlasView) => Promise<boolean>;
			onNavigate: (callback: (view: AtlasView) => void) => () => void;
			closeMiniWindow: () => Promise<boolean>;
			windowToggleMaximize: () => Promise<boolean>;
			windowClose: () => Promise<boolean>;

			getFileIndexPreferences: () => Promise<FileIndexPreferences>;
			setFileIndexPreferences: (patch: Partial<FileIndexPreferences>) => Promise<FileIndexPreferences>;
			startFileIndexCrawl: () => Promise<FileIndexStatus>;
			cancelFileIndexCrawl: () => Promise<FileIndexStatus>;
			getFileIndexStatus: () => Promise<FileIndexStatus>;
			getFileIndexStats: () => Promise<FileIndexStats>;
			pickFileIndexFolder: () => Promise<string | null>;
			onFileIndexProgress: (callback: (status: FileIndexStatus) => void) => () => void;
			startFileIndexWatch: () => Promise<FileIndexWatchStatus>;
			stopFileIndexWatch: () => Promise<FileIndexWatchStatus>;
			getFileIndexWatchStatus: () => Promise<FileIndexWatchStatus>;
			onFileIndexWatchStatus: (callback: (status: FileIndexWatchStatus) => void) => () => void;

			// WP-2.8: work-context adaptation.
			getContextStatus: () => Promise<ContextStatus>;
			pinContext: (context: WorkContext) => Promise<ContextStatus>;
			unpinContext: () => Promise<ContextStatus>;
			startContextDetection: () => Promise<ContextStatus>;
			stopContextDetection: () => Promise<ContextStatus>;
			onContextChanged: (callback: (status: ContextStatus) => void) => () => void;

			// WP-3.5: suggestion surfacing. Accept/dismiss reuse the exact same
			// findings:accept/findings:ignore channels WP-3.4 registered -- see
			// electron/ipc/findings.cjs and electron/preload.cjs.
			getSuggestionPreferences: () => Promise<SuggestionPreferences>;
			setSuggestionPreferences: (patch: Partial<SuggestionPreferences>) => Promise<SuggestionPreferences>;
			getCurrentSuggestion: (environmentId: string) => Promise<SurfacedSuggestion | null>;
			// WP-3.7: the feedback loop, inspectable and resettable.
			getSuggestionFeedback: (environmentId: string) => Promise<SuggestionFeedbackCategory[]>;
			resetSuggestionFeedback: (
				environmentId: string,
				patternType?: string | null,
			) => Promise<SuggestionFeedbackCategory[]>;
			acceptFinding: (findingId: string) => Promise<FindingActionResult>;
			dismissFinding: (findingId: string) => Promise<FindingActionResult>;

			// WP-3.6: findings management. Accept/reject are the two lines above,
			// deliberately not re-declared here -- the management panel calls the
			// same ones the Notch does.
			listFindings: (environmentId: string) => Promise<Finding[]>;
			getFindingEvidence: (findingId: string) => Promise<FindingEvidence>;
			convertFinding: (findingId: string) => Promise<FindingActionResult>;
			pauseFinding: (findingId: string) => Promise<FindingActionResult>;
			unpauseFinding: (findingId: string) => Promise<FindingActionResult>;
			setFindingLabel: (findingId: string, label: string | null) => Promise<FindingActionResult>;
			deleteFinding: (findingId: string) => Promise<FindingActionResult>;
			moveFinding: (findingId: string, environmentId: string) => Promise<FindingActionResult>;

			// WP-3.2: the Smart Function editor. Passing no environment id lists
			// every rule; passing one lists that environment's rules plus the
			// global ones, exactly as the engine scopes them.
			listSmartFunctions: (environmentId?: string | null) => Promise<SmartFunction[]>;
			getSmartFunction: (id: string) => Promise<SmartFunction | null>;
			createSmartFunction: (input: SmartFunctionInput) => Promise<SmartFunction>;
			updateSmartFunction: (id: string, patch: SmartFunctionInput) => Promise<SmartFunction>;
			duplicateSmartFunction: (id: string) => Promise<SmartFunction>;
			setSmartFunctionEnabled: (id: string, enabled: boolean) => Promise<SmartFunction>;
			deleteSmartFunction: (id: string) => Promise<boolean>;
			runSmartFunction: (id: string) => Promise<{ ok: boolean; error?: string; summary?: unknown }>;
			dryRunSmartFunction: (id: string) => Promise<SmartFunctionDryRun>;
			runNotchScene: (
				placementId: string,
				environmentId: string | null,
			) => Promise<{ ok: boolean; error?: string; reason?: string }>;
		};
	}
}

export {};
