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
	MapItem,
	NoteItem,
	NotchInputPayload,
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
			listMaps: () => Promise<MapItem[]>;
			createMap: (
				name: string,
				options?: { icon?: string | null; accent?: string | null; preset?: string | null },
			) => Promise<MapItem>;
			renameMap: (mapId: string, name: string) => Promise<MapItem>;
			updateMap: (
				mapId: string,
				fields: Partial<Pick<MapItem, "name" | "icon" | "accent" | "preset">>,
			) => Promise<MapItem>;
			deleteMap: (mapId: string) => Promise<boolean>;

			getActiveSession: () => Promise<Session | null>;
			startSession: (mapId: string) => Promise<Session>;
			pauseSession: (sessionId: string) => Promise<Session>;
			resumeSession: (sessionId: string) => Promise<Session>;
			stopSession: (sessionId: string) => Promise<Session>;
			deleteSession: (sessionId: string) => Promise<boolean>;
			listSessionsByMap: (mapId: string) => Promise<Session[]>;

			listActivityBySession: (sessionId: string) => Promise<ActivityBlock[]>;
			getCurrentApp: () => Promise<string>;

			listTasksByMap: (mapId: string) => Promise<TaskItem[]>;
			createTask: (
				mapId: string,
				title: string,
				description?: string,
				fields?: TaskUpdate,
			) => Promise<TaskItem>;
			updateTaskStatus: (taskId: string, status: TaskStatus) => Promise<TaskItem>;
			updateTask: (taskId: string, fields: TaskUpdate) => Promise<TaskItem>;
			deleteTask: (taskId: string) => Promise<boolean>;

			listNotesByMap: (mapId: string) => Promise<NoteItem[]>;
			createNote: (mapId: string, content?: string) => Promise<NoteItem>;
			updateNote: (noteId: string, content: string) => Promise<NoteItem>;
			deleteNote: (noteId: string) => Promise<boolean>;
			getNotebookByMap: (mapId: string) => Promise<NoteItem>;
			updateNotebookByMap: (mapId: string, content: string) => Promise<NoteItem>;

			getDashboardOverview: (mapId: string) => Promise<DashboardOverview>;

			launchApp: (command: string) => Promise<boolean>;
			getPlatform: () => Promise<string>;
			setNativeTheme: (theme: "dark" | "light" | "system") => Promise<boolean>;
			setAccent: (value: string) => Promise<boolean>;
			onAccentChanged: (callback: (value: string) => void) => () => void;

			getNotchPreferences: () => Promise<NotchPreferences>;
			setNotchPreferences: (preferences: Partial<NotchPreferences>) => Promise<NotchPreferences>;
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
