/// <reference types="vite/client" />

import type {
	ActivityBlock,
	AppRelease,
	DownloadAndInstallResult,
	DashboardOverview,
	MapItem,
	NoteItem,
	Session,
	TaskItem,
	TaskStatus,
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
			downloadAndInstallUpdate: (options?: { includePrerelease?: boolean }) => Promise<DownloadAndInstallResult>;
			listMaps: () => Promise<MapItem[]>;
			createMap: (name: string) => Promise<MapItem>;
			renameMap: (mapId: string, name: string) => Promise<MapItem>;
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
			createTask: (mapId: string, title: string, description?: string) => Promise<TaskItem>;
			updateTaskStatus: (taskId: string, status: TaskStatus) => Promise<TaskItem>;

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

			windowMinimize: () => Promise<boolean>;
			openMiniWindow: () => Promise<boolean>;
			openSettingsWindow: () => Promise<boolean>;
			resizeMiniWindow: (width: number, height: number) => Promise<boolean>;
			showMainWindow: () => Promise<boolean>;
			closeMiniWindow: () => Promise<boolean>;
			windowToggleMaximize: () => Promise<boolean>;
			windowClose: () => Promise<boolean>;
		};
	}
}

export {};
