import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MinusIcon, XMarkIcon, PauseIcon, PlayIcon, StopIcon } from "@heroicons/react/24/outline";
import type {
	AtlasView,
	TaskStatus,
	TaskItem,
	TaskColumn,
	TaskUpdate,
	Environment,
	IsolationAllowlistEntry,
	IsolationMode,
} from "./types";
import { AtlasHeader } from "./components/AtlasHeader";
import { AtlasSidebar } from "./components/AtlasSidebar";
import { AtlasMainContent } from "./components/AtlasMainContent";
import { MainContentViews } from "./components/main-content";
import { SettingsWindowApp } from "./components/settings-window/SettingsWindowApp";
import { NotchApp } from "./components/notch/NotchApp";
import { ActionEditorWindowApp } from "./components/action-editor/ActionEditorWindowApp";
import { NotchInputWindowApp } from "./components/notch-input/NotchInputWindowApp";
import { SmartCapture } from "./components/SmartCapture";
import { EnvironmentDeleteDialog } from "./components/EnvironmentDeleteDialog";
import type { ParsedCapture } from "./utils/smartParse";
import { switchIsolationMode } from "./utils/isolationMode";
import logo from "./assets/logosmall.png";
import {
	useEnvironmentManagement,
	useSessionManagement,
	useTaskManagement,
	useNotebookManagement,
	useDashboardManagement,
	useActivityManagement,
	useThemeManagement,
	useFocus,
	useEnvironmentMenuManagement,
	useErrorManagement,
	useTimeManagement,
	usePlatformManagement,
	useBootstrapState,
	useCurrentAppTracker,
	useAccent,
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
import {
	TASK_ORDER_KEY,
	TASK_COLUMNS_KEY,
	SIDEBAR_HIDDEN_KEY,
	defaultDashboard,
	defaultTaskColumns,
	viewItems,
} from "./constants";
import { applyAccent } from "./utils/accent";
import {
	DEFAULT_ENVIRONMENT_ICON,
	ENVIRONMENT_PRESETS,
	getEnvironmentIcon,
	type EnvironmentPresetTemplate,
} from "./environments";

function MainAtlasApp() {
	const isMiniMode = useMemo(() => new URLSearchParams(window.location.search).get("mode") === "mini", []);
	const isWelcomeMode = useMemo(
		() => new URLSearchParams(window.location.search).get("mode") === "welcome",
		[],
	);
	const [view, setView] = useState<AtlasView>("dashboard");
	const [captureOpen, setCaptureOpen] = useState(false);
	const [hiddenSidebarViews, setHiddenSidebarViews] = useState<string[]>(() =>
		readStorage(SIDEBAR_HIDDEN_KEY, [] as string[]),
	);

	// Lets the smart notch deep-link into a specific view.
	useEffect(() => {
		const unsubscribe = window.atlas.onNavigate?.(setView);
		return () => unsubscribe?.();
	}, []);

	// ⌘/Ctrl-K anywhere opens Smart Quick Capture — the one place you drop a
	// thought and let Atlas file it. Toggles so the same chord dismisses it.
	useEffect(() => {
		if (isMiniMode || isWelcomeMode) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setCaptureOpen((current) => !current);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [isMiniMode, isWelcomeMode]);

	const { environments, setEnvironments, selectedEnvironmentId, setSelectedEnvironmentId, selectedEnvironment } = useEnvironmentManagement();
	// WP-1.2 (isolation enforcement UI): the WP-0.8 cross-environment allowlist,
	// described in plain language by the main process. Loaded once at
	// bootstrap (it's a static list, not per-environment) and handed straight
	// through to whatever renders "what's shared right now" -- see
	// src/utils/isolationMode.ts for why this must never be re-described here.
	const [isolationAllowlist, setIsolationAllowlist] = useState<IsolationAllowlistEntry[]>([]);
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
		taskOrderByEnvironment,
		setTaskOrderByEnvironment,
		taskColumnsByEnvironment,
		setTaskColumnsByEnvironment,
		draggedTaskId,
		setDraggedTaskId,
		dropStatus,
		setDropStatus,
		statusColumns,
	} = useTaskManagement(selectedEnvironmentId);
	const { notebook, setNotebook } = useNotebookManagement();
	const { dashboard, setDashboard } = useDashboardManagement();
	const { activityBlocks, setActivityBlocks } = useActivityManagement();
	const { theme, resolvedTheme, setTheme } = useThemeManagement();
	const {
		showEnvironmentMenu,
		setShowEnvironmentMenu,
		renameEnvironmentName,
		setRenameEnvironmentName,
		newEnvironmentName,
		setNewEnvironmentName,
		showFirstLaunch,
		setShowFirstLaunch,
	} = useEnvironmentMenuManagement();
	const { errorMessage, setErrorMessage } = useErrorManagement();
	const { now, setNow } = useTimeManagement();
	const focus = useFocus(now);
	const { platform, setPlatform } = usePlatformManagement();
	const { hasBootstrapped, setHasBootstrapped } = useBootstrapState();
	const { currentAppName, setCurrentAppName } = useCurrentAppTracker();
	// Applies the saved accent on mount and keeps it in sync when changed in another window.
	const { accent: globalAccent } = useAccent();

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
		localStorage.setItem(TASK_ORDER_KEY, JSON.stringify(taskOrderByEnvironment));
	}, [taskOrderByEnvironment]);

	useEffect(() => {
		localStorage.setItem(TASK_COLUMNS_KEY, JSON.stringify(taskColumnsByEnvironment));
	}, [taskColumnsByEnvironment]);

	useEffect(() => {
		localStorage.setItem(SIDEBAR_HIDDEN_KEY, JSON.stringify(hiddenSidebarViews));
	}, [hiddenSidebarViews]);

	// If the active view gets hidden from the sidebar, fall back to the first visible one.
	useEffect(() => {
		if (hiddenSidebarViews.includes(view)) {
			const firstVisible = viewItems.find(
				(item) => item.id !== "settings" && !hiddenSidebarViews.includes(item.id),
			);
			if (firstVisible) setView(firstVisible.id);
		}
	}, [hiddenSidebarViews, view]);

	// Environment accent override: when the selected environment defines its own
	// accent the whole app adopts it; otherwise it falls back to the global accent.
	useEffect(() => {
		applyAccent(selectedEnvironment?.accent || globalAccent);
	}, [selectedEnvironment?.accent, globalAccent]);

	// WP-1.4: the environment's own theme override (if any), applied on top of
	// the DOM without ever going through setTheme/localStorage -- exactly like
	// the accent effect above, and for the same reason: writing THROUGH the
	// persisted global preference would mean a "system" (no-opinion)
	// environment could get stuck on whatever the previous environment last
	// overrode to, since there would be no separate memory of what "system"
	// should fall back to. `null` here means "no override", in which case the
	// effect below this one just re-applies the ordinary resolved theme.
	const [environmentThemeOverride, setEnvironmentThemeOverride] = useState<"light" | "dark" | null>(null);

	// Populated by the `environment:activated` broadcast (main.cjs's
	// setActiveEnvironment), which fires from EVERY switch surface -- the
	// Notch, this window's own switcher, and the global hotkey's switcher --
	// since all three funnel through the same `environment:switch` IPC call.
	useEffect(() => {
		const unsubscribe = window.atlas.onEnvironmentActivated?.((bundle) => {
			const nextTheme = bundle?.appearance?.theme;
			setEnvironmentThemeOverride(nextTheme === "light" || nextTheme === "dark" ? nextTheme : null);
		});
		return () => unsubscribe?.();
	}, []);

	useEffect(() => {
		const effectiveTheme = environmentThemeOverride ?? resolvedTheme;
		document.documentElement.dataset.theme = effectiveTheme;
		document.documentElement.classList.toggle("dark", effectiveTheme === "dark");
	}, [environmentThemeOverride, resolvedTheme]);

	// WP-1.4: the global hotkey brings the main window forward and fires this
	// so it opens the SAME environment switcher the header button already
	// opens, rather than a second, standalone switcher UI.
	useEffect(() => {
		const unsubscribe = window.atlas.onOpenEnvironmentSwitcher?.(() => setShowEnvironmentMenu(true));
		return () => unsubscribe?.();
	}, [setShowEnvironmentMenu]);

	// Remember the active environment so the notch can start a session in it.
	useEffect(() => {
		if (selectedEnvironmentId) {
			try {
				localStorage.setItem("atlas.lastEnvironmentId", selectedEnvironmentId);
			} catch {
				// Ignore storage failures; the notch falls back to the first environment.
			}
			// Tells main.cjs which environment is now active. WP-0.5: records
			// `environment.switch` in the event log. WP-1.4: also this is what
			// makes the switch atomic -- main.cjs resolves this environment's
			// whole appearance/AI/notch bundle and applies it (native theme, AI
			// provider override, Notch re-render) before broadcasting
			// `environment:activated` back to every window, including this one.
			void window.atlas.notifyEnvironmentSwitch(selectedEnvironmentId).catch(() => {});
		}
	}, [selectedEnvironmentId]);

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
			if (selectedEnvironmentId) {
				setDashboard(await window.atlas.getDashboardOverview(selectedEnvironmentId));
			}
			const active = await window.atlas.getActiveSession();
			if (active && (active.environment_id === selectedEnvironmentId || active.id === selectedSessionId)) {
				const blocks = await window.atlas.listActivityBySession(active.id);
				setActivityBlocks(blocks);
			}
		}, 2000);

		return () => {
			window.clearInterval(sessionSync);
			window.clearInterval(dataSync);
		};
	}, [
		selectedEnvironmentId,
		selectedSessionId,
		setActiveSession,
		setCurrentAppName,
		setDashboard,
		setActivityBlocks,
	]);

	// Active session change
	useEffect(() => {
		if (isMiniMode || !selectedEnvironmentId) {
			previousActiveSessionIdRef.current = activeSession?.id ?? null;
			return;
		}
		const previousSessionId = previousActiveSessionIdRef.current;
		const currentSessionId = activeSession?.id ?? null;
		if (previousSessionId !== currentSessionId) {
			void (async () => {
				const [nextSessions, nextTasks, nextNotebook, nextDashboard] = await Promise.all([
					window.atlas.listSessionsByEnvironment(selectedEnvironmentId),
					window.atlas.listTasksByEnvironment(selectedEnvironmentId),
					window.atlas.getNotebookByEnvironment(selectedEnvironmentId),
					window.atlas.getDashboardOverview(selectedEnvironmentId),
				]);
				setTaskColumnsByEnvironment((current) => {
					const existing = normalizeColumns(current[selectedEnvironmentId] ?? defaultTaskColumns, defaultTaskColumns);
					const knownStatuses = new Set(existing.map((column) => column.status));
					const missingStatuses = nextTasks
						.map((task) => task.status)
						.filter((status, index, all) => all.indexOf(status) === index)
						.filter((status) => !knownStatuses.has(status));
					if (!missingStatuses.length && current[selectedEnvironmentId]) return current;
					const merged = normalizeColumns(
						[...existing, ...missingStatuses.map((status) => ({ status, label: status }))],
						defaultTaskColumns,
					);
					return { ...current, [selectedEnvironmentId]: merged };
				});
				setSessions(nextSessions);
				const environmentOrder = taskOrderByEnvironment[selectedEnvironmentId] ?? [];
				setTasks(sortTasksByOrder(nextTasks, environmentOrder));
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
		selectedEnvironmentId,
		selectedSessionId,
		taskOrderByEnvironment,
		setSessions,
		setTaskColumnsByEnvironment,
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
				setTaskColumnsByEnvironment(persistedColumns);
				const [environmentList, active, appName, allowlist] = await Promise.all([
					window.atlas.listEnvironments(),
					window.atlas.getActiveSession(),
					window.atlas.getCurrentApp(),
					window.atlas.getIsolationAllowlist(),
				]);
				setEnvironments(environmentList);
				setActiveSession(active);
				setCurrentAppName(normalizeTrackedAppName(appName));
				setIsolationAllowlist(allowlist);
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
				setTaskOrderByEnvironment((current) => ({ ...current, [preferredEnvironmentId]: normalizedOrder }));
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
				setTaskColumnsByEnvironment((current) => ({ ...current, [preferredEnvironmentId]: merged }));
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
		setTaskColumnsByEnvironment,
		setEnvironments,
		setActiveSession,
		setCurrentAppName,
		setIsolationAllowlist,
		setShowFirstLaunch,
		setSelectedEnvironmentId,
		setSessions,
		setTaskOrderByEnvironment,
		setTasks,
		setNotebook,
		setDashboard,
		setSelectedSessionId,
		setActivityBlocks,
		setErrorMessage,
		setHasBootstrapped,
	]);

	// Helpers
	const refreshEnvironmentData = async (environmentId: string) => {
		if (!environmentId) return;
		const [nextSessions, nextTasks, nextNotebook, nextDashboard] = await Promise.all([
			window.atlas.listSessionsByEnvironment(environmentId),
			window.atlas.listTasksByEnvironment(environmentId),
			window.atlas.getNotebookByEnvironment(environmentId),
			window.atlas.getDashboardOverview(environmentId),
		]);
		syncColumnsForEnvironment(environmentId, nextTasks);
		setSessions(nextSessions);
		const environmentOrder = taskOrderByEnvironment[environmentId] ?? [];
		setTasks(sortTasksByOrder(nextTasks, environmentOrder));
		setNotebook(nextNotebook);
		setDashboard(nextDashboard);
		if (nextSessions.length && !selectedSessionId) setSelectedSessionId(nextSessions[0].id);
	};

	const syncColumnsForEnvironment = (environmentId: string, nextTasks: TaskItem[]) => {
		setTaskColumnsByEnvironment((current) => {
			const existing = normalizeColumns(current[environmentId] ?? defaultTaskColumns, defaultTaskColumns);
			const knownStatuses = new Set(existing.map((column) => column.status));
			const missingStatuses = nextTasks
				.map((task) => task.status)
				.filter((status, index, all) => all.indexOf(status) === index)
				.filter((status) => !knownStatuses.has(status));
			if (!missingStatuses.length && current[environmentId]) return current;
			const merged = normalizeColumns(
				[...existing, ...missingStatuses.map((status) => ({ status, label: status }))],
				defaultTaskColumns,
			);
			return { ...current, [environmentId]: merged };
		});
	};

	const syncTasksForEnvironment = async (environmentId: string) => {
		const nextTasks = await window.atlas.listTasksByEnvironment(environmentId);
		syncColumnsForEnvironment(environmentId, nextTasks);
		const existingOrder = taskOrderByEnvironment[environmentId] ?? [];
		const existingSet = new Set(nextTasks.map((task) => task.id));
		const normalizedOrder = [
			...existingOrder.filter((id) => existingSet.has(id)),
			...nextTasks.map((task) => task.id).filter((id) => !existingOrder.includes(id)),
		];
		setTaskOrderByEnvironment((current) => ({ ...current, [environmentId]: normalizedOrder }));
		setTasks(sortTasksByOrder(nextTasks, normalizedOrder));
	};

	const refreshActivity = async (sessionId: string) => {
		const blocks = await window.atlas.listActivityBySession(sessionId);
		setActivityBlocks(blocks);
	};

	// Map operations
	const onCreateEnvironment = async () => {
		const candidate = newEnvironmentName.trim();
		if (!candidate) return;
		const exists = environments.some((environmentItem) => environmentItem.name.trim().toLowerCase() === candidate.toLowerCase());
		if (exists) {
			setErrorMessage("Environment name already exists.");
			return;
		}
		const map = await window.atlas.createEnvironment(candidate, {
			icon: DEFAULT_ENVIRONMENT_ICON,
			accent: null,
			preset: "custom",
		});
		setEnvironments([...environments, map]);
		setSelectedEnvironmentId(map.id);
		setRenameEnvironmentName(map.name);
		setNewEnvironmentName("");
		setShowEnvironmentMenu(false);
		setShowFirstLaunch(false);
		setErrorMessage("");
		await refreshEnvironmentData(map.id);
	};

	const onCreatePresetEnvironment = async (preset: EnvironmentPresetTemplate) => {
		const lower = (value: string) => value.trim().toLowerCase();
		let name = preset.name;
		let suffix = 2;
		while (environments.some((environmentItem) => lower(environmentItem.name) === lower(name))) {
			name = `${preset.name} ${suffix}`;
			suffix += 1;
		}
		const map = await window.atlas.createEnvironment(name, {
			icon: preset.icon,
			accent: preset.accent,
			preset: preset.id,
		});
		setEnvironments((current) => [...current, map]);
		setSelectedEnvironmentId(map.id);
		setRenameEnvironmentName(map.name);
		setNewEnvironmentName("");
		setShowEnvironmentMenu(false);
		setShowFirstLaunch(false);
		setErrorMessage("");
		await refreshEnvironmentData(map.id);
	};

	const onUpdateEnvironment = async (
		fields: Partial<Pick<Environment, "name" | "icon" | "accent" | "preset">>,
	) => {
		if (!selectedEnvironmentId) return;
		const updated = await window.atlas.updateEnvironment(selectedEnvironmentId, fields);
		setEnvironments((current) => current.map((environmentItem) => (environmentItem.id === updated.id ? updated : environmentItem)));
	};

	// WP-1.2 (isolation enforcement UI): the one call path both Connected<->
	// Enclosed transitions go through. `switchIsolationMode` (src/utils/
	// isolationMode.ts) owns the actual decision logic -- which warning to
	// show, whether to bail out on cancel -- this just supplies the real
	// `window.confirm` / `window.atlas.setEnvironmentIsolationMode` and folds
	// the result back into local state exactly like `onUpdateEnvironment`
	// above. Returns nothing when the user cancels or the mode wasn't
	// actually changing; there is nothing to update in that case.
	const onChangeEnvironmentIsolationMode = async (nextMode: IsolationMode) => {
		if (!selectedEnvironment) return;
		const updated = await switchIsolationMode({
			environmentId: selectedEnvironment.id,
			environmentName: selectedEnvironment.name,
			currentMode: selectedEnvironment.isolation_mode,
			nextMode,
			allowlist: isolationAllowlist,
			confirm: (message) => window.confirm(message),
			setIsolationMode: (environmentId, mode) => window.atlas.setEnvironmentIsolationMode(environmentId, mode),
		});
		if (!updated) return;
		setEnvironments((current) => current.map((environmentItem) => (environmentItem.id === updated.id ? updated : environmentItem)));
	};

	const onRenameEnvironment = async () => {
		if (!selectedEnvironment || !renameEnvironmentName.trim()) return;
		const renamed = await window.atlas.renameEnvironment(selectedEnvironment.id, renameEnvironmentName.trim());
		setEnvironments((current) => current.map((item) => (item.id === renamed.id ? renamed : item)));
		setRenameEnvironmentName("");
		setShowEnvironmentMenu(false);
	};

	const onSelectEnvironment = async (environmentId: string) => {
		setSelectedEnvironmentId(environmentId);
		setSelectedSessionId("");
		setNotebook(null);
		setActivityBlocks([]);
		setShowEnvironmentMenu(false);
		await refreshEnvironmentData(environmentId);
	};

	// WP-1.5: replaces the old instant `window.confirm(...)` -- a bare "Are you
	// sure?" can't say what's actually about to be destroyed. Both this
	// header-menu trigger and EnvironmentManagementCard's own per-row delete
	// button (Settings) funnel into the SAME dialog and the SAME fallback
	// logic below; neither duplicates the counts-fetching or confirmation
	// flow. `deleteDialogEnvironment` holds the full row (not just an id) so
	// the dialog works for an archived row too, which never appears in
	// `environments` (App state only ever holds the visible list).
	const [deleteDialogEnvironment, setDeleteDialogEnvironment] = useState<Environment | null>(null);

	// Re-fetches the visible environment list after ANY mutation that could
	// change its membership (delete, archive, unarchive, duplicate, create),
	// and -- the part a naive "just update local state" version would miss --
	// falls back to another environment (or the empty/first-launch state) the
	// moment the currently SELECTED one is no longer in that fresh list,
	// whether because it was deleted, archived, or (defensively) vanished for
	// any other reason. This is the one place "what happens to the active
	// environment" is decided, so every mutation path gets the same answer.
	const refreshEnvironmentsAndFallback = async () => {
		const fresh = await window.atlas.listEnvironments();
		setEnvironments(fresh);
		if (selectedEnvironmentId && fresh.some((environmentItem) => environmentItem.id === selectedEnvironmentId)) {
			return;
		}
		const fallbackEnvironmentId = fresh[0]?.id ?? "";
		setSelectedEnvironmentId(fallbackEnvironmentId);
		setShowEnvironmentMenu(false);
		setRenameEnvironmentName("");
		setSelectedSessionId("");
		setNotebook(null);
		setActivityBlocks([]);
		setShowFirstLaunch(fresh.length === 0);
		setErrorMessage("");
		if (fallbackEnvironmentId) {
			await refreshEnvironmentData(fallbackEnvironmentId);
			return;
		}
		setSessions([]);
		setTasks([]);
		setNotebook(null);
		setDashboard(defaultDashboard);
	};

	// The header menu's quick "Delete environment" action: opens the shared
	// dialog for the CURRENTLY selected environment, after the same
	// active-session guard the old instant-delete flow already had (deleting
	// out from under a running session is refused server-side too --
	// db.cjs#deleteEnvironment -- but failing fast here avoids a round trip
	// just to show the same message).
	const onRequestDeleteEnvironment = () => {
		if (!selectedEnvironment) return;
		if (activeSession && activeSession.environment_id === selectedEnvironment.id) {
			setErrorMessage("Stop the active session in this environment before deleting it.");
			return;
		}
		setErrorMessage("");
		setDeleteDialogEnvironment(selectedEnvironment);
	};

	// EnvironmentManagementCard's per-row delete button: same dialog, for an
	// ARBITRARY row (active or archived), not just whatever happens to be
	// selected right now.
	const onRequestDeleteEnvironmentRow = (environment: Environment) => {
		if (activeSession && activeSession.environment_id === environment.id) {
			setErrorMessage("Stop the active session in this environment before deleting it.");
			return;
		}
		setErrorMessage("");
		setDeleteDialogEnvironment(environment);
	};

	// The dialog's two destructive-ish actions. Both let their error
	// propagate (rather than catching it here) -- EnvironmentDeleteDialog
	// itself catches and displays it inline, so swallowing it here would just
	// mean the dialog appears to do nothing on failure.
	const onConfirmDeleteEnvironmentDialog = async (environmentId: string) => {
		await window.atlas.deleteEnvironment(environmentId);
		setDeleteDialogEnvironment(null);
		await refreshEnvironmentsAndFallback();
	};

	const onArchiveEnvironmentFromDialog = async (environmentId: string) => {
		await window.atlas.archiveEnvironment(environmentId);
		setDeleteDialogEnvironment(null);
		await refreshEnvironmentsAndFallback();
	};

	// The row-level actions EnvironmentManagementCard (Settings) offers
	// directly, with no confirmation dialog -- archiving and duplicating are
	// both reversible/non-destructive, so proportional confirmation (WP-1.5's
	// whole point for delete) doesn't apply here the same way.
	const onArchiveEnvironmentById = async (environmentId: string) => {
		await window.atlas.archiveEnvironment(environmentId);
		await refreshEnvironmentsAndFallback();
	};

	const onUnarchiveEnvironmentById = async (environmentId: string) => {
		await window.atlas.unarchiveEnvironment(environmentId);
		await refreshEnvironmentsAndFallback();
	};

	const onDuplicateEnvironmentById = async (environmentId: string) => {
		await window.atlas.duplicateEnvironment(environmentId);
		await refreshEnvironmentsAndFallback();
	};

	// The generalized counterpart to onUpdateEnvironment above: edits ANY
	// environment by id (EnvironmentManagementCard can edit a row that isn't
	// the currently selected one), not just selectedEnvironmentId.
	const onUpdateEnvironmentById = async (
		environmentId: string,
		fields: Partial<Pick<Environment, "name" | "icon" | "accent" | "preset">>,
	) => {
		const updated = await window.atlas.updateEnvironment(environmentId, fields);
		setEnvironments((current) => current.map((environmentItem) => (environmentItem.id === updated.id ? updated : environmentItem)));
	};

	// Session operations
	const onStartSession = async () => {
		if (!selectedEnvironmentId || activeSession) return;
		const session = await window.atlas.startSession(selectedEnvironmentId);
		setActiveSession(session);
		setSelectedSessionId(session.id);
		await Promise.all([refreshEnvironmentData(selectedEnvironmentId), refreshActivity(session.id)]);
	};

	const onPauseResume = async () => {
		if (!activeSession) return;
		const next = activeSession.is_paused
			? await window.atlas.resumeSession(activeSession.id)
			: await window.atlas.pauseSession(activeSession.id);
		setActiveSession(next);
		await refreshEnvironmentData(next.environment_id);
	};

	const onStopSession = async () => {
		if (!activeSession) return;
		const latestActive = await window.atlas.getActiveSession();
		const sessionToStop = latestActive ?? activeSession;
		const environmentId = sessionToStop.environment_id;
		try {
			await window.atlas.stopSession(sessionToStop.id);
			setActiveSession(null);
			setActivityBlocks([]);
			await refreshEnvironmentData(environmentId);
			setErrorMessage("");
		} catch (error) {
			const latestActive = await window.atlas.getActiveSession();
			if (!latestActive) {
				setActiveSession(null);
				setActivityBlocks([]);
				await refreshEnvironmentData(environmentId);
				setErrorMessage("");
				return;
			}
			setErrorMessage(error instanceof Error ? error.message : "Unable to stop session.");
		}
	};

	const onDeleteSession = async (sessionId: string) => {
		if (
			!selectedEnvironmentId ||
			!window.confirm("Are you sure you want to delete this session? This cannot be undone.")
		)
			return;
		try {
			await window.atlas.deleteSession(sessionId);
			if (selectedSessionId === sessionId) {
				setSelectedSessionId("");
				setActivityBlocks([]);
			}
			await refreshEnvironmentData(selectedEnvironmentId);
			setErrorMessage("");
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Unable to delete session.");
		}
	};

	// Resolves a given environment's columns for Smart Capture routing, so a
	// captured line can land in the right column of whichever environment it
	// targets (not only the one that's currently open).
	const columnsFor = useCallback(
		(environmentId: string) => normalizeColumns(taskColumnsByEnvironment[environmentId] ?? defaultTaskColumns, defaultTaskColumns),
		[taskColumnsByEnvironment],
	);

	// Files a parsed Smart Capture result: creates the task (fully routed with
	// priority/due/tags/column) or the note, then surfaces it — switching to the
	// target environment if the capture named a different one.
	const onSmartCapture = async (result: ParsedCapture) => {
		const envId = result.environmentId ?? selectedEnvironmentId;
		const title = result.title.trim();
		if (!envId || !title) {
			setCaptureOpen(false);
			return;
		}
		try {
			if (result.kind === "note") {
				await window.atlas.createNote(envId, title);
			} else {
				await window.atlas.createTask(envId, title, "", {
					status: result.columnStatus ?? undefined,
					priority: result.priority,
					tags: result.tags,
					due_date: result.dueDate,
				});
			}
			setErrorMessage("");
			if (envId !== selectedEnvironmentId) {
				await onSelectEnvironment(envId);
			} else {
				await syncTasksForEnvironment(envId);
				setDashboard(await window.atlas.getDashboardOverview(envId));
			}
			if (result.kind === "task") setView("tasks");
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Could not capture that.");
		} finally {
			setCaptureOpen(false);
		}
	};

	// Task operations
	const onCreateTaskInColumn = async (status: TaskStatus, title: string) => {
		if (!selectedEnvironmentId || !title.trim()) return;
		const created = await window.atlas.createTask(selectedEnvironmentId, title.trim(), "");
		if (created.status !== status) await window.atlas.updateTaskStatus(created.id, status);
		await syncTasksForEnvironment(selectedEnvironmentId);
		setDashboard(await window.atlas.getDashboardOverview(selectedEnvironmentId));
	};

	const onRenameTaskColumn = (status: TaskStatus, label: string) => {
		if (!selectedEnvironmentId) return;
		setTaskColumnsByEnvironment((current) => {
			const columns = normalizeColumns(current[selectedEnvironmentId] ?? defaultTaskColumns, defaultTaskColumns).map(
				(column) => (column.status === status ? { ...column, label } : column),
			);
			return { ...current, [selectedEnvironmentId]: columns };
		});
	};

	const onReorderTaskColumns = (
		draggedStatus: TaskStatus,
		targetStatus: TaskStatus,
		position: "before" | "after" = "before",
	) => {
		if (!selectedEnvironmentId || draggedStatus === targetStatus) return;
		setTaskColumnsByEnvironment((current) => {
			const columns = normalizeColumns(current[selectedEnvironmentId] ?? defaultTaskColumns, defaultTaskColumns);
			const draggedIndex = columns.findIndex((column) => column.status === draggedStatus);
			const targetIndex = columns.findIndex((column) => column.status === targetStatus);
			if (draggedIndex < 0 || targetIndex < 0) return current;
			const nextColumns = [...columns];
			const [draggedColumn] = nextColumns.splice(draggedIndex, 1);
			let insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
			if (draggedIndex < insertIndex) insertIndex -= 1;
			nextColumns.splice(insertIndex, 0, draggedColumn);
			return { ...current, [selectedEnvironmentId]: nextColumns };
		});
	};

	const onAddTaskColumn = () => {
		if (!selectedEnvironmentId) return;
		setTaskColumnsByEnvironment((current) => {
			const columns = normalizeColumns(current[selectedEnvironmentId] ?? defaultTaskColumns, defaultTaskColumns);
			const used = new Set(columns.map((column) => column.status));
			let nextIndex = columns.length + 1;
			let nextStatus = `column_${nextIndex}`;
			while (used.has(nextStatus)) {
				nextIndex += 1;
				nextStatus = `column_${nextIndex}`;
			}
			return {
				...current,
				[selectedEnvironmentId]: [...columns, { status: nextStatus, label: `Column ${nextIndex}` }],
			};
		});
	};

	const onRemoveTaskColumn = async (status: TaskStatus) => {
		if (!selectedEnvironmentId) return;
		const columns = normalizeColumns(
			taskColumnsByEnvironment[selectedEnvironmentId] ?? defaultTaskColumns,
			defaultTaskColumns,
		);
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
		setTaskColumnsByEnvironment((current) => ({ ...current, [selectedEnvironmentId]: nextColumns }));
		await syncTasksForEnvironment(selectedEnvironmentId);
		setDashboard(await window.atlas.getDashboardOverview(selectedEnvironmentId));
	};

	const onDropInColumn = async (status: TaskStatus) => {
		if (!draggedTaskId || !selectedEnvironmentId) {
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
		const currentOrder = taskOrderByEnvironment[selectedEnvironmentId] ?? tasks.map((task) => task.id);
		const cleanOrder = currentOrder.filter((id) => baseTasks.some((task) => task.id === id));
		const withDraggedAtEnd = cleanOrder.includes(draggedTaskId) ? cleanOrder : [...cleanOrder, draggedTaskId];
		setTaskOrderByEnvironment((current) => ({ ...current, [selectedEnvironmentId]: withDraggedAtEnd }));
		setTasks(sortTasksByOrder(baseTasks, withDraggedAtEnd));
		setDraggedTaskId("");
		setDropStatus(null);
		setDashboard(await window.atlas.getDashboardOverview(selectedEnvironmentId));
	};

	const onDropOnTask = async (targetTask: TaskItem, position: "before" | "after" = "before") => {
		if (!draggedTaskId || !selectedEnvironmentId || draggedTaskId === targetTask.id) {
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
		const nextTasks = tasks.map((task) =>
			task.id === dragged.id ? { ...task, status: targetTask.status } : task,
		);
		const currentOrder = taskOrderByEnvironment[selectedEnvironmentId] ?? tasks.map((task) => task.id);
		const cleanOrder = currentOrder.filter((id) => nextTasks.some((task) => task.id === id));
		const nextOrder = reorderTaskIds(cleanOrder, dragged.id, targetTask.id, position);
		setTaskOrderByEnvironment((current) => ({ ...current, [selectedEnvironmentId]: nextOrder }));
		setTasks(sortTasksByOrder(nextTasks, nextOrder));
		setDraggedTaskId("");
		setDropStatus(null);
		setDashboard(await window.atlas.getDashboardOverview(selectedEnvironmentId));
	};

	const onUpdateTask = async (taskId: string, fields: TaskUpdate) => {
		if (!selectedEnvironmentId) return;
		const updated = await window.atlas.updateTask(taskId, fields);
		setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, ...updated } : task)));
		if ("status" in fields) {
			setDashboard(await window.atlas.getDashboardOverview(selectedEnvironmentId));
		}
	};

	const onDeleteTask = async (taskId: string) => {
		if (!selectedEnvironmentId) return;
		await window.atlas.deleteTask(taskId);
		setTasks((current) => current.filter((task) => task.id !== taskId));
		setTaskOrderByEnvironment((current) => ({
			...current,
			[selectedEnvironmentId]: (current[selectedEnvironmentId] ?? []).filter((id) => id !== taskId),
		}));
		setDashboard(await window.atlas.getDashboardOverview(selectedEnvironmentId));
	};

	// Notebook & actions
	const onUpdateNotebookByEnvironment = async (content: string) => {
		if (!selectedEnvironmentId) return;
		const updated = await window.atlas.updateNotebookByEnvironment(selectedEnvironmentId, content);
		setNotebook(updated);
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

	const onToggleSidebarView = (id: AtlasView) => {
		setHiddenSidebarViews((current) =>
			current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
		);
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
					<div className="mini-controls" ref={miniControlsRef}>
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
						<img src={logo} alt="Atlas" className="h-5 w-5 shrink-0" />
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
						<div className="atlas-welcome-eyebrow">Welcome</div>
						<h1>Create your first environment</h1>
						<p>Set up an environment to start right away.</p>
					</header>

					<section className="atlas-welcome-card">
						<label htmlFor="welcome-map-name">Environment name</label>
						<input
							id="welcome-map-name"
							value={newEnvironmentName}
							onChange={(event) => setNewEnvironmentName(event.target.value)}
							placeholder="e.g. Work, Coding, Gaming"
							autoFocus
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void onCreateEnvironment();
								}
							}}
						/>
						<button className="action-btn atlas-welcome-create" onClick={() => void onCreateEnvironment()}>
							Create environment
						</button>

						<div className="atlas-preset-section">
							<span className="atlas-preset-label">Or start from a preset</span>
							<div className="atlas-preset-grid">
								{ENVIRONMENT_PRESETS.map((preset) => {
									const Icon = getEnvironmentIcon(preset.icon);
									return (
										<button
											key={preset.id}
											type="button"
											className="atlas-preset-chip"
											onClick={() => void onCreatePresetEnvironment(preset)}
										>
											<span
												className="atlas-preset-chip-icon"
												style={{ backgroundColor: `${preset.accent}1f`, color: preset.accent }}
											>
												<Icon className="h-4 w-4" />
											</span>
											<span>{preset.name}</span>
										</button>
									);
								})}
							</div>
						</div>

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
							selectedEnvironmentId={selectedEnvironmentId}
							selectedEnvironmentName={selectedEnvironment?.name ?? "Choose environment"}
							selectedEnvironmentIcon={selectedEnvironment?.icon ?? null}
							selectedEnvironmentAccent={selectedEnvironment?.accent ?? null}
							environments={environments}
							onCreatePresetEnvironment={onCreatePresetEnvironment}
							onUpdateEnvironment={onUpdateEnvironment}
							showEnvironmentMenu={showEnvironmentMenu}
							renameEnvironmentName={renameEnvironmentName}
							newEnvironmentName={newEnvironmentName}
							onToggleEnvironmentMenu={() => setShowEnvironmentMenu((v) => !v)}
							onCloseEnvironmentMenu={() => setShowEnvironmentMenu(false)}
							onSelectEnvironment={onSelectEnvironment}
							onRenameEnvironmentNameChange={setRenameEnvironmentName}
							onNewEnvironmentNameChange={setNewEnvironmentName}
							onCreateEnvironment={onCreateEnvironment}
							onRenameEnvironment={onRenameEnvironment}
							onDeleteEnvironment={onRequestDeleteEnvironment}
							canDeleteEnvironment={
								Boolean(selectedEnvironmentId) && !(activeSession && activeSession.environment_id === selectedEnvironmentId)
							}
							activeSession={activeSession}
							activeElapsed={activeElapsed}
							canStartRecording={Boolean(selectedEnvironmentId)}
							onStartSession={onStartSession}
							onPauseResume={onPauseResume}
							onStopSession={onStopSession}
							onOpenMiniWindow={() => void window.atlas.openMiniWindow()}
							onQuickCapture={() => setCaptureOpen(true)}
						/>
					</div>

					<div className="atlas-sidebar-slot">
						<AtlasSidebar
							primaryViews={primaryViews}
							settingsView={settingsView}
							activeView={view}
							onChangeView={onChangeView}
							hiddenViews={hiddenSidebarViews}
							onToggleView={onToggleSidebarView}
						/>
					</div>

					<div className="atlas-main-slot">
						<AtlasMainContent view={view} errorMessage={errorMessage}>
							<MainContentViews
								view={view}
								dashboard={dashboard}
								activeSession={activeSession}
								activeElapsed={activeElapsed}
								currentAppName={currentAppName}
								selectedEnvironmentName={selectedEnvironment?.name ?? "None"}
								selectedEnvironment={selectedEnvironment}
								isolationAllowlist={isolationAllowlist}
								onChangeEnvironmentIsolationMode={onChangeEnvironmentIsolationMode}
								environments={environments}
								newEnvironmentName={newEnvironmentName}
								onNewEnvironmentNameChange={setNewEnvironmentName}
								onCreateEnvironment={onCreateEnvironment}
								onCreatePresetEnvironment={onCreatePresetEnvironment}
								onUpdateEnvironmentById={onUpdateEnvironmentById}
								onDuplicateEnvironmentById={onDuplicateEnvironmentById}
								onArchiveEnvironmentById={onArchiveEnvironmentById}
								onUnarchiveEnvironmentById={onUnarchiveEnvironmentById}
								onRequestDeleteEnvironmentRow={onRequestDeleteEnvironmentRow}
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
								onUpdateTask={onUpdateTask}
								onDeleteTask={onDeleteTask}
								onRenameTaskColumn={onRenameTaskColumn}
								onReorderTaskColumns={onReorderTaskColumns}
								onAddTaskColumn={onAddTaskColumn}
								onRemoveTaskColumn={onRemoveTaskColumn}
								notebook={notebook}
								onUpdateNotebookByEnvironment={onUpdateNotebookByEnvironment}
								theme={theme}
								onThemeChange={setTheme}
								focus={focus}
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
							<h2>Create your first environment</h2>
							<p>Environments group your sessions, activity, tasks and notes into one context.</p>
							<input
								value={newEnvironmentName}
								onChange={(event) => setNewEnvironmentName(event.target.value)}
								placeholder="e.g. Work, Coding, Gaming"
								autoFocus
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void onCreateEnvironment();
									}
								}}
							/>
							<button className="action-btn" onClick={() => void onCreateEnvironment()}>
								Create
							</button>

							<div className="atlas-preset-section">
								<span className="atlas-preset-label">Or start from a preset</span>
								<div className="atlas-preset-grid">
									{ENVIRONMENT_PRESETS.map((preset) => {
										const Icon = getEnvironmentIcon(preset.icon);
										return (
											<button
												key={preset.id}
												type="button"
												className="atlas-preset-chip"
												onClick={() => void onCreatePresetEnvironment(preset)}
											>
												<span
													className="atlas-preset-chip-icon"
													style={{
														backgroundColor: `${preset.accent}1f`,
														color: preset.accent,
													}}
												>
													<Icon className="h-4 w-4" />
												</span>
												<span>{preset.name}</span>
											</button>
										);
									})}
								</div>
							</div>
						</motion.div>
					</motion.div>
				)}
			</AnimatePresence>

			{hasBootstrapped && !showFirstLaunch && (
				<SmartCapture
					open={captureOpen}
					onClose={() => setCaptureOpen(false)}
					environments={environments}
					currentEnvironmentId={selectedEnvironmentId || null}
					columnsFor={columnsFor}
					onSubmit={onSmartCapture}
					accent={selectedEnvironment?.accent || globalAccent}
				/>
			)}

			<EnvironmentDeleteDialog
				environment={deleteDialogEnvironment}
				onCancel={() => setDeleteDialogEnvironment(null)}
				onConfirmDelete={onConfirmDeleteEnvironmentDialog}
				onArchiveInstead={onArchiveEnvironmentFromDialog}
			/>
		</div>
	);
}

function App() {
	const mode = useMemo(() => new URLSearchParams(window.location.search).get("mode"), []);
	if (mode === "settings") return <SettingsWindowApp />;
	if (mode === "notch") return <NotchApp />;
	if (mode === "actions") return <ActionEditorWindowApp />;
	if (mode === "notch-input") return <NotchInputWindowApp />;
	return <MainAtlasApp />;
}

export default App;
