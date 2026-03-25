import { useState } from "react";
import type { MapItem, Session, ActivityBlock, TaskItem, TaskColumn, DashboardOverview, NoteItem } from "../types";
import { TASK_ORDER_KEY, TASK_COLUMNS_KEY, defaultDashboard, defaultTaskColumns } from "../constants";
import { readStorage } from "../utils/storage";
import { normalizeColumns } from "../utils/taskHelpers";

export const useMapManagement = () => {
	const [maps, setMaps] = useState<MapItem[]>([]);
	const [selectedMapId, setSelectedMapId] = useState("");

	const selectedMap = maps.find((mapItem) => mapItem.id === selectedMapId) ?? null;

	return {
		maps,
		setMaps,
		selectedMapId,
		setSelectedMapId,
		selectedMap,
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

export const useTaskManagement = (selectedMapId: string) => {
	const [tasks, setTasks] = useState<TaskItem[]>([]);
	const [taskOrderByMap, setTaskOrderByMap] = useState<Record<string, string[]>>(() =>
		readStorage(TASK_ORDER_KEY, {} as Record<string, string[]>),
	);
	const [taskColumnsByMap, setTaskColumnsByMap] = useState<Record<string, TaskColumn[]>>(() =>
		readStorage(TASK_COLUMNS_KEY, {} as Record<string, TaskColumn[]>),
	);
	const [draggedTaskId, setDraggedTaskId] = useState<string>("");
	const [dropStatus, setDropStatus] = useState<string | null>(null);

	const statusColumns = selectedMapId
		? normalizeColumns(taskColumnsByMap[selectedMapId] ?? defaultTaskColumns, defaultTaskColumns)
		: defaultTaskColumns;

	return {
		tasks,
		setTasks,
		taskOrderByMap,
		setTaskOrderByMap,
		taskColumnsByMap,
		setTaskColumnsByMap,
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
