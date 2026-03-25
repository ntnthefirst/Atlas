import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MinusIcon, XMarkIcon, PauseIcon, PlayIcon, StopIcon } from "@heroicons/react/24/outline";
import type { AtlasView, TaskStatus, TaskItem, TaskColumn } from "./types";
import { AtlasHeader } from "./components/AtlasHeader";
import { AtlasSidebar } from "./components/AtlasSidebar";
import { AtlasMainContent } from "./components/AtlasMainContent";
import { MainContentViews } from "./components/main-content";
import { SettingsWindowApp } from "./components/settings-window/SettingsWindowApp";
import logo from "./assets/logosmall.png";
import {
	useMapManagement,
	useSessionManagement,
	useTaskManagement,
	useNotebookManagement,
	useDashboardManagement,
	useActivityManagement,
	useThemeManagement,
	useQuickActionsManagement,
	useMapMenuManagement,
	useErrorManagement,
	useTimeManagement,
	usePlatformManagement,
	useBootstrapState,
	useCurrentAppTracker,
} from "./hooks";
import {
	formatClock,
	formatDuration,
	normalizeTrackedAppName,
	reorderTaskIds,
	sortTasksByOrder,
	normalizeColumns,
	sessionElapsedMs,
	readStorage,
} from "./utils";
import { TASK_ORDER_KEY, TASK_COLUMNS_KEY, defaultDashboard, defaultTaskColumns, viewItems } from "./constants";

function MainAtlasApp() {
	const isMiniMode = useMemo(() => new URLSearchParams(window.location.search).get("mode") === "mini", []);
	const isWelcomeMode = useMemo(() => new URLSearchParams(window.location.search).get("mode") === "welcome", []);
	const [view, setView] = useState<AtlasView>("dashboard");

	const { maps, setMaps, selectedMapId, setSelectedMapId, selectedMap } = useMapManagement();
	const {
		activeSession,
		setActiveSession,
		sessions,
		setSessions,
		selectedSessionId,
		setSelectedSessionId,
		selectedSession,
	} = useSessionManagement();
	const {
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
	} = useTaskManagement(selectedMapId);
	const { notebook, setNotebook } = useNotebookManagement();
	const { dashboard, setDashboard } = useDashboardManagement();
	const { activityBlocks, setActivityBlocks } = useActivityManagement();
	const { theme, setTheme } = useThemeManagement();
	const { quickActions, setQuickActions, newActionLabel, setNewActionLabel, newActionCommand, setNewActionCommand } =
		useQuickActionsManagement();
	const {
		showMapMenu,
		setShowMapMenu,
		renameMapName,
		setRenameMapName,
		newMapName,
		setNewMapName,
		showFirstLaunch,
		setShowFirstLaunch,
	} = useMapMenuManagement();
	const { errorMessage, setErrorMessage } = useErrorManagement();
	const { now, setNow } = useTimeManagement();
	const { platform, setPlatform } = usePlatformManagement();
	const { hasBootstrapped, setHasBootstrapped } = useBootstrapState();
	const { currentAppName, setCurrentAppName } = useCurrentAppTracker();

	const miniControlsRef = useRef<HTMLDivElement | null>(null);
	const previousActiveSessionIdRef = useRef<string | null>(null);

	// Mini mode styling
	useEffect(() => {
		if (!isMiniMode) return;
		const html = document.documentElement;
		const body = document.body;
		const root = document.getElementById("root");
		html.dataset.miniMode = "true";
		html.style.background = "transparent";
		body.style.background = "transparent";
		if (root) root.style.background = "transparent";
		return () => {
			delete html.dataset.miniMode;
			html.style.background = "";
			body.style.background = "";
			if (root) root.style.background = "";
		};
	}, [isMiniMode]);

	// Mini window resize
	useEffect(() => {
		if (!isMiniMode) return;
		const controlNode = miniControlsRef.current;
		if (!controlNode) return;
		const resizeMiniToContent = () => {
			const bounds = controlNode.getBoundingClientRect();
			void window.atlas.resizeMiniWindow(Math.ceil(bounds.width + 8), Math.ceil(bounds.height + 8));
		};
		resizeMiniToContent();
		const observer = new ResizeObserver(() => resizeMiniToContent());
		observer.observe(controlNode);
		window.addEventListener("resize", resizeMiniToContent);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", resizeMiniToContent);
		};
	}, [isMiniMode, activeSession?.is_paused]);

	// Store persistent state
	useEffect(() => {
		localStorage.setItem(TASK_ORDER_KEY, JSON.stringify(taskOrderByMap));
	}, [taskOrderByMap]);

	useEffect(() => {
		localStorage.setItem(TASK_COLUMNS_KEY, JSON.stringify(taskColumnsByMap));
	}, [taskColumnsByMap]);

	// Platform detection
	useEffect(() => {
		window.atlas
			.getPlatform()
			.then((value) => setPlatform(value || "win32"))
			.catch(() => setPlatform("win32"));
	}, [setPlatform]);

	// Time sync
	useEffect(() => {
		let timeoutId: number | null = null;
		let intervalId: number | null = null;
		const tick = () => setNow(Date.now());
		const alignToSecondBoundary = () => {
			tick();
			const msUntilNextSecond = 1000 - (Date.now() % 1000);
			timeoutId = window.setTimeout(() => {
				tick();
				intervalId = window.setInterval(tick, 1000);
			}, msUntilNextSecond);
		};
		alignToSecondBoundary();
		return () => {
			if (timeoutId !== null) window.clearTimeout(timeoutId);
			if (intervalId !== null) window.clearInterval(intervalId);
		};
	}, [setNow]);

	// Session sync
	useEffect(() => {
		const sessionSync = window.setInterval(async () => {
			const [active, appName] = await Promise.all([
				window.atlas.getActiveSession(),
				window.atlas.getCurrentApp(),
			]);
			setActiveSession(active);
			setCurrentAppName(normalizeTrackedAppName(appName));
		}, 500);

		const dataSync = window.setInterval(async () => {
			if (selectedMapId) {
				setDashboard(await window.atlas.getDashboardOverview(selectedMapId));
			}
			const active = await window.atlas.getActiveSession();
			if (active && (active.map_id === selectedMapId || active.id === selectedSessionId)) {
				const blocks = await window.atlas.listActivityBySession(active.id);
				setActivityBlocks(blocks);
			}
		}, 2000);

		return () => {
			window.clearInterval(sessionSync);
			window.clearInterval(dataSync);
		};
	}, [selectedMapId, selectedSessionId, setActiveSession, setCurrentAppName, setDashboard, setActivityBlocks]);

	// Active session change
	useEffect(() => {
		if (isMiniMode || !selectedMapId) {
			previousActiveSessionIdRef.current = activeSession?.id ?? null;
			return;
		}
		const previousSessionId = previousActiveSessionIdRef.current;
		const currentSessionId = activeSession?.id ?? null;
		if (previousSessionId !== currentSessionId) {
			void (async () => {
				const [nextSessions, nextTasks, nextNotebook, nextDashboard] = await Promise.all([
					window.atlas.listSessionsByMap(selectedMapId),
					window.atlas.listTasksByMap(selectedMapId),
					window.atlas.getNotebookByMap(selectedMapId),
					window.atlas.getDashboardOverview(selectedMapId),
				]);
				setTaskColumnsByMap((current) => {
					const existing = normalizeColumns(current[selectedMapId] ?? defaultTaskColumns, defaultTaskColumns);
					const knownStatuses = new Set(existing.map((column) => column.status));
					const missingStatuses = nextTasks
						.map((task) => task.status)
						.filter((status, index, all) => all.indexOf(status) === index)
						.filter((status) => !knownStatuses.has(status));
					if (!missingStatuses.length && current[selectedMapId]) return current;
					const merged = normalizeColumns(
						[...existing, ...missingStatuses.map((status) => ({ status, label: status }))],
						defaultTaskColumns,
					);
					return { ...current, [selectedMapId]: merged };
				});
				setSessions(nextSessions);
				const mapOrder = taskOrderByMap[selectedMapId] ?? [];
				setTasks(sortTasksByOrder(nextTasks, mapOrder));
				setNotebook(nextNotebook);
				setDashboard(nextDashboard);
				if (nextSessions.length && !selectedSessionId) setSelectedSessionId(nextSessions[0].id);
				if (currentSessionId) {
					const blocks = await window.atlas.listActivityBySession(currentSessionId);
					setActivityBlocks(blocks);
				}
			})();
		}
		previousActiveSessionIdRef.current = currentSessionId;
	}, [
		activeSession?.id,
		isMiniMode,
		selectedMapId,
		selectedSessionId,
		taskOrderByMap,
		setSessions,
		setTaskColumnsByMap,
		setTasks,
		setNotebook,
		setDashboard,
		setSelectedSessionId,
		setActivityBlocks,
	]);

	// Initialize
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
				setTaskOrderByMap((current) => ({ ...current, [preferredMapId]: normalizedOrder }));
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
				setTaskColumnsByMap((current) => ({ ...current, [preferredMapId]: merged }));
				setTasks(sortTasksByOrder(nextTasks, normalizedOrder));
				setNotebook(nextNotebook);
				setDashboard(nextDashboard);
				if (nextSessions.length) setSelectedSessionId(nextSessions[0].id);
				if (active) {
					setSelectedSessionId(active.id);
					const blocks = await window.atlas.listActivityBySession(active.id);
					setActivityBlocks(blocks);
				}
			} catch (error) {
				setErrorMessage(error instanceof Error ? error.message : "Failed to initialize Atlas.");
			} finally {
				setHasBootstrapped(true);
			}
		};
		start().catch(console.error);
	}, [
		setTaskColumnsByMap,
		setMaps,
		setActiveSession,
		setCurrentAppName,
		setShowFirstLaunch,
		setSelectedMapId,
		setSessions,
		setTaskOrderByMap,
		setTasks,
		setNotebook,
		setDashboard,
		setSelectedSessionId,
		setActivityBlocks,
		setErrorMessage,
		setHasBootstrapped,
	]);

	// Helpers
	const refreshMapData = async (mapId: string) => {
		if (!mapId) return;
		const [nextSessions, nextTasks, nextNotebook, nextDashboard] = await Promise.all([
			window.atlas.listSessionsByMap(mapId),
			window.atlas.listTasksByMap(mapId),
			window.atlas.getNotebookByMap(mapId),
			window.atlas.getDashboardOverview(mapId),
		]);
		syncColumnsForMap(mapId, nextTasks);
		setSessions(nextSessions);
		const mapOrder = taskOrderByMap[mapId] ?? [];
		setTasks(sortTasksByOrder(nextTasks, mapOrder));
		setNotebook(nextNotebook);
		setDashboard(nextDashboard);
		if (nextSessions.length && !selectedSessionId) setSelectedSessionId(nextSessions[0].id);
	};

	const syncColumnsForMap = (mapId: string, nextTasks: TaskItem[]) => {
		setTaskColumnsByMap((current) => {
			const existing = normalizeColumns(current[mapId] ?? defaultTaskColumns, defaultTaskColumns);
			const knownStatuses = new Set(existing.map((column) => column.status));
			const missingStatuses = nextTasks
				.map((task) => task.status)
				.filter((status, index, all) => all.indexOf(status) === index)
				.filter((status) => !knownStatuses.has(status));
			if (!missingStatuses.length && current[mapId]) return current;
			const merged = normalizeColumns(
				[...existing, ...missingStatuses.map((status) => ({ status, label: status }))],
				defaultTaskColumns,
			);
			return { ...current, [mapId]: merged };
		});
	};

	const syncTasksForMap = async (mapId: string) => {
		const nextTasks = await window.atlas.listTasksByMap(mapId);
		syncColumnsForMap(mapId, nextTasks);
		const existingOrder = taskOrderByMap[mapId] ?? [];
		const existingSet = new Set(nextTasks.map((task) => task.id));
		const normalizedOrder = [
			...existingOrder.filter((id) => existingSet.has(id)),
			...nextTasks.map((task) => task.id).filter((id) => !existingOrder.includes(id)),
		];
		setTaskOrderByMap((current) => ({ ...current, [mapId]: normalizedOrder }));
		setTasks(sortTasksByOrder(nextTasks, normalizedOrder));
	};

	const refreshActivity = async (sessionId: string) => {
		const blocks = await window.atlas.listActivityBySession(sessionId);
		setActivityBlocks(blocks);
	};

	// Map operations
	const onCreateMap = async () => {
		const candidate = newMapName.trim();
		if (!candidate) return;
		const exists = maps.some((mapItem) => mapItem.name.trim().toLowerCase() === candidate.toLowerCase());
		if (exists) {
			setErrorMessage("Map name already exists.");
			return;
		}
		const map = await window.atlas.createMap(candidate);
		setMaps([...maps, map]);
		setSelectedMapId(map.id);
		setRenameMapName(map.name);
		setNewMapName("");
		setShowMapMenu(false);
		setShowFirstLaunch(false);
		setErrorMessage("");
		await refreshMapData(map.id);
	};

	const onRenameMap = async () => {
		if (!selectedMap || !renameMapName.trim()) return;
		const renamed = await window.atlas.renameMap(selectedMap.id, renameMapName.trim());
		setMaps((current) => current.map((item) => (item.id === renamed.id ? renamed : item)));
		setRenameMapName("");
		setShowMapMenu(false);
	};

	const onSelectMap = async (mapId: string) => {
		setSelectedMapId(mapId);
		setSelectedSessionId("");
		setNotebook(null);
		setActivityBlocks([]);
		setShowMapMenu(false);
		await refreshMapData(mapId);
	};

	const onDeleteMap = async () => {
		if (!selectedMap) return;
		if (activeSession && activeSession.map_id === selectedMap.id) {
			setErrorMessage("Stop the active session in this map before deleting it.");
			return;
		}
		const confirmed = window.confirm(
			`Delete map "${selectedMap.name}"? This removes all sessions, tasks, and notes in it.`,
		);
		if (!confirmed) return;
		try {
			await window.atlas.deleteMap(selectedMap.id);
			const remainingMaps = maps.filter((mapItem) => mapItem.id !== selectedMap.id);
			const fallbackMapId = remainingMaps[0]?.id ?? "";
			setMaps(remainingMaps);
			setShowMapMenu(false);
			setRenameMapName("");
			setNewMapName("");
			setSelectedMapId(fallbackMapId);
			setSelectedSessionId("");
			setNotebook(null);
			setActivityBlocks([]);
			setShowFirstLaunch(remainingMaps.length === 0);
			setErrorMessage("");
			if (fallbackMapId) {
				await refreshMapData(fallbackMapId);
				return;
			}
			setSessions([]);
			setTasks([]);
			setNotebook(null);
			setDashboard(defaultDashboard);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Unable to delete map.");
		}
	};

	// Session operations
	const onStartSession = async () => {
		if (!selectedMapId || activeSession) return;
		const session = await window.atlas.startSession(selectedMapId);
		setActiveSession(session);
		setSelectedSessionId(session.id);
		await Promise.all([refreshMapData(selectedMapId), refreshActivity(session.id)]);
	};

	const onPauseResume = async () => {
		if (!activeSession) return;
		const next = activeSession.is_paused
			? await window.atlas.resumeSession(activeSession.id)
			: await window.atlas.pauseSession(activeSession.id);
		setActiveSession(next);
		await refreshMapData(next.map_id);
	};

	const onStopSession = async () => {
		if (!activeSession) return;
		const latestActive = await window.atlas.getActiveSession();
		const sessionToStop = latestActive ?? activeSession;
		const mapId = sessionToStop.map_id;
		try {
			await window.atlas.stopSession(sessionToStop.id);
			setActiveSession(null);
			setActivityBlocks([]);
			await refreshMapData(mapId);
			setErrorMessage("");
		} catch (error) {
			const latestActive = await window.atlas.getActiveSession();
			if (!latestActive) {
				setActiveSession(null);
				setActivityBlocks([]);
				await refreshMapData(mapId);
				setErrorMessage("");
				return;
			}
			setErrorMessage(error instanceof Error ? error.message : "Unable to stop session.");
		}
	};

	const onDeleteSession = async (sessionId: string) => {
		if (!selectedMapId || !window.confirm("Are you sure you want to delete this session? This cannot be undone."))
			return;
		try {
			await window.atlas.deleteSession(sessionId);
			if (selectedSessionId === sessionId) {
				setSelectedSessionId("");
				setActivityBlocks([]);
			}
			await refreshMapData(selectedMapId);
			setErrorMessage("");
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Unable to delete session.");
		}
	};

	// Task operations
	const onCreateTaskInColumn = async (status: TaskStatus, title: string) => {
		if (!selectedMapId || !title.trim()) return;
		const created = await window.atlas.createTask(selectedMapId, title.trim(), "");
		if (created.status !== status) await window.atlas.updateTaskStatus(created.id, status);
		await syncTasksForMap(selectedMapId);
		setDashboard(await window.atlas.getDashboardOverview(selectedMapId));
	};

	const onRenameTaskColumn = (status: TaskStatus, label: string) => {
		if (!selectedMapId) return;
		setTaskColumnsByMap((current) => {
			const columns = normalizeColumns(current[selectedMapId] ?? defaultTaskColumns, defaultTaskColumns).map(
				(column) => (column.status === status ? { ...column, label } : column),
			);
			return { ...current, [selectedMapId]: columns };
		});
	};

	const onReorderTaskColumns = (
		draggedStatus: TaskStatus,
		targetStatus: TaskStatus,
		position: "before" | "after" = "before",
	) => {
		if (!selectedMapId || draggedStatus === targetStatus) return;
		setTaskColumnsByMap((current) => {
			const columns = normalizeColumns(current[selectedMapId] ?? defaultTaskColumns, defaultTaskColumns);
			const draggedIndex = columns.findIndex((column) => column.status === draggedStatus);
			const targetIndex = columns.findIndex((column) => column.status === targetStatus);
			if (draggedIndex < 0 || targetIndex < 0) return current;
			const nextColumns = [...columns];
			const [draggedColumn] = nextColumns.splice(draggedIndex, 1);
			let insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
			if (draggedIndex < insertIndex) insertIndex -= 1;
			nextColumns.splice(insertIndex, 0, draggedColumn);
			return { ...current, [selectedMapId]: nextColumns };
		});
	};

	const onAddTaskColumn = () => {
		if (!selectedMapId) return;
		setTaskColumnsByMap((current) => {
			const columns = normalizeColumns(current[selectedMapId] ?? defaultTaskColumns, defaultTaskColumns);
			const used = new Set(columns.map((column) => column.status));
			let nextIndex = columns.length + 1;
			let nextStatus = `column_${nextIndex}`;
			while (used.has(nextStatus)) {
				nextIndex += 1;
				nextStatus = `column_${nextIndex}`;
			}
			return { ...current, [selectedMapId]: [...columns, { status: nextStatus, label: `Column ${nextIndex}` }] };
		});
	};

	const onRemoveTaskColumn = async (status: TaskStatus) => {
		if (!selectedMapId) return;
		const columns = normalizeColumns(taskColumnsByMap[selectedMapId] ?? defaultTaskColumns, defaultTaskColumns);
		if (columns.length <= 1) return;
		const nextColumns = columns.filter((column) => column.status !== status);
		const fallbackStatus = nextColumns[0]?.status;
		if (!fallbackStatus) return;
		const tasksInRemovedColumn = tasks.filter((task) => task.status === status);
		if (tasksInRemovedColumn.length) {
			await Promise.all(
				tasksInRemovedColumn.map((task) => window.atlas.updateTaskStatus(task.id, fallbackStatus)),
			);
		}
		setTaskColumnsByMap((current) => ({ ...current, [selectedMapId]: nextColumns }));
		await syncTasksForMap(selectedMapId);
		setDashboard(await window.atlas.getDashboardOverview(selectedMapId));
	};

	const onDropInColumn = async (status: TaskStatus) => {
		if (!draggedTaskId || !selectedMapId) {
			setDropStatus(null);
			return;
		}
		const dragged = tasks.find((task) => task.id === draggedTaskId);
		if (dragged && dragged.status !== status) {
			await window.atlas.updateTaskStatus(dragged.id, status);
		}
		const baseTasks =
			dragged && dragged.status !== status
				? tasks.map((task) => (task.id === dragged.id ? { ...task, status } : task))
				: tasks;
		const currentOrder = taskOrderByMap[selectedMapId] ?? tasks.map((task) => task.id);
		const cleanOrder = currentOrder.filter((id) => baseTasks.some((task) => task.id === id));
		const withDraggedAtEnd = cleanOrder.includes(draggedTaskId) ? cleanOrder : [...cleanOrder, draggedTaskId];
		setTaskOrderByMap((current) => ({ ...current, [selectedMapId]: withDraggedAtEnd }));
		setTasks(sortTasksByOrder(baseTasks, withDraggedAtEnd));
		setDraggedTaskId("");
		setDropStatus(null);
		setDashboard(await window.atlas.getDashboardOverview(selectedMapId));
	};

	const onDropOnTask = async (targetTask: TaskItem, position: "before" | "after" = "before") => {
		if (!draggedTaskId || !selectedMapId || draggedTaskId === targetTask.id) {
			setDropStatus(null);
			return;
		}
		const dragged = tasks.find((task) => task.id === draggedTaskId);
		if (!dragged) {
			setDropStatus(null);
			return;
		}
		if (dragged.status !== targetTask.status) {
			await window.atlas.updateTaskStatus(dragged.id, targetTask.status);
		}
		const nextTasks = tasks.map((task) => (task.id === dragged.id ? { ...task, status: targetTask.status } : task));
		const currentOrder = taskOrderByMap[selectedMapId] ?? tasks.map((task) => task.id);
		const cleanOrder = currentOrder.filter((id) => nextTasks.some((task) => task.id === id));
		const nextOrder = reorderTaskIds(cleanOrder, dragged.id, targetTask.id, position);
		setTaskOrderByMap((current) => ({ ...current, [selectedMapId]: nextOrder }));
		setTasks(sortTasksByOrder(nextTasks, nextOrder));
		setDraggedTaskId("");
		setDropStatus(null);
		setDashboard(await window.atlas.getDashboardOverview(selectedMapId));
	};

	// Notebook & actions
	const onUpdateNotebookByMap = async (content: string) => {
		if (!selectedMapId) return;
		const updated = await window.atlas.updateNotebookByMap(selectedMapId, content);
		setNotebook(updated);
	};

	const onLaunchQuickAction = async (command: string) => {
		try {
			await window.atlas.launchApp(command);
			setErrorMessage("");
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Unable to launch app.");
		}
	};

	const addQuickAction = () => {
		if (!newActionLabel.trim() || !newActionCommand.trim()) return;
		setQuickActions((current) => [
			...current,
			{ id: crypto.randomUUID(), label: newActionLabel.trim(), command: newActionCommand.trim() },
		]);
		setNewActionLabel("");
		setNewActionCommand("");
	};

	const removeQuickAction = (id: string) => {
		setQuickActions((current) => current.filter((item) => item.id !== id));
	};

	const openSession = async (sessionId: string) => {
		setSelectedSessionId(sessionId);
		await refreshActivity(sessionId);
	};

	// UI helpers
	const isMacPlatform = platform === "darwin";
	const hasNativeWindowControls = platform === "darwin" || platform === "win32";
	const primaryViews = viewItems.filter((item) => item.id !== "settings");
	const settingsView = viewItems.find((item) => item.id === "settings");
	const activeElapsed = formatClock(activeSession ? sessionElapsedMs(activeSession, now) : 0);

	const onChangeView = (nextView: AtlasView) => {
		if (nextView === "settings") {
			void window.atlas.openSettingsWindow();
			return;
		}
		setView(nextView);
	};

	const miniSessionControls = (
		<div className="mini-session-controls recording-cluster active inline-flex min-w-0 items-center gap-2 rounded-[10px] border border-neutral-200 bg-neutral-0 p-0.5 dark:border-neutral-600 dark:bg-neutral-700/70">
			<span className="recording-timer top whitespace-nowrap rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.25 font-data text-data-regular text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700/90 dark:text-neutral-100">
				{activeElapsed}
			</span>
			<button
				className="group inline-flex h-7.75 w-7.75 items-center justify-center rounded-lg border border-transparent bg-transparent text-neutral-700 transition-colors hover:bg-transparent hover:text-primary-hover dark:text-neutral-100 dark:hover:bg-transparent dark:hover:text-primary-hover"
				onClick={onPauseResume}
				disabled={!activeSession}
				title={activeSession?.is_paused ? "Resume recording" : "Pause recording"}
			>
				{activeSession?.is_paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
			</button>
			<button
				className="group inline-flex h-7.75 w-7.75 items-center justify-center rounded-lg border border-transparent bg-transparent text-neutral-700 transition-colors hover:bg-transparent hover:text-secondary-hover dark:text-neutral-100 dark:hover:bg-transparent dark:hover:text-secondary-hover"
				onClick={onStopSession}
				disabled={!activeSession}
				title="Stop recording"
			>
				<StopIcon className="h-4 w-4" />
			</button>
			<button
				className="mini-close-btn group inline-flex h-7.75 w-7.75 items-center justify-center rounded-lg border border-transparent bg-transparent text-neutral-700 transition-colors hover:bg-transparent hover:text-secondary-hover dark:text-neutral-100 dark:hover:bg-transparent dark:hover:text-secondary-hover"
				onClick={() => void window.atlas.closeMiniWindow()}
				title="Close mini player"
			>
				<XMarkIcon className="h-4 w-4" />
			</button>
			<button
				className="mini-drag-handle inline-flex h-7.75 w-5.5 items-center justify-center rounded-lg border border-transparent bg-transparent text-neutral-500 dark:text-neutral-300"
				title="Hold and drag to move"
			>
				<span className="mini-drag-dots" />
			</button>
		</div>
	);

	if (isMiniMode) {
		return (
			<div className="atlas-mini-root text-neutral-900 dark:text-neutral-50">
				<div className="mini-body">
					<div
						className="mini-controls"
						ref={miniControlsRef}
					>
						{miniSessionControls}
					</div>
				</div>
			</div>
		);
	}

	if (isWelcomeMode) {
		return (
			<div className="atlas-welcome-root bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-50">
				<header
					className={`atlas-welcome-titlebar ${isMacPlatform ? "pl-21" : hasNativeWindowControls ? "pr-36.5" : "pr-23.5"}`}
				>
					<div className="no-drag inline-flex items-center gap-2 font-data text-[12px] uppercase tracking-[0.04em]">
						<img
							src={logo}
							alt="Atlas Logo"
							className="h-5 w-5 shrink-0"
						/>
						<span>Atlas</span>
					</div>
					{!hasNativeWindowControls && (
						<div className="no-drag absolute right-2 top-2.25 inline-flex gap-1">
							<button
								type="button"
								className="atlas-window-control"
								onClick={() => void window.atlas.windowMinimize()}
								aria-label="Minimize"
							>
								<MinusIcon className="h-4 w-4" />
							</button>
							<button
								type="button"
								className="atlas-window-control atlas-window-control-close"
								onClick={() => void window.atlas.windowClose()}
								aria-label="Close"
							>
								<XMarkIcon className="h-4 w-4" />
							</button>
						</div>
					)}
				</header>

				<div className="atlas-welcome-shell">
					<header className="atlas-welcome-header">
						<div className="atlas-welcome-eyebrow">Welkom</div>
						<h1>Start je eerste project</h1>
						<p>Maak een map aan om direct te beginnen.</p>
					</header>

					<section className="atlas-welcome-card">
						<label htmlFor="welcome-map-name">Mapnaam</label>
						<input
							id="welcome-map-name"
							value={newMapName}
							onChange={(event) => setNewMapName(event.target.value)}
							placeholder="Bijv. Client Sprint"
							autoFocus
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void onCreateMap();
								}
							}}
						/>
						<button
							className="action-btn atlas-welcome-create"
							onClick={() => void onCreateMap()}
						>
							Maak nieuwe map
						</button>
						{errorMessage && <p className="error-banner">{errorMessage}</p>}
					</section>
				</div>
			</div>
		);
	}

	return (
		<div className="atlas-root bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-50">
			{hasBootstrapped && !showFirstLaunch && (
				<div className="atlas-app-grid">
					<div className="atlas-header-slot">
						<AtlasHeader
							isMacPlatform={isMacPlatform}
							selectedMapId={selectedMapId}
							selectedMapName={selectedMap?.name ?? "Choose map"}
							maps={maps}
							showMapMenu={showMapMenu}
							renameMapName={renameMapName}
							newMapName={newMapName}
							onToggleMapMenu={() => setShowMapMenu((v) => !v)}
							onCloseMapMenu={() => setShowMapMenu(false)}
							onSelectMap={onSelectMap}
							onRenameMapNameChange={setRenameMapName}
							onNewMapNameChange={setNewMapName}
							onCreateMap={onCreateMap}
							onRenameMap={onRenameMap}
							onDeleteMap={onDeleteMap}
							canDeleteMap={
								Boolean(selectedMapId) && !(activeSession && activeSession.map_id === selectedMapId)
							}
							activeSession={activeSession}
							activeElapsed={activeElapsed}
							canStartRecording={Boolean(selectedMapId)}
							onStartSession={onStartSession}
							onPauseResume={onPauseResume}
							onStopSession={onStopSession}
							onOpenMiniWindow={() => void window.atlas.openMiniWindow()}
						/>
					</div>

					<div className="atlas-sidebar-slot">
						<AtlasSidebar
							primaryViews={primaryViews}
							settingsView={settingsView}
							activeView={view}
							onChangeView={onChangeView}
						/>
					</div>

					<div className="atlas-main-slot">
						<AtlasMainContent
							view={view}
							errorMessage={errorMessage}
						>
							<MainContentViews
								view={view}
								dashboard={dashboard}
								activeSession={activeSession}
								activeElapsed={activeElapsed}
								currentAppName={currentAppName}
								selectedMapName={selectedMap?.name ?? "None"}
								quickActions={quickActions}
								onLaunchQuickAction={onLaunchQuickAction}
								sessions={sessions}
								selectedSession={selectedSession}
								onOpenSession={openSession}
								onDeleteSession={onDeleteSession}
								activityBlocks={activityBlocks}
								now={now}
								formatDuration={formatDuration}
								formatClock={formatClock}
								sessionElapsedMs={sessionElapsedMs}
								statusColumns={statusColumns}
								tasks={tasks}
								dropStatus={dropStatus}
								setDropStatus={setDropStatus}
								onDropInColumn={onDropInColumn}
								onDropOnTask={onDropOnTask}
								setDraggedTaskId={setDraggedTaskId}
								onCreateTaskInColumn={onCreateTaskInColumn}
								onRenameTaskColumn={onRenameTaskColumn}
								onReorderTaskColumns={onReorderTaskColumns}
								onAddTaskColumn={onAddTaskColumn}
								onRemoveTaskColumn={onRemoveTaskColumn}
								notebook={notebook}
								onUpdateNotebookByMap={onUpdateNotebookByMap}
								theme={theme}
								onThemeChange={setTheme}
								newActionLabel={newActionLabel}
								newActionCommand={newActionCommand}
								onNewActionLabelChange={setNewActionLabel}
								onNewActionCommandChange={setNewActionCommand}
								onAddQuickAction={addQuickAction}
								onRemoveQuickAction={removeQuickAction}
							/>
						</AtlasMainContent>
					</div>
				</div>
			)}

			<AnimatePresence>
				{hasBootstrapped && showFirstLaunch && (
					<motion.div
						className="first-launch-overlay"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
					>
						<motion.div
							className="first-launch-modal"
							initial={{ opacity: 0, y: 16, scale: 0.98 }}
							animate={{ opacity: 1, y: 0, scale: 1 }}
							exit={{ opacity: 0, y: 16, scale: 0.98 }}
						>
							<h2>Start je eerste project</h2>
							<p>Projecten groeperen je sessies, activiteit, taken en notities in een context.</p>
							<input
								value={newMapName}
								onChange={(event) => setNewMapName(event.target.value)}
								placeholder="Client Sprint"
								autoFocus
							/>
							<button
								className="action-btn"
								onClick={onCreateMap}
							>
								Create
							</button>
						</motion.div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

function App() {
	const mode = useMemo(() => new URLSearchParams(window.location.search).get("mode"), []);
	if (mode === "settings") return <SettingsWindowApp />;
	return <MainAtlasApp />;
}

export default App;
