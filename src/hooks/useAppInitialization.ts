import { useEffect } from "react";
import type React from "react";
import type { MapItem, Session, DashboardOverview, NoteItem, TaskItem, TaskColumn } from "../types";
import { TASK_ORDER_KEY, TASK_COLUMNS_KEY, defaultTaskColumns } from "../constants";
import { readStorage, normalizeTrackedAppName, normalizeColumns, sortTasksByOrder } from "../utils";

interface UseAppInitializationProps {
	setMaps: (maps: MapItem[]) => void;
	setActiveSession: (session: Session | null) => void;
	setCurrentAppName: (name: string) => void;
	setSelectedMapId: (id: string) => void;
	setSelectedSessionId: (id: string) => void;
	setErrorMessage: (msg: string) => void;
	setHasBootstrapped: (v: boolean) => void;
	setShowFirstLaunch: (v: boolean) => void;
	setSessions: (sessions: Session[]) => void;
	setTasks: (tasks: TaskItem[]) => void;
	setNotebook: (notebook: NoteItem | null) => void;
	setDashboard: (dashboard: DashboardOverview) => void;
	setTaskColumnsByMap: (v: Record<string, TaskColumn[]>) => void;
	setTaskOrderByMap: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
}

export const useAppInitialization = ({
	setMaps,
	setActiveSession,
	setCurrentAppName,
	setSelectedMapId,
	setSelectedSessionId,
	setErrorMessage,
	setHasBootstrapped,
	setShowFirstLaunch,
	setSessions,
	setTasks,
	setNotebook,
	setDashboard,
	setTaskColumnsByMap,
	setTaskOrderByMap,
}: UseAppInitializationProps) => {
	useEffect(() => {
		const start = async () => {
			try {
				const persistedOrder = readStorage(TASK_ORDER_KEY, {} as Record<string, string[]>);
				const persistedColumns = readStorage(TASK_COLUMNS_KEY, {} as Record<string, TaskColumn[]>);
				setTaskColumnsByMap(persistedColumns);

				const [mapList, active, appName] = await Promise.all([
					window.atlas.listMaps(),
					window.atlas.getActiveSession(),
					window.atlas.getCurrentApp(),
				]);

				setMaps(mapList);
				setActiveSession(active);
				setCurrentAppName(normalizeTrackedAppName(appName));

				if (!mapList.length) {
					setShowFirstLaunch(true);
					return;
				}

				const preferredMapId = active?.map_id ?? mapList[0].id;
				setSelectedMapId(preferredMapId);

				const [nextSessions, nextTasks, nextNotebook, nextDashboard] = await Promise.all([
					window.atlas.listSessionsByMap(preferredMapId),
					window.atlas.listTasksByMap(preferredMapId),
					window.atlas.getNotebookByMap(preferredMapId),
					window.atlas.getDashboardOverview(preferredMapId),
				]);

				setSessions(nextSessions);

				const existingOrder = persistedOrder[preferredMapId] ?? [];
				const existingSet = new Set(nextTasks.map((task) => task.id));
				const normalizedOrder = [
					...existingOrder.filter((id) => existingSet.has(id)),
					...nextTasks.map((task) => task.id).filter((id) => !existingOrder.includes(id)),
				];

				setTaskOrderByMap((current) => ({
					...current,
					[preferredMapId]: normalizedOrder,
				}));

				const existing = normalizeColumns(
					persistedColumns[preferredMapId] ?? defaultTaskColumns,
					defaultTaskColumns,
				);
				const knownStatuses = new Set(existing.map((column) => column.status));
				const missingStatuses = nextTasks
					.map((task) => task.status)
					.filter((status, index, all) => all.indexOf(status) === index)
					.filter((status) => !knownStatuses.has(status));

				const merged = normalizeColumns(
					[...existing, ...missingStatuses.map((status) => ({ status, label: status }))],
					defaultTaskColumns,
				);

				setTaskColumnsByMap({ ...persistedColumns, [preferredMapId]: merged });
				setTasks(sortTasksByOrder(nextTasks, normalizedOrder));
				setNotebook(nextNotebook);
				setDashboard(nextDashboard);

				if (nextSessions.length) {
					setSelectedSessionId(nextSessions[0].id);
				}

				if (active) {
					setSelectedSessionId(active.id);
				}
			} catch (error) {
				setErrorMessage(error instanceof Error ? error.message : "Failed to initialize Atlas.");
			} finally {
				setHasBootstrapped(true);
			}
		};

		start().catch(console.error);
	}, [
		setMaps,
		setActiveSession,
		setCurrentAppName,
		setSelectedMapId,
		setSelectedSessionId,
		setErrorMessage,
		setHasBootstrapped,
		setShowFirstLaunch,
		setSessions,
		setTasks,
		setNotebook,
		setDashboard,
		setTaskColumnsByMap,
		setTaskOrderByMap,
	]);
};
