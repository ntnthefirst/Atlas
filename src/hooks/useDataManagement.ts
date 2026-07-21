import { useState } from "react";
import type { Environment, Session, ActivityBlock, TaskItem, TaskColumn, DashboardOverview, NoteItem } from "../types";
import { TASK_ORDER_KEY, TASK_COLUMNS_KEY, defaultDashboard, defaultTaskColumns } from "../constants";
import { readStorage } from "../utils/storage";
import { normalizeColumns } from "../utils/taskHelpers";

export const useEnvironmentManagement = () => {
	const [environments, setEnvironments] = useState<Environment[]>([]);
	const [selectedEnvironmentId, setSelectedEnvironmentId] = useState("");

	const selectedEnvironment = environments.find((environmentItem) => environmentItem.id === selectedEnvironmentId) ?? null;

	return {
		environments,
		setEnvironments,
		selectedEnvironmentId,
		setSelectedEnvironmentId,
		selectedEnvironment,
	};
};

export const useSessionManagement = () => {
	const [activeSession, setActiveSession] = useState<Session | null>(null);
	const [sessions, setSessions] = useState<Session[]>([]);
	const [selectedSessionId, setSelectedSessionId] = useState<string>("");

	const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? activeSession;

	return {
		activeSession,
		setActiveSession,
		sessions,
		setSessions,
		selectedSessionId,
		setSelectedSessionId,
		selectedSession,
	};
};

export const useTaskManagement = (selectedEnvironmentId: string) => {
	const [tasks, setTasks] = useState<TaskItem[]>([]);
	const [taskOrderByEnvironment, setTaskOrderByEnvironment] = useState<Record<string, string[]>>(() =>
		readStorage(TASK_ORDER_KEY, {} as Record<string, string[]>),
	);
	const [taskColumnsByEnvironment, setTaskColumnsByEnvironment] = useState<Record<string, TaskColumn[]>>(() =>
		readStorage(TASK_COLUMNS_KEY, {} as Record<string, TaskColumn[]>),
	);
	const [draggedTaskId, setDraggedTaskId] = useState<string>("");
	const [dropStatus, setDropStatus] = useState<string | null>(null);

	const statusColumns = selectedEnvironmentId
		? normalizeColumns(taskColumnsByEnvironment[selectedEnvironmentId] ?? defaultTaskColumns, defaultTaskColumns)
		: defaultTaskColumns;

	return {
		tasks,
		setTasks,
		taskOrderByEnvironment,
		setTaskOrderByEnvironment,
		taskColumnsByEnvironment,
		setTaskColumnsByEnvironment,
		draggedTaskId,
		setDraggedTaskId,
		dropStatus,
		setDropStatus,
		statusColumns,
	};
};

export const useNotebookManagement = () => {
	const [notebook, setNotebook] = useState<NoteItem | null>(null);
	return { notebook, setNotebook };
};

export const useDashboardManagement = () => {
	const [dashboard, setDashboard] = useState<DashboardOverview>(defaultDashboard);
	return { dashboard, setDashboard };
};

export const useActivityManagement = () => {
	const [activityBlocks, setActivityBlocks] = useState<ActivityBlock[]>([]);
	return { activityBlocks, setActivityBlocks };
};
