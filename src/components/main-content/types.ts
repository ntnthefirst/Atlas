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
import type { EnvironmentPresetTemplate } from "../../environments";

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
	// WP-1.5 (environment management surface, Settings): the full visible
	// list (never archived -- that's fetched separately, inside
	// EnvironmentManagementCard itself) plus the create/edit/duplicate/
	// archive/delete callbacks that card renders. Threaded through here
	// rather than as bespoke SettingsView-only props for the same reason
	// `isolationAllowlist` above already is -- one big props object every
	// main-content view receives, so Settings isn't a special case.
	environments: Environment[];
	newEnvironmentName: string;
	onNewEnvironmentNameChange: (value: string) => void;
	onCreateEnvironment: () => Promise<void>;
	onCreatePresetEnvironment: (preset: EnvironmentPresetTemplate) => Promise<void>;
	onUpdateEnvironmentById: (
		environmentId: string,
		fields: Partial<Pick<Environment, "name" | "icon" | "accent" | "preset">>,
	) => Promise<void>;
	onDuplicateEnvironmentById: (environmentId: string) => Promise<void>;
	onArchiveEnvironmentById: (environmentId: string) => Promise<void>;
	onUnarchiveEnvironmentById: (environmentId: string) => Promise<void>;
	onRequestDeleteEnvironmentRow: (environment: Environment) => void;
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
