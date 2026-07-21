import type {
	ActivityBlock,
	AtlasView,
	DashboardOverview,
	NoteItem,
	Session,
	TaskColumn,
	TaskItem,
	TaskStatus,
	TaskUpdate,
} from "../../types";
import type { UseFocusReturn } from "../../hooks";

export type MainContentViewsProps = {
	view: AtlasView;
	dashboard: DashboardOverview;
	activeSession: Session | null;
	activeElapsed: string;
	currentAppName: string;
	selectedEnvironmentName: string;
	sessions: Session[];
	selectedSession: Session | null;
	onOpenSession: (sessionId: string) => void;
	onDeleteSession: (sessionId: string) => Promise<void>;
	filteredSessionStats?: { session: Session; clockMs: number; focusMs: number }[];
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
	onUpdateTask: (taskId: string, fields: TaskUpdate) => Promise<void>;
	onDeleteTask: (taskId: string) => Promise<void>;
	onRenameTaskColumn: (status: TaskStatus, label: string) => void;
	onReorderTaskColumns: (draggedStatus: TaskStatus, targetStatus: TaskStatus, position?: "before" | "after") => void;
	onAddTaskColumn: () => void;
	onRemoveTaskColumn: (status: TaskStatus) => Promise<void>;
	notebook: NoteItem | null;
	onUpdateNotebookByEnvironment: (content: string) => Promise<void>;
	theme: "dark" | "light" | "system";
	onThemeChange: (theme: "dark" | "light" | "system") => void;
	focus: UseFocusReturn;
};
