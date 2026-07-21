import { useEffect } from "react";
import type React from "react";
import type { Environment, Session, DashboardOverview, NoteItem, TaskItem, TaskColumn } from "../types";
import { TASK_ORDER_KEY, TASK_COLUMNS_KEY, defaultTaskColumns } from "../constants";
import { readStorage, normalizeTrackedAppName, normalizeColumns, sortTasksByOrder } from "../utils";

interface UseAppInitializationProps {
	setEnvironments: (environments: Environment[]) => void;
	setActiveSession: (session: Session | null) => void;
	setCurrentAppName: (name: string) => void;
	setSelectedEnvironmentId: (id: string) => void;
	setSelectedSessionId: (id: string) => void;
	setErrorMessage: (msg: string) => void;
	setHasBootstrapped: (v: boolean) => void;
	setShowFirstLaunch: (v: boolean) => void;
	setSessions: (sessions: Session[]) => void;
	setTasks: (tasks: TaskItem[]) => void;
	setNotebook: (notebook: NoteItem | null) => void;
	setDashboard: (dashboard: DashboardOverview) => void;
	setTaskColumnsByEnvironment: (v: Record<string, TaskColumn[]>) => void;
	setTaskOrderByEnvironment: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
}

export const useAppInitialization = ({
	setEnvironments,
	setActiveSession,
	setCurrentAppName,
	setSelectedEnvironmentId,
	setSelectedSessionId,
	setErrorMessage,
	setHasBootstrapped,
	setShowFirstLaunch,
	setSessions,
	setTasks,
	setNotebook,
	setDashboard,
	setTaskColumnsByEnvironment,
	setTaskOrderByEnvironment,
}: UseAppInitializationProps) => {
	useEffect(() => {
		const start = async () => {
			try {
				const persistedOrder = readStorage(TASK_ORDER_KEY, {} as Record<string, string[]>);
				const persistedColumns = readStorage(TASK_COLUMNS_KEY, {} as Record<string, TaskColumn[]>);
				setTaskColumnsByEnvironment(persistedColumns);

				const [environmentList, active, appName] = await Promise.all([
					window.atlas.listEnvironments(),
					window.atlas.getActiveSession(),
					window.atlas.getCurrentApp(),
				]);

				setEnvironments(environmentList);
				setActiveSession(active);
				setCurrentAppName(normalizeTrackedAppName(appName));

				if (!environmentList.length) {
					setShowFirstLaunch(true);
					return;
				}

				const preferredEnvironmentId = active?.environment_id ?? environmentList[0].id;
				setSelectedEnvironmentId(preferredEnvironmentId);

				const [nextSessions, nextTasks, nextNotebook, nextDashboard] = await Promise.all([
					window.atlas.listSessionsByEnvironment(preferredEnvironmentId),
					window.atlas.listTasksByEnvironment(preferredEnvironmentId),
					window.atlas.getNotebookByEnvironment(preferredEnvironmentId),
					window.atlas.getDashboardOverview(preferredEnvironmentId),
				]);

				setSessions(nextSessions);

				const existingOrder = persistedOrder[preferredEnvironmentId] ?? [];
				const existingSet = new Set(nextTasks.map((task) => task.id));
				const normalizedOrder = [
					...existingOrder.filter((id) => existingSet.has(id)),
					...nextTasks.map((task) => task.id).filter((id) => !existingOrder.includes(id)),
				];

				setTaskOrderByEnvironment((current) => ({
					...current,
					[preferredEnvironmentId]: normalizedOrder,
				}));

				const existing = normalizeColumns(
					persistedColumns[preferredEnvironmentId] ?? defaultTaskColumns,
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

				setTaskColumnsByEnvironment({ ...persistedColumns, [preferredEnvironmentId]: merged });
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
		setEnvironments,
		setActiveSession,
		setCurrentAppName,
		setSelectedEnvironmentId,
		setSelectedSessionId,
		setErrorMessage,
		setHasBootstrapped,
		setShowFirstLaunch,
		setSessions,
		setTasks,
		setNotebook,
		setDashboard,
		setTaskColumnsByEnvironment,
		setTaskOrderByEnvironment,
	]);
};
