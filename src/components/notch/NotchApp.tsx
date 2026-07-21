/* eslint-disable react-hooks/set-state-in-effect, react-hooks/preserve-manual-memoization --
   The notch mirrors external sources (the DB via IPC, system stats, localStorage) into
   local state through polling effects, and intentionally resets that state synchronously
   when the active environment clears; it also memoizes derived task data keyed on the
   stable environment id rather than the object identity that changes every poll. These
   are deliberate external-sync patterns that the React Compiler's advisory rules don't
   model, so they're disabled for this file only. */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
	AcademicCapIcon,
	AdjustmentsHorizontalIcon,
	ArchiveBoxIcon,
	ArrowPathIcon,
	ArrowUpOnSquareStackIcon,
	BeakerIcon,
	BellIcon,
	BoltIcon,
	BookOpenIcon,
	BriefcaseIcon,
	CalendarIcon,
	CameraIcon,
	ChartBarIcon,
	ChatBubbleLeftIcon,
	CheckCircleIcon,
	CheckIcon,
	ClipboardIcon,
	ClockIcon,
	CloudIcon,
	CodeBracketIcon,
	Cog6ToothIcon,
	CommandLineIcon,
	CpuChipIcon,
	CreditCardIcon,
	CubeIcon,
	DocumentTextIcon,
	EnvelopeIcon,
	FaceSmileIcon,
	FilmIcon,
	FireIcon,
	FlagIcon,
	FolderIcon,
	GiftIcon,
	GlobeAltIcon,
	HeartIcon,
	HomeIcon,
	InboxIcon,
	KeyIcon,
	LightBulbIcon,
	ListBulletIcon,
	LockOpenIcon,
	MapIcon,
	MegaphoneIcon,
	MinusIcon,
	MoonIcon,
	MusicalNoteIcon,
	NewspaperIcon,
	PaintBrushIcon,
	PaperAirplaneIcon,
	PauseIcon,
	PencilIcon,
	PencilSquareIcon,
	PhotoIcon,
	PlayCircleIcon,
	PlayIcon,
	PlusIcon,
	PuzzlePieceIcon,
	RocketLaunchIcon,
	ShieldCheckIcon,
	ShoppingCartIcon,
	SparklesIcon,
	Squares2X2Icon,
	StarIcon,
	StopIcon,
	SunIcon,
	TagIcon,
	TrashIcon,
	TrophyIcon,
	UserIcon,
	VideoCameraIcon,
	WifiIcon,
	WrenchIcon,
} from "@heroicons/react/24/outline";
import { LockClosedIcon as LockClosedIconSolid, PlayCircleIcon as PlayCircleIconSolid } from "@heroicons/react/24/solid";
import * as HeroIconsSolid from "@heroicons/react/24/solid";
import type {
	DashboardOverview,
	Environment,
	NoteItem,
	NotchPosition,
	NotchPreferences,
	NotchTabIcon,
	NotchWidgetId,
	NotchWidgetPlacement,
	Session,
	TaskColumn,
	TaskItem,
} from "../../types";
import { useAccent, useFocus, FOCUS_PHASE_LABELS } from "../../hooks";
import {
	formatClock,
	formatDuration,
	normalizeColumns,
	normalizeTrackedAppName,
	readStorage,
	sessionElapsedMs,
	sortTasksByOrder,
} from "../../utils";
import { TASK_COLUMNS_KEY, TASK_ORDER_KEY, THEME_KEY, defaultTaskColumns } from "../../constants";
import { parseSceneConfig, type NotchSceneConfig } from "../../scenes";
import { PRIORITY_META } from "../main-content/taskMeta";

// How often to re-poll for environment/task/dashboard changes made in another
// window, since there's no IPC broadcast for those.
const POLL_MS = 1500;

// How much of the card stays visible (the accent line plus a sliver of background)
// when it's retracted out of view.
const PEEK_PX = 16;

// Matches tailwind's w-10/h-10 (grid cell) and gap-1.5 (gutter), so a tab's
// grid renders identically here and in the settings editor.
const GRID_CELL_PX = 40;
const GRID_GAP_PX = 6;

// Object shorthand works because each NotchTabIcon value is exactly the
// imported heroicon's component name.
const TAB_ICON_MAP: Record<NotchTabIcon, typeof ClockIcon> = {
	AcademicCapIcon,
	AdjustmentsHorizontalIcon,
	ArchiveBoxIcon,
	ArrowPathIcon,
	BeakerIcon,
	BellIcon,
	BoltIcon,
	BookOpenIcon,
	BriefcaseIcon,
	CalendarIcon,
	CameraIcon,
	ChartBarIcon,
	ChatBubbleLeftIcon,
	CheckCircleIcon,
	ClipboardIcon,
	ClockIcon,
	CloudIcon,
	CodeBracketIcon,
	Cog6ToothIcon,
	CommandLineIcon,
	CpuChipIcon,
	CreditCardIcon,
	CubeIcon,
	DocumentTextIcon,
	EnvelopeIcon,
	FaceSmileIcon,
	FilmIcon,
	FireIcon,
	FlagIcon,
	FolderIcon,
	GiftIcon,
	GlobeAltIcon,
	HeartIcon,
	HomeIcon,
	InboxIcon,
	KeyIcon,
	LightBulbIcon,
	ListBulletIcon,
	MapIcon,
	MegaphoneIcon,
	MoonIcon,
	MusicalNoteIcon,
	NewspaperIcon,
	PaintBrushIcon,
	PaperAirplaneIcon,
	PencilIcon,
	PhotoIcon,
	PlayIcon,
	PuzzlePieceIcon,
	RocketLaunchIcon,
	ShieldCheckIcon,
	ShoppingCartIcon,
	SparklesIcon,
	Squares2X2Icon,
	StarIcon,
	SunIcon,
	TagIcon,
	TrashIcon,
	TrophyIcon,
	UserIcon,
	VideoCameraIcon,
	WifiIcon,
	WrenchIcon,
};

// Filled counterparts of the same icons, used to mark a tab as active
// without changing its color (no bg highlight, just outline -> solid).
const TAB_ICON_SOLID_MAP = HeroIconsSolid as unknown as Record<NotchTabIcon, typeof ClockIcon>;

const isSameDay = (iso: string, reference: Date) => {
	const d = new Date(iso);
	return (
		d.getFullYear() === reference.getFullYear() &&
		d.getMonth() === reference.getMonth() &&
		d.getDate() === reference.getDate()
	);
};

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

// The wrapper holds the card plus, when a tab panel is open, the detached
// panel beside/below it with a gap: stacked vertically under the card for
// the horizontal (top/free) notch, stacked beside it on the inward side
// (away from the docked screen edge) for the vertical (left/right) notch.
const WRAPPER_POSITION_CLASSES: Record<NotchPosition, string> = {
	top: "flex-col items-center",
	left: "flex-row items-center",
	right: "flex-row-reverse items-center",
	free: "flex-col items-center",
};

// Box is a fixed 40px on its short axis with a 20px corner radius, sized to match
// the old floating mini-timer's proportions; the squared/borderless side always
// faces the screen edge it's docked against.
const CARD_POSITION_CLASSES: Record<NotchPosition, string> = {
	top: "flex-col justify-between h-fit pt-2.5 pr-3.75 pb-1.25 pl-3.75 rounded-t-none rounded-b-[20px] border-t-0",
	left: "flex-row justify-between w-fit pt-3.75 pr-1.25 pb-3.75 pl-2.5 rounded-l-none rounded-r-[20px] border-l-0",
	right:
		"flex-row justify-between w-fit pt-3.75 pr-2.5 pb-3.75 pl-1.25 rounded-r-none rounded-l-[20px] border-r-0",
	free: "flex-col justify-between h-fit pt-2.5 pr-3.75 pb-1.25 pl-3.75 rounded-[20px]",
};

// Shared by every plain icon button in the notch - bar buttons and widget
// buttons alike - just a color shift on hover, no rounded background.
const ICON_BUTTON_CLASSES =
	"inline-flex shrink-0 items-center justify-center text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-300 dark:hover:text-neutral-0";

// Every placed widget gets the same outlined card so the grid reads as one
// consistent set of tiles instead of ad-hoc per-widget framing. Structural
// widgets (divider/spacer) opt out since they're meant to blend in.
const WIDGET_CARD_CLASSES =
	"h-full w-full rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 text-neutral-700 transition-colors hover:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-100 dark:hover:border-neutral-400";
const WIDGETS_WITHOUT_CARD = new Set<NotchWidgetId>(["divider", "spacer"]);

// Simple "icon button that does X" widgets all share one renderer; none of
// these close over component state, so the table lives at module scope.
const NAV_ACTIONS: Partial<
	Record<NotchWidgetId, { icon: typeof ClockIcon; title: string; onClick: () => void }>
> = {
	openDashboardButton: {
		icon: Squares2X2Icon,
		title: "Dashboard",
		onClick: () => {
			void window.atlas.focusMainIfOpen();
			void window.atlas.requestNavigate("dashboard");
		},
	},
	openActivityButton: {
		icon: ClockIcon,
		title: "Activity",
		onClick: () => {
			void window.atlas.focusMainIfOpen();
			void window.atlas.requestNavigate("activity");
		},
	},
	openTasksButton: {
		icon: ListBulletIcon,
		title: "Tasks",
		onClick: () => {
			void window.atlas.focusMainIfOpen();
			void window.atlas.requestNavigate("tasks");
		},
	},
	openNotesButton: {
		icon: NewspaperIcon,
		title: "Notes",
		onClick: () => {
			void window.atlas.focusMainIfOpen();
			void window.atlas.requestNavigate("notes");
		},
	},
	openFocusButton: {
		icon: BoltIcon,
		title: "Focus",
		onClick: () => {
			void window.atlas.focusMainIfOpen();
			void window.atlas.requestNavigate("focus");
		},
	},
	openSettingsButton: {
		icon: Cog6ToothIcon,
		title: "Settings",
		onClick: () => void window.atlas.openSettingsWindow(),
	},
	openMiniPlayerButton: {
		icon: ArrowUpOnSquareStackIcon,
		title: "Mini player",
		onClick: () => void window.atlas.openMiniWindow(),
	},
	minimizeButton: {
		icon: MinusIcon,
		title: "Minimize",
		onClick: () => void window.atlas.windowMinimize(),
	},
	focusMainButton: {
		icon: HomeIcon,
		title: "Open Atlas",
		onClick: () => void window.atlas.focusMainIfOpen(),
	},
};

export function NotchApp() {
	const { accent: globalAccent } = useAccent();
	const cardRef = useRef<HTMLDivElement | null>(null);
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	// Last click-through state pushed to the main process, so we only send an IPC
	// message when it actually flips rather than on every pointer move.
	const ignoreMouseRef = useRef(false);

	const [preferences, setPreferences] = useState<NotchPreferences>({
		enabled: true,
		position: "top",
		x: null,
		y: null,
		idleOpacity: "balanced",
		locked: false,
		activation: "always",
		displayIds: [],
		tabs: [
			{
				id: "timer",
				label: "Timer",
				icon: "ClockIcon",
				gridCols: 5,
				gridRows: 1,
				placements: [
					{ id: "start-stop", widget: "timerStartStop", x: 0, y: 0, w: 1, h: 1 },
					{ id: "display", widget: "timerDisplay", x: 1, y: 0, w: 2, h: 1 },
				],
			},
			{
				id: "time",
				label: "Time",
				icon: "ChartBarIcon",
				gridCols: 5,
				gridRows: 4,
				placements: [
					{ id: "time-spent", widget: "timeSpentToday", x: 0, y: 0, w: 5, h: 2 },
					{ id: "top-app", widget: "topApp", x: 0, y: 2, w: 3, h: 2 },
				],
			},
			{
				id: "tasks",
				label: "Tasks",
				icon: "ListBulletIcon",
				gridCols: 5,
				gridRows: 3,
				placements: [{ id: "first-todos", widget: "firstTodoList", x: 0, y: 0, w: 3, h: 3 }],
			},
			{
				id: "notes",
				label: "Notes",
				icon: "NewspaperIcon",
				gridCols: 5,
				gridRows: 2,
				placements: [{ id: "notes-count", widget: "notesCount", x: 0, y: 0, w: 3, h: 1 }],
			},
		],
		infoItems: [
			{ id: "timer", enabled: true },
			{ id: "todo", enabled: true },
		],
	});
	const [environments, setEnvironments] = useState<Environment[]>([]);
	const [activeEnvId, setActiveEnvId] = useState<string | null>(() => lastEnvironmentId());
	const [tasks, setTasks] = useState<TaskItem[]>([]);
	const [activeSession, setActiveSession] = useState<Session | null>(null);
	const [dashboard, setDashboard] = useState<DashboardOverview | null>(null);
	const [todaySessions, setTodaySessions] = useState<Session[]>([]);
	const [now, setNow] = useState(() => Date.now());
	const focus = useFocus(now);
	const [hovered, setHovered] = useState(false);
	// Card's own size (for the docked retract distance) vs. the wrapper's size
	// (card + open panel + gap, for sizing the OS window) are tracked separately
	// since the panel must not affect how far the bare card retracts.
	const [cardSize, setCardSize] = useState({ width: 0, height: 0 });
	const [activeTabId, setActiveTabId] = useState<string | null>(null);
	const [totalSessionCount, setTotalSessionCount] = useState(0);
	const [notes, setNotes] = useState<NoteItem[]>([]);
	const [currentAppName, setCurrentAppName] = useState("");
	const [platform, setPlatform] = useState("");
	const [appVersion, setAppVersion] = useState("");
	const [hasUpdate, setHasUpdate] = useState(false);
	const [themeValue, setThemeValue] = useState<"dark" | "light" | "system">(() =>
		readStorage(THEME_KEY, "light"),
	);
	// The plain resolved (light/dark) theme, before any environment override --
	// tracked as its own state (rather than writing the DOM class straight out
	// of `applyTheme`/`onToggleTheme`) so the environment-override effect below
	// has a single, current value to layer on top of. See that effect's
	// comment for why (WP-1.4).
	const [baseResolvedTheme, setBaseResolvedTheme] = useState<"dark" | "light">("light");
	// WP-1.4: this environment's own theme override, if it has one. Applied on
	// top of `baseResolvedTheme` without ever touching localStorage/THEME_KEY
	// -- exactly like App.tsx's identical layering -- so a "system"
	// (no-opinion) environment can't get stuck on a previous environment's
	// override.
	const [environmentThemeOverride, setEnvironmentThemeOverride] = useState<"light" | "dark" | null>(null);
	const [systemStats, setSystemStats] = useState({ cpuPercent: 0, memoryPercent: 0 });
	const [cpuHistory, setCpuHistory] = useState<number[]>([]);
	const [memoryHistory, setMemoryHistory] = useState<number[]>([]);
	const [runningApps, setRunningApps] = useState<Array<{ name: string; path: string | null }>>([]);
	const [appIcons, setAppIcons] = useState<Record<string, string | null>>({});

	// Transparent backdrop for the floating window; follow the app's light/dark theme.
	useEffect(() => {
		const html = document.documentElement;
		html.dataset.notchMode = "true";

		const applyTheme = () => {
			const stored = readStorage<"dark" | "light" | "system">(THEME_KEY, "light");
			setThemeValue(stored);
			const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
			const resolved = stored === "system" ? (prefersDark ? "dark" : "light") : stored;
			// Recorded rather than written straight to the DOM: the effect below
			// layers any environment override on top of this, and needs a single
			// current value to fall back to when the override clears (WP-1.4).
			setBaseResolvedTheme(resolved);
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

	// Populated by the `environment:activated` broadcast (main.cjs's
	// setActiveEnvironment), which fires from every switch surface -- this
	// notch's own switcher, the main window, and the global hotkey -- since all
	// three funnel through the same `environment:switch` IPC call (WP-1.4).
	useEffect(() => {
		const unsubscribe = window.atlas.onEnvironmentActivated?.((bundle) => {
			const nextTheme = bundle?.appearance?.theme;
			setEnvironmentThemeOverride(nextTheme === "light" || nextTheme === "dark" ? nextTheme : null);
		});
		return () => unsubscribe?.();
	}, []);

	// The environment's override wins when it has one; otherwise the ordinary
	// resolved theme applies. Deliberately never writes THEME_KEY, so switching
	// to a "system" (no-opinion) environment falls back cleanly instead of
	// inheriting whatever the previous environment overrode to.
	useEffect(() => {
		const effectiveTheme = environmentThemeOverride ?? baseResolvedTheme;
		document.documentElement.classList.toggle("dark", effectiveTheme === "dark");
	}, [environmentThemeOverride, baseResolvedTheme]);

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
				.listEnvironments()
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
				.listTasksByEnvironment(activeEnvId)
				.then(setTasks)
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, POLL_MS);
		return () => window.clearInterval(interval);
	}, [activeEnvId]);

	// The active environment's dashboard overview, for the "time spent today"
	// and "top app" widgets.
	useEffect(() => {
		if (!activeEnvId) {
			setDashboard(null);
			return;
		}
		const sync = () => {
			window.atlas
				.getDashboardOverview(activeEnvId)
				.then(setDashboard)
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, POLL_MS);
		return () => window.clearInterval(interval);
	}, [activeEnvId]);

	// Today's sessions for the active environment, for the "time spent today"
	// activity bar.
	useEffect(() => {
		if (!activeEnvId) {
			setTodaySessions([]);
			setTotalSessionCount(0);
			return;
		}
		const sync = () => {
			window.atlas
				.listSessionsByEnvironment(activeEnvId)
				.then((sessions) => {
					const today = new Date();
					setTodaySessions(sessions.filter((session) => isSameDay(session.started_at, today)));
					setTotalSessionCount(sessions.length);
				})
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, POLL_MS);
		return () => window.clearInterval(interval);
	}, [activeEnvId]);

	// CPU/memory usage, for the "system" widgets — polled at the same cadence
	// as everything else, with a short rolling history for the graph widgets.
	useEffect(() => {
		const sync = () => {
			window.atlas
				.getSystemStats()
				.then((stats) => {
					setSystemStats(stats);
					setCpuHistory((current) => [...current, stats.cpuPercent].slice(-20));
					setMemoryHistory((current) => [...current, stats.memoryPercent].slice(-20));
				})
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, POLL_MS);
		return () => window.clearInterval(interval);
	}, []);

	// Currently running apps, for the "top app" widget's open/focus action.
	useEffect(() => {
		const sync = () => {
			window.atlas
				.listOpenApps()
				.then(setRunningApps)
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, POLL_MS);
		return () => window.clearInterval(interval);
	}, []);

	// Real app icons for configured "launch app" buttons, fetched once per
	// distinct command and cached — the placeholder rocket only shows up
	// while a button has no program configured yet.
	useEffect(() => {
		const commands = new Set<string>();
		for (const tab of preferences.tabs) {
			for (const placement of tab.placements) {
				if (placement.widget === "launchAppButton" && placement.config) commands.add(placement.config);
			}
		}
		const missing = [...commands].filter((command) => !(command in appIcons));
		if (missing.length === 0) return;
		for (const command of missing) {
			window.atlas
				.getFileIcon(command)
				.then((icon) => setAppIcons((current) => ({ ...current, [command]: icon })))
				.catch(() => setAppIcons((current) => ({ ...current, [command]: null })));
		}
	}, [preferences.tabs, appIcons]);

	// The active environment's notes, for the "notes count"/"last note" widgets.
	useEffect(() => {
		if (!activeEnvId) {
			setNotes([]);
			return;
		}
		const sync = () => {
			window.atlas
				.listNotesByEnvironment(activeEnvId)
				.then(setNotes)
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, POLL_MS);
		return () => window.clearInterval(interval);
	}, [activeEnvId]);

	// The foreground app name, for the "current app" widget.
	useEffect(() => {
		const sync = () => {
			window.atlas
				.getCurrentApp()
				.then(setCurrentAppName)
				.catch(() => undefined);
		};
		sync();
		const interval = window.setInterval(sync, POLL_MS);
		return () => window.clearInterval(interval);
	}, []);

	// Platform/version/update-available are effectively static for the life of
	// the window, so these only need to be fetched once.
	useEffect(() => {
		window.atlas
			.getPlatform()
			.then(setPlatform)
			.catch(() => undefined);
		window.atlas
			.getAppVersion()
			.then(setAppVersion)
			.catch(() => undefined);
		window.atlas
			.checkForUpdates()
			.then((result) => setHasUpdate(result.hasUpdate))
			.catch(() => undefined);
	}, []);

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

	// Track the bare card's own size (for the docked retract distance).
	// offsetWidth/offsetHeight reflect the element's untransformed layout box,
	// so this stays stable while the card slides.
	useEffect(() => {
		const node = cardRef.current;
		if (!node) return;
		const report = () => setCardSize({ width: node.offsetWidth, height: node.offsetHeight });
		report();
		const observer = new ResizeObserver(report);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	// Keep the OS window sized to the card plus any open tab panel.
	useEffect(() => {
		const node = wrapperRef.current;
		if (!node) return;
		const report = () => {
			void window.atlas.resizeNotch(node.offsetWidth + 16, node.offsetHeight + 16);
		};
		report();
		const observer = new ResizeObserver(report);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	// Close any open tab panel when the notch window loses focus (the user
	// clicked elsewhere — another app, the desktop, the main window).
	useEffect(() => {
		const unsubscribe = window.atlas.onNotchBlur?.(() => setActiveTabId(null));
		return () => unsubscribe?.();
	}, []);

	// Click-through hitbox: the notch window is always sized to the card's full
	// (expanded) footprint, so when the card retracts or the pointer sits over the
	// transparent margins the empty window would otherwise swallow clicks and
	// obscure the view. We forward pointer moves from the main process and toggle
	// mouse-transparency based on whether the pointer is genuinely over the painted
	// card/panel — so a hidden notch is fully click-through, yet re-hovering its
	// visible peek instantly makes it interactive again. A free-floating notch is
	// always kept interactive so it stays grabbable.
	const positionForHitbox = preferences.position;
	useEffect(() => {
		const setIgnore = (ignore: boolean) => {
			if (ignoreMouseRef.current === ignore) return;
			ignoreMouseRef.current = ignore;
			void window.atlas.setNotchIgnoreMouse?.(ignore);
		};

		if (positionForHitbox === "free") {
			setIgnore(false);
			return;
		}

		// Default to pass-through until the pointer is shown to be over the card.
		setIgnore(true);

		const overSolid = (x: number, y: number) => {
			const el = document.elementFromPoint(x, y);
			return Boolean(el && (cardRef.current?.contains(el) || panelRef.current?.contains(el)));
		};
		// `mousemove` is what Electron forwards to the renderer while the window is
		// click-through (forward: true), so it fires even over the pass-through
		// zones — letting us flip interactivity back on the instant the pointer
		// reaches the visible card/panel.
		const onMove = (event: MouseEvent) => setIgnore(!overSolid(event.clientX, event.clientY));
		const onLeave = () => setIgnore(true);

		window.addEventListener("mousemove", onMove);
		document.addEventListener("mouseleave", onLeave);
		return () => {
			window.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseleave", onLeave);
		};
	}, [positionForHitbox]);

	const isFree = preferences.position === "free";
	const isVertical = preferences.position === "left" || preferences.position === "right";

	const environment = useMemo(() => {
		const targetId = activeEnvId ?? environments[0]?.id;
		return environments.find((env) => env.id === targetId) ?? environments[0] ?? null;
	}, [environments, activeEnvId]);

	const accent = environment?.accent || globalAccent;

	const activeTab = useMemo(
		() => preferences.tabs.find((tab) => tab.id === activeTabId) ?? null,
		[preferences.tabs, activeTabId],
	);

	// All of the active environment's real (custom) task columns, plus
	// per-column sorted tasks — every task widget that needs "which column"
	// looks here instead of assuming a fixed two-column board.
	const { columns, tasksByColumn, secondColumn, firstTodo, totalTaskCount } = useMemo(() => {
		const empty = {
			columns: [] as TaskColumn[],
			tasksByColumn: new Map<string, TaskItem[]>(),
			secondColumn: null as TaskColumn | null,
			firstTodo: null as TaskItem | null,
			totalTaskCount: 0,
		};
		if (!environment?.id) return empty;
		const columnsByMap = readStorage<Record<string, TaskColumn[]>>(TASK_COLUMNS_KEY, {});
		const normalizedColumns = normalizeColumns(
			columnsByMap[environment.id] ?? defaultTaskColumns,
			defaultTaskColumns,
		);
		const orderByMap = readStorage<Record<string, string[]>>(TASK_ORDER_KEY, {});
		const order = orderByMap[environment.id] ?? [];
		const byColumn = new Map<string, TaskItem[]>();
		for (const column of normalizedColumns) {
			const columnTasks = tasks.filter((task) => task.status === column.status);
			byColumn.set(column.status, sortTasksByOrder(columnTasks, order));
		}
		const first = normalizedColumns[0] ?? null;
		const second = normalizedColumns[1] ?? null;
		const firstTasks = first ? (byColumn.get(first.status) ?? []) : [];
		return {
			columns: normalizedColumns,
			tasksByColumn: byColumn,
			secondColumn: second,
			firstTodo: firstTasks[0] ?? null,
			totalTaskCount: tasks.length,
		};
	}, [tasks, environment?.id]);

	const columnCounts = useMemo(
		() =>
			columns.map((column) => ({
				label: column.label,
				count: tasksByColumn.get(column.status)?.length ?? 0,
			})),
		[columns, tasksByColumn],
	);

	// Resolves a widget's configured column (falling back to the first column
	// when unset/unknown), since every column is per-environment and custom.
	const resolveColumn = (config: string | undefined): TaskColumn | null =>
		(config && columns.find((column) => column.status === config)) || columns[0] || null;

	const columnAfter = (status: string): TaskColumn | null => {
		const index = columns.findIndex((column) => column.status === status);
		return index >= 0 ? (columns[index + 1] ?? null) : null;
	};

	const lastNote = useMemo(() => {
		if (notes.length === 0) return null;
		return [...notes].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
	}, [notes]);

	// Aggregated top app for the "top app" widget, mirroring the dashboard's
	// own app-name cleanup/aggregation so the two stay consistent.
	const topApp = useMemo(() => {
		if (!dashboard || dashboard.timePerApp.length === 0) return null;
		const totals = new Map<string, number>();
		for (const entry of dashboard.timePerApp) {
			const name = normalizeTrackedAppName(entry.appName);
			totals.set(name, (totals.get(name) ?? 0) + entry.duration);
		}
		let top: { appName: string; duration: number } | null = null;
		for (const [appName, duration] of totals) {
			if (!top || duration > top.duration) top = { appName, duration };
		}
		return top;
	}, [dashboard]);

	// Today's active intervals as percentages of the 24h day, for the activity
	// bar, plus where "now" falls on that same scale.
	const { todaySegments, nowPercent } = useMemo(() => {
		const minutesSinceMidnight = (date: Date) =>
			date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
		const nowDate = new Date(now);
		const segments = todaySessions.map((session) => {
			const start = minutesSinceMidnight(new Date(session.started_at));
			const end = minutesSinceMidnight(session.ended_at ? new Date(session.ended_at) : nowDate);
			return {
				startPercent: (start / 1440) * 100,
				widthPercent: Math.max((end - start) / 1440, 0) * 100,
			};
		});
		return {
			todaySegments: segments,
			nowPercent: (minutesSinceMidnight(nowDate) / 1440) * 100,
		};
	}, [todaySessions, now]);

	// How much of today's elapsed wall-clock time has no tracked session
	// against it, for the "untracked today" widget.
	const untrackedTodayMs = useMemo(() => {
		const midnight = new Date(now);
		midnight.setHours(0, 0, 0, 0);
		const elapsedMs = now - midnight.getTime();
		return Math.max(elapsedMs - (dashboard?.totalTodayMs ?? 0), 0);
	}, [now, dashboard]);

	const currentTimeLabel = useMemo(
		() =>
			new Date(now).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			}),
		[now],
	);

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
		if (preferences.position === "left") return { x: -Math.max(cardSize.width - PEEK_PX, 0), y: 0 };
		if (preferences.position === "right") return { x: Math.max(cardSize.width - PEEK_PX, 0), y: 0 };
		return { x: 0, y: -Math.max(cardSize.height - PEEK_PX, 0) };
	}, [isFree, preferences.position, cardSize.height, cardSize.width]);

	// An open tab panel keeps the bar pulled into view even without a hover,
	// since the panel only makes sense alongside a visible bar.
	const isExpanded = isFree || hovered || preferences.locked || Boolean(activeTab);

	const onToggleLock = () => {
		void window.atlas.setNotchPreferences({ locked: !preferences.locked });
	};

	const onStopTimer = async () => {
		// Reconcile against the real DB session instead of trusting the polled
		// snapshot: stop whatever is genuinely active, then re-read the truth so a
		// stale id can't leave a phantom timer ticking or the session running on.
		const live = (await window.atlas.getActiveSession().catch(() => null)) ?? activeSession;
		if (!live) {
			setActiveSession(null);
			return;
		}
		try {
			await window.atlas.stopSession(live.id);
		} catch {
			// Already stopped elsewhere — fall through and adopt the DB truth.
		}
		setActiveSession(await window.atlas.getActiveSession().catch(() => null));
	};

	const onStartTimer = async () => {
		if (!environment) return;
		// Never start a second session: if one is already active (possibly started
		// from another window since the last poll), adopt it rather than duplicate.
		const live = await window.atlas.getActiveSession().catch(() => null);
		if (live) {
			setActiveSession(live);
			return;
		}
		try {
			const session = await window.atlas.startSession(environment.id);
			setActiveSession(session);
		} catch {
			setActiveSession(await window.atlas.getActiveSession().catch(() => null));
		}
	};

	const onTogglePause = async () => {
		if (!activeSession) return;
		const updated = activeSession.is_paused
			? await window.atlas.resumeSession(activeSession.id)
			: await window.atlas.pauseSession(activeSession.id);
		setActiveSession(updated);
	};

	const onAdvanceTodo = async (taskId: string, nextStatus: string) => {
		await window.atlas.updateTaskStatus(taskId, nextStatus);
		setTasks((current) =>
			current.map((task) => (task.id === taskId ? { ...task, status: nextStatus } : task)),
		);
	};

	const onSwitchEnvironment = (envId: string) => {
		try {
			localStorage.setItem("atlas.lastEnvironmentId", envId);
		} catch {
			// Ignore storage failures (e.g. private mode); state still updates below.
		}
		setActiveEnvId(envId);
		// WP-1.3: tells the main process which environment is now active so it
		// can resolve and apply that environment's own Notch layout (or the
		// global default) and re-render every notch window immediately — the
		// same signal App.tsx already sends on its own environment switcher.
		// Without this, switching environments FROM the notch itself would
		// change what the rest of the app sees but leave the notch's own
		// layout stuck on whatever was last active.
		void window.atlas.notifyEnvironmentSwitch(envId).catch(() => {});
	};

	const onCycleEnvironment = () => {
		if (environments.length < 2 || !environment) return;
		const index = environments.findIndex((env) => env.id === environment.id);
		const next = environments[(index + 1) % environments.length];
		if (next) onSwitchEnvironment(next.id);
	};

	// Runs a saved scene: switches environment, toggles the timer, drops preset
	// tasks onto the board, then launches apps and opens URLs. Each step is
	// guarded and best-effort so one failing action (e.g. a missing app) never
	// stops the rest of the scene.
	const runScene = async (scene: NotchSceneConfig) => {
		let targetEnvId = environment?.id;
		if (scene.environmentId && environments.some((env) => env.id === scene.environmentId)) {
			onSwitchEnvironment(scene.environmentId);
			targetEnvId = scene.environmentId;
		}

		if (scene.timer === "start" && targetEnvId) {
			const live = await window.atlas.getActiveSession().catch(() => null);
			if (live) {
				setActiveSession(live);
			} else {
				try {
					const session = await window.atlas.startSession(targetEnvId);
					setActiveSession(session);
				} catch {
					// Ignore: scene continues; adopt whatever the DB reports.
					setActiveSession(await window.atlas.getActiveSession().catch(() => null));
				}
			}
		} else if (scene.timer === "stop") {
			const live = (await window.atlas.getActiveSession().catch(() => null)) ?? activeSession;
			if (live) {
				try {
					await window.atlas.stopSession(live.id);
				} catch {
					// Ignore.
				}
				setActiveSession(await window.atlas.getActiveSession().catch(() => null));
			}
		}

		for (const task of scene.tasks) {
			const title = task.title.trim();
			if (!title || !targetEnvId) continue;
			try {
				const created = await window.atlas.createTask(targetEnvId, title);
				if (task.column && created.status !== task.column) {
					await window.atlas.updateTaskStatus(created.id, task.column);
				}
				const status = task.column || created.status;
				setTasks((current) => [...current, { ...created, status }]);
			} catch {
				// Ignore a single failed task creation.
			}
		}

		for (const command of scene.apps) {
			if (command.trim()) void window.atlas.launchApp(command);
		}
		for (const url of scene.urls) {
			const trimmed = url.trim();
			if (trimmed) void window.atlas.launchApp(`start "" "${trimmed}"`);
		}
	};

	const onToggleTheme = () => {
		const next = themeValue === "dark" ? "light" : "dark";
		try {
			localStorage.setItem(THEME_KEY, JSON.stringify(next));
		} catch {
			// Ignore storage failures; native theme still gets applied below.
		}
		setThemeValue(next);
		document.documentElement.classList.toggle("dark", next === "dark");
		void window.atlas.setNativeTheme(next);
	};

	// Plain text/value widgets that need no interactivity, keyed by widget id
	// so renderWidget can render them all the same way.
	const getDisplayText = (placement: NotchWidgetPlacement): string | null => {
		switch (placement.widget) {
			case "topAppCompact":
				return topApp ? topApp.appName : "No data yet";
			case "openTasksCount":
				return `${dashboard?.quickStats.openTasks ?? 0} open tasks`;
			case "untrackedToday":
				return `${formatDuration(untrackedTodayMs)} untracked`;
			case "taskCount": {
				const column = resolveColumn(placement.config);
				const count = column ? (tasksByColumn.get(column.status)?.length ?? 0) : 0;
				return `${count} ${column?.label ?? "to do"}`;
			}
			case "cpuUsagePercent":
				return `${systemStats.cpuPercent}% CPU`;
			case "memoryUsagePercent":
				return `${systemStats.memoryPercent}% RAM`;
			case "taskColumnsOverview":
				return columnCounts.length > 0 ? columnCounts.map((c) => c.count).join(" · ") : "—";
			case "dueTasksCount": {
				const lastStatus = columns[columns.length - 1]?.status;
				const today = new Date(now);
				today.setHours(0, 0, 0, 0);
				const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
				const open = tasks.filter((task) => task.due_date && task.status !== lastStatus);
				const overdue = open.filter((task) => (task.due_date as string) < todayKey).length;
				const dueToday = open.filter((task) => task.due_date === todayKey).length;
				if (overdue > 0) return `${overdue} overdue`;
				if (dueToday > 0) return `${dueToday} due today`;
				return "Nothing due";
			}
			case "notesCount":
				return `${notes.length} notes`;
			case "environmentName":
				return environment?.name ?? "No environment";
			case "currentDate":
				return new Date(now).toLocaleDateString([], { day: "numeric", month: "short" });
			case "dayOfWeek":
				return new Date(now).toLocaleDateString([], { weekday: "long" });
			case "clockWithSeconds":
				return new Date(now).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit",
				});
			case "timeUntilMidnight": {
				const midnight = new Date(now);
				midnight.setHours(24, 0, 0, 0);
				return `${formatDuration(midnight.getTime() - now)} left today`;
			}
			case "currentAppName":
				return currentAppName || "Unknown";
			case "platformBadge":
				return platform || "—";
			case "appVersionBadge":
				return appVersion ? `v${appVersion}` : "—";
			case "sessionStateLabel":
				return activeSession ? (activeSession.is_paused ? "Paused" : "Running") : "Idle";
			case "focusStatus":
				return focus.runtime
					? `${FOCUS_PHASE_LABELS[focus.runtime.phase]} ${focus.countdown}`
					: "Focus idle";
			case "lastNoteSnippet":
				return lastNote ? lastNote.content.slice(0, 60) || "(empty note)" : "No notes yet";
			default:
				return null;
		}
	};

	const renderWidget = (placement: NotchWidgetPlacement) => {
		const widgetId = placement.widget;

		const navAction = NAV_ACTIONS[widgetId];
		if (navAction) {
			const Icon = navAction.icon;
			return (
				<div key={placement.id} className="flex h-full items-center justify-center">
					<button
						type="button"
						className={`${ICON_BUTTON_CLASSES} h-8 w-8`}
						title={navAction.title}
						aria-label={navAction.title}
						onClick={navAction.onClick}
					>
						<Icon className="h-5 w-5" />
					</button>
				</div>
			);
		}

		const text = getDisplayText(placement);
		if (text !== null) {
			return (
				<div key={placement.id} className="flex h-full items-center justify-center px-1">
					<span className="truncate text-[11px] text-neutral-700 dark:text-neutral-100">{text}</span>
				</div>
			);
		}

		switch (widgetId) {
			case "focusToggle": {
				const running = focus.isRunning;
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-8 w-8`}
							title={running ? "Pause focus" : focus.runtime ? "Resume focus" : "Start focus"}
							aria-label={running ? "Pause focus" : "Start focus"}
							onClick={() => focus.toggle()}
						>
							{running ? <PauseIcon className="h-5 w-5" /> : <BoltIcon className="h-5 w-5" />}
						</button>
					</div>
				);
			}
			case "timerStartStop":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						{activeSession ? (
							<button
								type="button"
								className={`${ICON_BUTTON_CLASSES} h-8 w-8`}
								title="Stop timer"
								aria-label="Stop timer"
								onClick={() => void onStopTimer()}
							>
								<StopIcon className="h-5 w-5" />
							</button>
						) : (
							<button
								type="button"
								className={`recording-trigger group ${ICON_BUTTON_CLASSES} h-8 w-8 disabled:cursor-not-allowed disabled:opacity-40`}
								disabled={!environment}
								onClick={() => void onStartTimer()}
								aria-label="Start recording"
							>
								<span className="relative h-5 w-5">
									<PlayCircleIcon className="absolute inset-0 h-5 w-5 transition-opacity duration-150 group-hover:opacity-0" />
									<PlayCircleIconSolid className="absolute inset-0 h-5 w-5 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
								</span>
							</button>
						)}
					</div>
				);
			case "timerPause":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-8 w-8 disabled:cursor-not-allowed disabled:opacity-40`}
							title={activeSession?.is_paused ? "Resume timer" : "Pause timer"}
							aria-label={activeSession?.is_paused ? "Resume timer" : "Pause timer"}
							disabled={!activeSession}
							onClick={() => void onTogglePause()}
						>
							{activeSession?.is_paused ? (
								<PlayIcon className="h-5 w-5" />
							) : (
								<PauseIcon className="h-5 w-5" />
							)}
						</button>
					</div>
				);
			case "timerDisplay":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<span className="font-data text-[13px] text-neutral-700 dark:text-neutral-100">
							{activeSession ? formatClock(sessionElapsedMs(activeSession, now)) : "00:00:00"}
						</span>
					</div>
				);
			case "timerStatusDot":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<span
							className={`h-2.5 w-2.5 rounded-full ${
								!activeSession
									? "bg-neutral-300 dark:bg-neutral-500"
									: activeSession.is_paused
										? "bg-amber-500"
										: "bg-primary"
							}`}
						/>
					</div>
				);
			case "lockToggle":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-8 w-8`}
							title={preferences.locked ? "Unlock position" : "Lock position"}
							aria-label={preferences.locked ? "Unlock position" : "Lock position"}
							onClick={onToggleLock}
						>
							{preferences.locked ? (
								<LockClosedIconSolid className="h-5 w-5" />
							) : (
								<LockOpenIcon className="h-5 w-5" />
							)}
						</button>
					</div>
				);
			case "timeSpentToday":
				return (
					<div key={placement.id} className="flex items-center gap-2">
						<div className="relative h-1.5 min-w-20 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-600">
							{todaySegments.map((segment, index) => (
								<span
									key={index}
									className="absolute top-0 h-full bg-neutral-700 dark:bg-neutral-100"
									style={{
										left: `${segment.startPercent}%`,
										width: `${segment.widthPercent}%`,
									}}
								/>
							))}
							<span
								className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-primary"
								style={{ left: `${nowPercent}%` }}
							/>
						</div>
						<span className="font-data text-[11px] text-neutral-500 dark:text-neutral-300">
							{currentTimeLabel}
						</span>
						<span className="font-data text-[12px] font-medium text-neutral-700 dark:text-neutral-100">
							{formatDuration(dashboard?.totalTodayMs ?? 0)}
						</span>
					</div>
				);
			case "activityTimeline":
				return (
					<div key={placement.id} className="flex h-full w-full flex-col justify-center gap-1 px-2">
						<div className="relative h-3 w-full overflow-hidden rounded-md bg-neutral-200 dark:bg-neutral-600">
							{todaySegments.map((segment, index) => (
								<span
									key={index}
									className="absolute top-0 h-full bg-primary"
									style={{
										left: `${segment.startPercent}%`,
										width: `${Math.max(segment.widthPercent, 0.4)}%`,
									}}
								/>
							))}
							<span
								className="absolute top-0 h-full w-px bg-neutral-700 dark:bg-neutral-100"
								style={{ left: `${nowPercent}%` }}
							/>
						</div>
						<div className="flex justify-between text-[9px] text-neutral-500 dark:text-neutral-300">
							<span>00</span>
							<span>06</span>
							<span>12</span>
							<span>18</span>
							<span>24</span>
						</div>
					</div>
				);
			case "topApp": {
				const match = topApp
					? runningApps.find((app) => app.name.toLowerCase() === topApp.appName.toLowerCase())
					: null;
				const icon = match?.path ? appIcons[match.path] : undefined;
				return (
					<button
						key={placement.id}
						type="button"
						disabled={!match?.path}
						title={match?.path ? `Open ${topApp?.appName}` : (topApp?.appName ?? "No data yet")}
						onClick={() => match?.path && void window.atlas.launchApp(`"${match.path}"`)}
						className="flex h-full w-full items-center gap-2 px-2 text-left disabled:cursor-default"
					>
						<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-400/20 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300">
							{icon ? (
								<img src={icon} alt="" className="h-4.5 w-4.5" />
							) : (
								<RocketLaunchIcon className="h-4 w-4" />
							)}
						</div>
						<span className="max-w-24 truncate text-[12px] text-neutral-700 dark:text-neutral-100">
							{topApp ? `${topApp.appName} · ${formatDuration(topApp.duration)}` : "No data yet"}
						</span>
					</button>
				);
			}
			case "sessionsTodayCount":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center gap-1">
						<span className="font-data text-[13px] font-semibold text-neutral-800 dark:text-neutral-0">
							{dashboard?.quickStats.sessionsToday ?? 0}
						</span>
						<span className="text-[10px] text-neutral-500 dark:text-neutral-300">
							of {totalSessionCount} sessions
						</span>
					</div>
				);
			case "cpuUsageGraph":
			case "memoryUsageGraph": {
				const history = placement.widget === "cpuUsageGraph" ? cpuHistory : memoryHistory;
				const latest = history[history.length - 1] ?? 0;
				return (
					<div key={placement.id} className="relative flex h-full w-full items-end gap-0.5 px-2 py-1.5">
						<span className="absolute left-1.5 top-1 text-[10px] text-neutral-500 dark:text-neutral-300">
							{latest}% {placement.widget === "cpuUsageGraph" ? "CPU" : "RAM"}
						</span>
						{history.length === 0 ? (
							<span className="text-[10px] text-neutral-400">No data yet</span>
						) : (
							history.map((value, index) => (
								<span
									key={index}
									className="flex-1 rounded-sm bg-primary/60"
									style={{ height: `${Math.max(value, 4)}%` }}
								/>
							))
						)}
					</div>
				);
			}
			case "currentTime":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<span className="font-data text-[12px] text-neutral-700 dark:text-neutral-100">
							{currentTimeLabel}
						</span>
					</div>
				);
			case "firstTodoList": {
				const column = resolveColumn(placement.config);
				const columnTasks = column ? (tasksByColumn.get(column.status) ?? []).slice(0, 3) : [];
				const nextColumn = column ? columnAfter(column.status) : null;
				return (
					<div key={placement.id} className="flex flex-col gap-1">
						{columnTasks.length === 0 ? (
							<span className="text-[12px] text-neutral-500 dark:text-neutral-300">No tasks</span>
						) : (
							columnTasks.map((task) => (
								<div key={task.id} className="flex items-center justify-between gap-2">
									<span className="flex min-w-0 items-center gap-1.5">
										{task.priority !== "none" && (
											<span
												className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_META[task.priority].dot}`}
												title={`${PRIORITY_META[task.priority].label} priority`}
											/>
										)}
										<span className="max-w-28 truncate text-[12px] text-neutral-700 dark:text-neutral-100">
											{task.title}
										</span>
									</span>
									<button
										type="button"
										className={`${ICON_BUTTON_CLASSES} h-6 w-6 disabled:cursor-not-allowed disabled:opacity-40`}
										title="Move to next column"
										aria-label="Move to next column"
										disabled={!nextColumn}
										onClick={() => nextColumn && void onAdvanceTodo(task.id, nextColumn.status)}
									>
										<CheckIcon className="h-4 w-4" />
									</button>
								</div>
							))
						)}
					</div>
				);
			}
			case "nextTaskOnly": {
				const column = resolveColumn(placement.config);
				const task = column ? ((tasksByColumn.get(column.status) ?? [])[0] ?? null) : null;
				const nextColumn = column ? columnAfter(column.status) : null;
				return (
					<div key={placement.id} className="flex h-full items-center justify-between gap-2">
						<span className="flex min-w-0 items-center gap-1.5">
							{task && task.priority !== "none" && (
								<span
									className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_META[task.priority].dot}`}
									title={`${PRIORITY_META[task.priority].label} priority`}
								/>
							)}
							<span className="max-w-28 truncate text-[12px] text-neutral-700 dark:text-neutral-100">
								{task?.title ?? "No tasks"}
							</span>
						</span>
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-6 w-6 disabled:cursor-not-allowed disabled:opacity-40`}
							title="Move to next column"
							aria-label="Move to next column"
							disabled={!task || !nextColumn}
							onClick={() => task && nextColumn && void onAdvanceTodo(task.id, nextColumn.status)}
						>
							<CheckIcon className="h-4 w-4" />
						</button>
					</div>
				);
			}
			case "quickAddTask": {
				const column = resolveColumn(placement.config);
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-8 w-8 disabled:cursor-not-allowed disabled:opacity-40`}
							title={column ? `Add task to ${column.label}` : "Add task"}
							aria-label="Add task"
							disabled={!environment || !column}
							onClick={() =>
								environment &&
								column &&
								void window.atlas.openNotchInputWindow({
									kind: "task",
									environmentId: environment.id,
									environmentName: environment.name,
									status: column.status,
									columnLabel: column.label,
								})
							}
						>
							<PlusIcon className="h-5 w-5" />
						</button>
					</div>
				);
			}
			case "quickAddNote":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-8 w-8 disabled:cursor-not-allowed disabled:opacity-40`}
							title="Quick note"
							aria-label="Quick note"
							disabled={!environment}
							onClick={() =>
								environment &&
								void window.atlas.openNotchInputWindow({
									kind: "note",
									environmentId: environment.id,
									environmentName: environment.name,
								})
							}
						>
							<PencilSquareIcon className="h-5 w-5" />
						</button>
					</div>
				);
			case "taskProgressBar": {
				const column = resolveColumn(placement.config) ?? columns[columns.length - 1] ?? null;
				const doneCount = column ? (tasksByColumn.get(column.status)?.length ?? 0) : 0;
				const ratio = totalTaskCount > 0 ? doneCount / totalTaskCount : 0;
				return (
					<div key={placement.id} className="flex h-full flex-col justify-center gap-1 px-1">
						<div className="relative h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-600">
							<span
								className="absolute inset-y-0 left-0 bg-primary"
								style={{ width: `${Math.round(ratio * 100)}%` }}
							/>
						</div>
						<span className="text-[10px] text-neutral-500 dark:text-neutral-300">
							{doneCount}/{totalTaskCount} {column?.label.toLowerCase() ?? "done"}
						</span>
					</div>
				);
			}
			case "environmentAccentDot":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<span className="h-3 w-3 rounded-full" style={{ backgroundColor: accent }} />
					</div>
				);
			case "environmentSwitcher":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-8 w-8 disabled:cursor-not-allowed disabled:opacity-40`}
							title="Switch environment"
							aria-label="Switch environment"
							disabled={environments.length < 2}
							onClick={onCycleEnvironment}
						>
							<ArrowPathIcon className="h-5 w-5" />
						</button>
					</div>
				);
			case "environmentList":
				return (
					<div key={placement.id} className="flex h-full flex-col justify-center gap-0.5 px-1">
						{environments.length === 0 ? (
							<span className="text-[11px] text-neutral-500 dark:text-neutral-300">No environments</span>
						) : (
							environments.slice(0, 3).map((env) => (
								<button
									key={env.id}
									type="button"
									onClick={() => onSwitchEnvironment(env.id)}
									className={`truncate rounded px-1 text-left text-[11px] transition-colors hover:bg-neutral-100 dark:hover:bg-white/10 ${
										env.id === environment?.id
											? "font-semibold text-neutral-800 dark:text-neutral-0"
											: "text-neutral-600 dark:text-neutral-300"
									}`}
								>
									{env.name}
								</button>
							))
						)}
					</div>
				);
			case "scene": {
				const scene = parseSceneConfig(placement.config);
				const SceneIcon = TAB_ICON_MAP[scene.icon] ?? RocketLaunchIcon;
				const showLabel = placement.w > 1 && Boolean(scene.label);
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-full w-full gap-1.5 px-1`}
							title={scene.label || "Run scene"}
							aria-label={scene.label || "Run scene"}
							onClick={() => void runScene(scene)}
						>
							<SceneIcon className="h-5 w-5 shrink-0" />
							{showLabel ? <span className="truncate text-[11px]">{scene.label}</span> : null}
						</button>
					</div>
				);
			}
			case "launchAppButton": {
				const icon = placement.config ? appIcons[placement.config] : undefined;
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-8 w-8 disabled:cursor-not-allowed disabled:opacity-40`}
							title={placement.config ? `Launch: ${placement.config}` : "No program set"}
							aria-label="Launch app"
							disabled={!placement.config}
							onClick={() => placement.config && void window.atlas.launchApp(placement.config)}
						>
							{icon ? (
								<img src={icon} alt="" className="h-5 w-5" />
							) : (
								<RocketLaunchIcon className="h-5 w-5" />
							)}
						</button>
					</div>
				);
			}
			case "openUrlButton":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-8 w-8 disabled:cursor-not-allowed disabled:opacity-40`}
							title={placement.config ? `Open: ${placement.config}` : "No URL set"}
							aria-label="Open URL"
							disabled={!placement.config}
							onClick={() =>
								placement.config && void window.atlas.launchApp(`start "" "${placement.config}"`)
							}
						>
							<GlobeAltIcon className="h-5 w-5" />
						</button>
					</div>
				);
			case "updateAvailableBadge":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center px-1">
						<span
							className={`truncate text-[11px] ${
								hasUpdate
									? "font-medium text-amber-600 dark:text-amber-400"
									: "text-neutral-500 dark:text-neutral-300"
							}`}
						>
							{hasUpdate ? "Update available" : "Up to date"}
						</span>
					</div>
				);
			case "divider":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<span className="h-full w-px bg-neutral-200 dark:bg-neutral-600" />
					</div>
				);
			case "label":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center px-1">
						<span className="truncate text-[11px] text-neutral-700 dark:text-neutral-100">
							{placement.config || "Label"}
						</span>
					</div>
				);
			case "spacer":
				return <div key={placement.id} />;
			case "accentSwatch":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<span className="h-4 w-4 rounded-md" style={{ backgroundColor: accent }} />
					</div>
				);
			case "themeToggle":
				return (
					<div key={placement.id} className="flex h-full items-center justify-center">
						<button
							type="button"
							className={`${ICON_BUTTON_CLASSES} h-8 w-8`}
							title={themeValue === "dark" ? "Switch to light" : "Switch to dark"}
							aria-label={themeValue === "dark" ? "Switch to light" : "Switch to dark"}
							onClick={onToggleTheme}
						>
							{themeValue === "dark" ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
						</button>
					</div>
				);
			default:
				return null;
		}
	};

	return (
		<div
			className={`flex h-screen w-screen overflow-hidden bg-transparent ${ROOT_POSITION_CLASSES[preferences.position]}`}
			onMouseDown={(event) => {
				// A click on the transparent root background (not bubbled from the
				// card or panel) closes an open tab panel.
				if (event.target === event.currentTarget) setActiveTabId(null);
			}}
		>
			<div ref={wrapperRef} className={`flex gap-2 ${WRAPPER_POSITION_CLASSES[preferences.position]}`}>
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
												onClick={() => secondColumn && void onAdvanceTodo(firstTodo.id, secondColumn.status)}
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
							{preferences.tabs.map((tab) => {
								const isActive = activeTabId === tab.id;
								const OutlineIcon = TAB_ICON_MAP[tab.icon] ?? Squares2X2Icon;
								const SolidIcon = TAB_ICON_SOLID_MAP[tab.icon] ?? OutlineIcon;
								const Icon = isActive ? SolidIcon : OutlineIcon;
								return (
									<button
										key={tab.id}
										type="button"
										className={`${ICON_BUTTON_CLASSES} h-7 w-7`}
										title={tab.label}
										aria-label={tab.label}
										onClick={() => setActiveTabId((current) => (current === tab.id ? null : tab.id))}
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
								className={`inline-flex max-w-28 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-neutral-200 px-3.5 py-0.5 text-[12px] font-semibold text-ellipsis whitespace-nowrap dark:border-neutral-600 ${
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
								title="Edit action buttons"
								aria-label="Edit action buttons"
								onClick={() => void window.atlas.openActionEditorWindow()}
							>
								<PencilSquareIcon className="h-4.5 w-4.5" />
							</button>

							<button
								type="button"
								className={`${ICON_BUTTON_CLASSES} h-7 w-7`}
								title={preferences.locked ? "Unlock position" : "Lock position"}
								aria-label={preferences.locked ? "Unlock position" : "Lock position"}
								onClick={onToggleLock}
							>
								{preferences.locked ? (
									<LockClosedIconSolid className="w-5 h-5" />
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

				{activeTab && activeTab.placements.length > 0 ? (
					<div
						ref={panelRef}
						className="notch-no-drag rounded-[20px] border border-neutral-200 bg-neutral-0 p-3 text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-50"
						style={{
							display: "grid",
							gridTemplateColumns: `repeat(${activeTab.gridCols}, ${GRID_CELL_PX}px)`,
							gridTemplateRows: `repeat(${activeTab.gridRows}, ${GRID_CELL_PX}px)`,
							gap: `${GRID_GAP_PX}px`,
						}}
					>
						{activeTab.placements.map((placement) => (
							<div
								key={placement.id}
								className={`overflow-hidden ${
									WIDGETS_WITHOUT_CARD.has(placement.widget) ? "" : WIDGET_CARD_CLASSES
								}`}
								style={{
									gridColumn: `${placement.x + 1} / span ${placement.w}`,
									gridRow: `${placement.y + 1} / span ${placement.h}`,
								}}
							>
								{renderWidget(placement)}
							</div>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
