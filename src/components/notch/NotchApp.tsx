import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
	CheckIcon,
	ClockIcon,
	ListBulletIcon,
	LockClosedIcon,
	LockOpenIcon,
	NewspaperIcon,
	Squares2X2Icon,
	StopIcon,
} from "@heroicons/react/24/outline";
import type {
	AtlasView,
	MapItem,
	NotchActionButtonId,
	NotchPosition,
	NotchPreferences,
	Session,
	TaskColumn,
	TaskItem,
} from "../../types";
import { useAccent } from "../../hooks";
import { formatClock, normalizeColumns, readStorage, sessionElapsedMs, sortTasksByOrder } from "../../utils";
import { TASK_COLUMNS_KEY, TASK_ORDER_KEY, THEME_KEY, defaultTaskColumns } from "../../constants";

// How often to re-poll for environment/task changes made in another window,
// since there's no IPC broadcast for those.
const POLL_MS = 1500;

// How much of the card stays visible (the accent line plus a sliver of background)
// when it's retracted out of view.
const PEEK_PX = 16;

const navItems: Array<{ id: NotchActionButtonId; label: string; icon: typeof ClockIcon }> = [
	{ id: "activity", label: "Activity", icon: ClockIcon },
	{ id: "dashboard", label: "Dashboard", icon: Squares2X2Icon },
	{ id: "notes", label: "Notes", icon: NewspaperIcon },
	{ id: "tasks", label: "Tasks", icon: ListBulletIcon },
];

const lastEnvironmentId = () => {
	try {
		return localStorage.getItem("atlas.lastEnvironmentId");
	} catch {
		return null;
	}
};

const ROOT_POSITION_CLASSES: Record<NotchPosition, string> = {
	top: "items-start justify-center",
	left: "items-center justify-start",
	right: "items-center justify-end",
	free: "items-start justify-center p-1.5",
};

// Box is a fixed 40px on its short axis with a 20px corner radius, sized to match
// the old floating mini-timer's proportions; the squared/borderless side always
// faces the screen edge it's docked against.
const CARD_POSITION_CLASSES: Record<NotchPosition, string> = {
	top: "flex-col justify-between h-fit pt-2.5 pr-3.75 pb-1.25 pl-3.75 rounded-t-none rounded-b-[20px] border-t-0",
	left: "flex-row justify-between w-fit pt-3.75 pr-1.25 pb-3.75 pl-2.5 rounded-l-none rounded-r-[20px] border-l-0",
	right: "flex-row justify-between w-fit pt-3.75 pr-2.5 pb-3.75 pl-1.25 rounded-r-none rounded-l-[20px] border-r-0",
	free: "flex-col justify-between h-fit pt-2.5 pr-3.75 pb-1.25 pl-3.75 rounded-[20px]",
};

const ICON_BUTTON_CLASSES =
	"inline-flex shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-neutral-0";

export function NotchApp() {
	const { accent: globalAccent } = useAccent();
	const cardRef = useRef<HTMLDivElement | null>(null);

	const [preferences, setPreferences] = useState<NotchPreferences>({
		enabled: true,
		position: "top",
		x: null,
		y: null,
		idleOpacity: "balanced",
		locked: false,
		activation: "always",
		displayIds: [],
		actionButtons: navItems.map((item) => ({ id: item.id, enabled: true })),
		infoItems: [
			{ id: "timer", enabled: true },
			{ id: "todo", enabled: true },
		],
	});
	const [environments, setEnvironments] = useState<MapItem[]>([]);
	const [activeEnvId, setActiveEnvId] = useState<string | null>(() => lastEnvironmentId());
	const [tasks, setTasks] = useState<TaskItem[]>([]);
	const [activeSession, setActiveSession] = useState<Session | null>(null);
	const [now, setNow] = useState(Date.now());
	const [hovered, setHovered] = useState(false);
	const [size, setSize] = useState({ width: 0, height: 0 });

	// Transparent backdrop for the floating window; follow the app's light/dark theme.
	useEffect(() => {
		const html = document.documentElement;
		html.dataset.notchMode = "true";

		const applyTheme = () => {
			const stored = readStorage<"dark" | "light" | "system">(THEME_KEY, "light");
			const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
			const resolved = stored === "system" ? (prefersDark ? "dark" : "light") : stored;
			html.classList.toggle("dark", resolved === "dark");
		};
		applyTheme();

		const media = window.matchMedia("(prefers-color-scheme: dark)");
		media.addEventListener("change", applyTheme);
		window.addEventListener("storage", applyTheme);
		return () => {
			delete html.dataset.notchMode;
			media.removeEventListener("change", applyTheme);
			window.removeEventListener("storage", applyTheme);
		};
	}, []);

	// Preferences + live updates from settings.
	useEffect(() => {
		window.atlas
			.getNotchPreferences()
			.then(setPreferences)
			.catch(() => undefined);
		const unsubscribe = window.atlas.onNotchPreferencesChanged?.(setPreferences);
		return () => unsubscribe?.();
	}, []);

	// Environments, so the notch can show which one is active. Polled since there's
	// no IPC broadcast for renames/recolors/creates/deletes made in another window.
	useEffect(() => {
		const sync = () => {
			window.atlas
				.listMaps()
				.then(setEnvironments)
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, POLL_MS);
		return () => window.clearInterval(interval);
	}, []);

	// Track which environment is active; storage events fire as soon as another
	// window switches it, with a poll as a fallback.
	useEffect(() => {
		const sync = () => setActiveEnvId(lastEnvironmentId());
		window.addEventListener("storage", sync);
		const interval = window.setInterval(sync, POLL_MS);
		return () => {
			window.removeEventListener("storage", sync);
			window.clearInterval(interval);
		};
	}, []);

	// The active environment's tasks, for the "first to-do" information item.
	useEffect(() => {
		if (!activeEnvId) {
			setTasks([]);
			return;
		}
		const sync = () => {
			window.atlas
				.listTasksByMap(activeEnvId)
				.then(setTasks)
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, POLL_MS);
		return () => window.clearInterval(interval);
	}, [activeEnvId]);

	// The active session, for the "timer" information item.
	useEffect(() => {
		const sync = () => {
			window.atlas
				.getActiveSession()
				.then(setActiveSession)
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, 1000);
		return () => window.clearInterval(interval);
	}, []);

	// Tick the clock while a session runs.
	useEffect(() => {
		const interval = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(interval);
	}, []);

	// Keep the OS window sized to the content. offsetWidth/offsetHeight reflect the
	// element's untransformed layout box, so this stays stable while the card slides.
	useEffect(() => {
		const node = cardRef.current;
		if (!node) return;
		const report = () => {
			const width = node.offsetWidth;
			const height = node.offsetHeight;
			setSize({ width, height });
			void window.atlas.resizeNotch(width + 16, height + 16);
		};
		report();
		const observer = new ResizeObserver(report);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	const isFree = preferences.position === "free";
	const isVertical = preferences.position === "left" || preferences.position === "right";

	const environment = useMemo(() => {
		const targetId = activeEnvId ?? environments[0]?.id;
		return environments.find((env) => env.id === targetId) ?? environments[0] ?? null;
	}, [environments, activeEnvId]);

	const accent = environment?.accent || globalAccent;

	const enabledNavItems = useMemo(() => {
		return preferences.actionButtons
			.filter((button) => button.enabled)
			.map((button) => navItems.find((item) => item.id === button.id))
			.filter((item): item is (typeof navItems)[number] => Boolean(item));
	}, [preferences.actionButtons]);

	// The leftmost/first task column is treated as "to do"; the second is where
	// the check button moves a task to.
	const { secondColumn, firstTodo } = useMemo(() => {
		if (!environment?.id) {
			return { secondColumn: null as TaskColumn | null, firstTodo: null as TaskItem | null };
		}
		const columnsByMap = readStorage<Record<string, TaskColumn[]>>(TASK_COLUMNS_KEY, {});
		const columns = normalizeColumns(columnsByMap[environment.id] ?? defaultTaskColumns, defaultTaskColumns);
		const first = columns[0] ?? null;
		const second = columns[1] ?? null;
		if (!first) {
			return { secondColumn: second, firstTodo: null as TaskItem | null };
		}
		const orderByMap = readStorage<Record<string, string[]>>(TASK_ORDER_KEY, {});
		const order = orderByMap[environment.id] ?? [];
		const columnTasks = tasks.filter((task) => task.status === first.status);
		const sorted = sortTasksByOrder(columnTasks, order);
		return { secondColumn: second, firstTodo: sorted[0] ?? null };
	}, [tasks, environment?.id]);

	// The single information slot: the first enabled item (in priority order)
	// that actually has something to show right now.
	const activeInfoItem = useMemo(() => {
		for (const item of preferences.infoItems) {
			if (!item.enabled) continue;
			if (item.id === "timer" && activeSession) return "timer" as const;
			if (item.id === "todo" && firstTodo) return "todo" as const;
		}
		return null;
	}, [preferences.infoItems, activeSession, firstTodo]);

	// Retract toward the docked edge, leaving only a peek of the far edge visible;
	// hovering drops it back into full view. Free-floating never retracts.
	const collapseTarget = useMemo(() => {
		if (isFree) return { x: 0, y: 0 };
		if (preferences.position === "left") return { x: -Math.max(size.width - PEEK_PX, 0), y: 0 };
		if (preferences.position === "right") return { x: Math.max(size.width - PEEK_PX, 0), y: 0 };
		return { x: 0, y: -Math.max(size.height - PEEK_PX, 0) };
	}, [isFree, preferences.position, size.height, size.width]);

	const isExpanded = isFree || hovered || preferences.locked;

	const onNavigate = (view: AtlasView) => {
		void window.atlas.requestNavigate(view);
	};

	const onToggleLock = () => {
		void window.atlas.setNotchPreferences({ locked: !preferences.locked });
	};

	const onStopTimer = async () => {
		if (!activeSession) return;
		await window.atlas.stopSession(activeSession.id);
		setActiveSession(null);
	};

	const onAdvanceTodo = async () => {
		if (!firstTodo || !secondColumn) return;
		const taskId = firstTodo.id;
		const nextStatus = secondColumn.status;
		await window.atlas.updateTaskStatus(taskId, nextStatus);
		setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, status: nextStatus } : task)));
	};

	return (
		<div
			className={`flex h-screen w-screen overflow-hidden bg-transparent ${ROOT_POSITION_CLASSES[preferences.position]}`}
		>
			<motion.div
				ref={cardRef}
				className={`atlas-notch-card relative flex min-w-0 gap-2 cursor-default select-none overflow-hidden border border-neutral-200 bg-neutral-0 text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-50 ${CARD_POSITION_CLASSES[preferences.position]} ${
					isFree && !preferences.locked ? "notch-drag" : ""
				}`}
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
				initial={false}
				animate={isExpanded ? { x: 0, y: 0 } : { x: collapseTarget.x, y: collapseTarget.y }}
				transition={isExpanded ? { duration: 0.25, ease: "easeOut" } : { duration: 0.5, ease: "easeInOut" }}
			>
				<div
					className={`notch-no-drag flex items-center gap-4 whitespace-nowrap ${isVertical ? "flex-col py-3" : "flex-row px-3"}`}
				>
					{activeInfoItem ? (
						<>
							<div
								className={`notch-no-drag flex items-center gap-1.5 whitespace-nowrap ${isVertical ? "flex-col" : "flex-row"}`}
							>
								{activeInfoItem === "timer" && activeSession ? (
									<>
										<span className="font-data text-[12px] text-neutral-700 dark:text-neutral-100">
											{formatClock(sessionElapsedMs(activeSession, now))}
										</span>
										<button
											type="button"
											className={`${ICON_BUTTON_CLASSES} h-6 w-6`}
											title="Stop timer"
											aria-label="Stop timer"
											onClick={() => void onStopTimer()}
										>
											<StopIcon className="h-4 w-4" />
										</button>
									</>
								) : null}
								{activeInfoItem === "todo" && firstTodo ? (
									<>
										<span className="max-w-28 truncate text-[12px] font-medium text-neutral-700 dark:text-neutral-100">
											{firstTodo.title}
										</span>
										<button
											type="button"
											className={`${ICON_BUTTON_CLASSES} h-6 w-6 disabled:cursor-not-allowed disabled:opacity-40`}
											title="Move to next column"
											aria-label="Move to next column"
											disabled={!secondColumn}
											onClick={() => void onAdvanceTodo()}
										>
											<CheckIcon className="h-4 w-4" />
										</button>
									</>
								) : null}
							</div>

							<span
								className={`flex-shrink-0 bg-neutral-200 dark:bg-neutral-600 ${
									isVertical ? "my-0.5 h-px w-4" : "mx-0.5 h-4 w-px"
								}`}
							/>
						</>
					) : null}

					<div
						className={`notch-no-drag flex items-center gap-2.5 whitespace-nowrap ${isVertical ? "flex-col" : "flex-row"}`}
					>
						{enabledNavItems.map((item) => {
							const Icon = item.icon;
							return (
								<button
									key={item.id}
									type="button"
									className={`${ICON_BUTTON_CLASSES} h-7 w-7`}
									title={item.label}
									aria-label={item.label}
									onClick={() => onNavigate(item.id)}
								>
									<Icon className="h-5 w-5" />
								</button>
							);
						})}
					</div>

					<span
						className={`flex-shrink-0 bg-neutral-200 dark:bg-neutral-600 ${
							isVertical ? "my-0.5 h-px w-4" : "mx-0.5 h-4 w-px"
						}`}
					/>
					<div
						className={`notch-no-drag flex items-center gap-2.5 whitespace-nowrap ${isVertical ? "flex-col" : "flex-row"}`}
					>
						<div
							className={`inline-flex max-w-28 cursor-pointer items-center justify-center overflow-hidden rounded-lg border px-3.5 py-0.5 text-[12px] font-semibold text-ellipsis whitespace-nowrap ${
								isVertical
									? `max-h-28 max-w-none px-0.5 py-1.5 [text-orientation:mixed] [writing-mode:vertical-rl] ${
											preferences.position === "left" ? "rotate-180" : ""
										}`
									: ""
							}`}
							role="button"
							title={environment?.name ?? "No environment"}
							onClick={() => void window.atlas.focusMainIfOpen()}
						>
							{environment?.name ?? "Atlas"}
						</div>

						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-7 w-7`}
							title={preferences.locked ? "Unlock position" : "Lock position"}
							aria-label={preferences.locked ? "Unlock position" : "Lock position"}
							onClick={onToggleLock}
						>
							{preferences.locked ? (
								<LockClosedIcon className="w-5 h-5" />
							) : (
								<LockOpenIcon className="w-5 h-5" />
							)}
						</button>
					</div>
				</div>

				<div
					className={`shrink-0 rounded-2xl ${isVertical ? "self-stretch w-px" : "h-px w-full"} ${isExpanded ? "hidden" : ""}`}
					style={{ backgroundColor: accent }}
				/>
			</motion.div>
		</div>
	);
}
