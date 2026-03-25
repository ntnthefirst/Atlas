import type {
	ActivityBlock,
	AtlasView,
	DashboardOverview,
	NoteItem,
	Session,
	TaskColumn,
	TaskItem,
	TaskStatus,
} from "../../types";

export type MainContentViewsProps = {
	view: AtlasView;
	dashboard: DashboardOverview;
	activeSession: Session | null;
	activeElapsed: string;
	currentAppName: string;
	selectedMapName: string;
	quickActions: Array<{ id: string; label: string; command: string }>;
	onLaunchQuickAction: (command: string) => void;
	sessions: Session[];
	selectedSession: Session | null;
	onOpenSession: (sessionId: string) => void;
	onDeleteSession: (sessionId: string) => Promise<void>;
	activityBlocks: ActivityBlock[];
	now: number;
	formatDuration: (ms: number) => string;
	formatClock: (ms: number) => string;
	sessionElapsedMs: (session: Session, now: number) => number;
	statusColumns: TaskColumn[];
	tasks: TaskItem[];
	dropStatus: TaskStatus | null;
	setDropStatus: (status: TaskStatus | null) => void;
	onDropInColumn: (status: TaskStatus) => Promise<void>;
	onDropOnTask: (task: TaskItem, position?: "before" | "after") => Promise<void>;
	setDraggedTaskId: (taskId: string) => void;
	onCreateTaskInColumn: (status: TaskStatus, title: string) => Promise<void>;
	onRenameTaskColumn: (status: TaskStatus, label: string) => void;
	onReorderTaskColumns: (draggedStatus: TaskStatus, targetStatus: TaskStatus, position?: "before" | "after") => void;
	onAddTaskColumn: () => void;
	onRemoveTaskColumn: (status: TaskStatus) => Promise<void>;
	notebook: NoteItem | null;
	onUpdateNotebookByMap: (content: string) => Promise<void>;
	theme: "dark" | "light" | "system";
	onThemeChange: (theme: "dark" | "light" | "system") => void;
	newActionLabel: string;
	newActionCommand: string;
	onNewActionLabelChange: (value: string) => void;
	onNewActionCommandChange: (value: string) => void;
	onAddQuickAction: () => void;
	onRemoveQuickAction: (id: string) => void;
};
