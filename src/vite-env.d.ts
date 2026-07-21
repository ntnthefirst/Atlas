/// <reference types="vite/client" />

import type {
	ActivityBlock,
	AiCompleteArgs,
	AiCompleteResult,
	AiConfigPatch,
	AiPublicConfig,
	AppRelease,
	AtlasView,
	DashboardPreferences,
	DisplaySummary,
	DownloadAndInstallResult,
	DashboardOverview,
	FocusConfig,
	FocusState,
	Environment,
	EnvironmentActivatedBundle,
	EnvironmentConfig,
	EnvironmentConfigPatch,
	EnvironmentHotkeyBinding,
	EnvironmentHotkeySetResult,
	IsolationAllowlistEntry,
	IsolationMode,
	NoteItem,
	NotchInputPayload,
	NotchLayoutResolution,
	NotchPreferences,
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
		};
	}
}

export {};
