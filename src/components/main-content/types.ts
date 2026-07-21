import type {
	ActivityBlock,
	AtlasView,
	DashboardOverview,
	Environment,
	IsolationAllowlistEntry,
	IsolationMode,
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
	// WP-1.2 (isolation enforcement UI): the currently selected environment's
	// full row (so its own isolation_mode is available without a second
	// lookup), the WP-0.8 allowlist described in plain language, and the one
	// callback that runs the warn-then-switch call path. `selectedEnvironment`
	// is nullable for the same reason `selectedEnvironmentName` falls back to
	// "None" at the call site: there can be a moment with no environment
	// selected at all (e.g. the very first environment being created).
	selectedEnvironment: Environment | null;
	isolationAllowlist: IsolationAllowlistEntry[];
	onChangeEnvironmentIsolationMode: (mode: IsolationMode) => void;
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
