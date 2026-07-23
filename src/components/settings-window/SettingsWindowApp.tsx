import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDownIcon, ChevronUpIcon, MinusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
	ArrowPathIcon,
	BoltIcon,
	CommandLineIcon,
	FolderIcon,
	LightBulbIcon,
	PaintBrushIcon,
	RectangleGroupIcon,
	SparklesIcon,
	WrenchScrewdriverIcon,
} from "@heroicons/react/24/solid";
import { TrashIcon } from "@heroicons/react/24/outline";
import { AccentPicker, Select, ThemeModePicker, Toggle } from "../ui";
import { useAccent } from "../../hooks";
import { describeIpcError } from "../../utils/ipcError";
import { NotchTabsEditor } from "./NotchTabsEditor";
import { FindingsPanel } from "./FindingsPanel";
import { SmartFunctionsPanel } from "./SmartFunctionsPanel";
import { WorkContextCard } from "./WorkContextCard";
import type {
	AiProvider,
	AiPublicConfig,
	AppRelease,
	DisplaySummary,
	Environment,
	FileIndexPreferences,
	FileIndexStats,
	FileIndexStatus,
	FileIndexWatchStatus,
	NotchActivation,
	NotchIdleOpacity,
	NotchInfoItemConfig,
	NotchPosition,
	NotchPreferences,
	SuggestionPreferences,
	UpdateCheckResult,
} from "../../types";
import logo from "../../assets/logosmall.png";

type SettingsTab =
	| "general"
	| "appearance"
	| "notch"
	| "files"
	| "rules"
	| "findings"
	| "integrations"
	| "keybindings"
	| "updates";

type ThemeOption = "dark" | "light" | "system";

const settingsTabs: Array<{
	id: SettingsTab;
	label: string;
	icon: typeof WrenchScrewdriverIcon;
}> = [
	{ id: "general", label: "General", icon: WrenchScrewdriverIcon },
	{ id: "appearance", label: "Appearance", icon: PaintBrushIcon },
	{ id: "notch", label: "Smart Notch", icon: RectangleGroupIcon },
	{ id: "files", label: "File Index", icon: FolderIcon },
	// WP-3.2: the rules the user builds by hand. Sits next to Findings, which
	// is where the rules Atlas proposes come from -- the two are the same
	// destination reached from opposite directions.
	{ id: "rules", label: "Smart Functions", icon: BoltIcon },
	// WP-3.6: the patterns Atlas has mined, and everything the user can do
	// with them. Its own tab rather than a section under "Smart Notch": the
	// Notch is only where a suggestion happens to appear, while this is the
	// full record, including findings the Notch has never surfaced.
	{ id: "findings", label: "Findings", icon: LightBulbIcon },
	{ id: "integrations", label: "Integrations", icon: SparklesIcon },
	{ id: "keybindings", label: "Keybindings", icon: CommandLineIcon },
	{ id: "updates", label: "Updates", icon: ArrowPathIcon },
];

const EMPTY_FILE_INDEX_PREFS: FileIndexPreferences = { roots: [], exclusions: [], maxDepth: 12, maxFiles: 200_000 };

const EMPTY_FILE_INDEX_STATUS: FileIndexStatus = {
	state: "idle",
	startedAt: null,
	finishedAt: null,
	filesScanned: 0,
	dirsScanned: 0,
	currentRoot: null,
	truncated: false,
	cancelled: false,
	error: null,
};

const EMPTY_FILE_INDEX_WATCH_STATUS: FileIndexWatchStatus = {
	state: "stopped",
	startedAt: null,
	lastEventAt: null,
	lastFlushAt: null,
	pendingCount: 0,
	rootsWatched: 0,
	onBattery: false,
	error: null,
};

function formatFileIndexState(status: FileIndexStatus): string {
	switch (status.state) {
		case "running":
			return "Scanning…";
		case "completed":
			return status.truncated ? "Finished (stopped early — file cap reached)" : "Up to date";
		case "cancelled":
			return "Cancelled";
		case "error":
			return status.error ? `Failed: ${status.error}` : "Failed";
		default:
			return "Never scanned";
	}
}

function formatFileIndexWatchState(status: FileIndexWatchStatus): string {
	switch (status.state) {
		case "watching":
			return status.pendingCount > 0 ? `Watching… (${status.pendingCount} change(s) pending)` : "Watching for changes";
		case "error":
			return status.error ? `Not watching: ${status.error}` : "Not watching";
		default:
			return "Not watching";
	}
}

const AI_PROVIDER_ORDER: AiProvider[] = ["anthropic", "google", "openai"];

const AI_PROVIDER_HINTS: Record<AiProvider, { keyPlaceholder: string; help: string }> = {
	anthropic: { keyPlaceholder: "sk-ant-...", help: "console.anthropic.com → API Keys" },
	google: { keyPlaceholder: "AIza...", help: "aistudio.google.com → Get API key" },
	openai: { keyPlaceholder: "sk-...", help: "platform.openai.com → API keys" },
};

type AiStatusState = { state: "idle" | "saving" | "testing" | "ok" | "error"; message?: string };

const INFO_ITEM_LABELS: Record<NotchInfoItemConfig["id"], string> = {
	timer: "Active timer",
	todo: "First to-do",
};

const readStorage = <T,>(key: string, fallback: T): T => {
	try {
		const value = localStorage.getItem(key);
		if (!value) {
			return fallback;
		}
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
};

export function SettingsWindowApp() {
	const [activeTab, setActiveTab] = useState<SettingsTab>("general");
	const [platform, setPlatform] = useState("win32");
	const [theme, setTheme] = useState<ThemeOption>(() => readStorage("atlas.theme", "light"));
	const prefersDark = useSyncExternalStore(
		(onStoreChange) => {
			const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
			mediaQuery.addEventListener("change", onStoreChange);
			return () => mediaQuery.removeEventListener("change", onStoreChange);
		},
		() => window.matchMedia("(prefers-color-scheme: dark)").matches,
		() => false,
	);
	const resolvedTheme: "dark" | "light" = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
	const { accent, setAccent } = useAccent();
	const [notchPrefs, setNotchPrefs] = useState<NotchPreferences>({
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
	const [suggestionPrefs, setSuggestionPrefs] = useState<SuggestionPreferences>({
		enabled: true,
		maxPerSession: 1,
		maxPerDay: 3,
		suppressAfterDismissals: 3,
	});
	const [displays, setDisplays] = useState<DisplaySummary[]>([]);
	const [environments, setEnvironments] = useState<Environment[]>([]);
	const [fileIndexPrefs, setFileIndexPrefs] = useState<FileIndexPreferences>(EMPTY_FILE_INDEX_PREFS);
	const [fileIndexStatus, setFileIndexStatus] = useState<FileIndexStatus>(EMPTY_FILE_INDEX_STATUS);
	const [fileIndexStats, setFileIndexStats] = useState<FileIndexStats | null>(null);
	const [fileIndexWatchStatus, setFileIndexWatchStatus] = useState<FileIndexWatchStatus>(
		EMPTY_FILE_INDEX_WATCH_STATUS,
	);
	const [aiConfig, setAiConfig] = useState<AiPublicConfig | null>(null);
	const [aiKeyDrafts, setAiKeyDrafts] = useState<Record<AiProvider, string>>({
		anthropic: "",
		google: "",
		openai: "",
	});
	const [aiModelDrafts, setAiModelDrafts] = useState<Record<AiProvider, string>>({
		anthropic: "",
		google: "",
		openai: "",
	});
	const [aiStatus, setAiStatus] = useState<Record<AiProvider, AiStatusState>>({
		anthropic: { state: "idle" },
		google: { state: "idle" },
		openai: { state: "idle" },
	});
	const [timeFormat, setTimeFormat] = useState(() => readStorage("atlas.settings.timeFormat", "24h"));
	const [startWeekOn, setStartWeekOn] = useState(() => readStorage("atlas.settings.startWeekOn", "monday"));
	const [density, setDensity] = useState(() => readStorage("atlas.settings.density", "comfortable"));
	const [softAnimations, setSoftAnimations] = useState(() =>
		readStorage("atlas.settings.softAnimations", true),
	);
	const [highlightSession, setHighlightSession] = useState(() =>
		readStorage("atlas.settings.highlightSession", true),
	);
	const [pinEnvironmentSwitcher, setPinEnvironmentSwitcher] = useState(() =>
		readStorage("atlas.settings.pinEnvironmentSwitcher", false),
	);
	const [vimMode, setVimMode] = useState(() => readStorage("atlas.settings.vimMode", false));
	const [commandPalette, setCommandPalette] = useState(() =>
		readStorage("atlas.settings.commandPalette", true),
	);
	const [autoUpdates, setAutoUpdates] = useState(() => readStorage("atlas.autoUpdates", true));
	const [includeBetaUpdates, setIncludeBetaUpdates] = useState(() =>
		readStorage("atlas.includeBetaUpdates", false),
	);
	const [appVersion, setAppVersion] = useState<string | null>(null);
	const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
	const [releaseHistory, setReleaseHistory] = useState<AppRelease[]>([]);
	const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
	const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
	const [updatesError, setUpdatesError] = useState<string | null>(null);

	const normalizeVersion = useCallback((value?: string | null) => {
		if (!value || typeof value !== "string") {
			return null;
		}

		const cleaned = value.trim().replace(/^v/i, "");
		return cleaned || null;
	}, []);

	const localDisplayVersion = useMemo(
		() => normalizeVersion(updateInfo?.local) ?? normalizeVersion(appVersion),
		[appVersion, normalizeVersion, updateInfo?.local],
	);

	const tabLabel = useMemo(
		() => settingsTabs.find((tab) => tab.id === activeTab)?.label ?? "General",
		[activeTab],
	);
	const currentRelease = useMemo(() => {
		const localVersion = localDisplayVersion;
		if (!localVersion) {
			return null;
		}

		return (
			releaseHistory.find(
				(release) => release.version === localVersion || release.tag === `v${localVersion}`,
			) ?? null
		);
	}, [localDisplayVersion, releaseHistory]);
	const isMacPlatform = platform === "darwin";
	const hasNativeControls = platform === "darwin" || platform === "win32";

	useEffect(() => {
		window.atlas
			.getPlatform()
			.then((value) => setPlatform(value || "win32"))
			.catch(() => setPlatform("win32"));
	}, []);

	useEffect(() => {
		window.atlas
			.getNotchPreferences()
			.then(setNotchPrefs)
			.catch(() => undefined);
		const unsubscribe = window.atlas.onNotchPreferencesChanged?.(setNotchPrefs);
		return () => unsubscribe?.();
	}, []);

	// WP-3.5: no live broadcast for this (unlike notch preferences above) --
	// fetched once, since only this window's own toggle below ever changes it.
	useEffect(() => {
		window.atlas
			.getSuggestionPreferences()
			.then(setSuggestionPrefs)
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		window.atlas
			.listDisplays()
			.then(setDisplays)
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		window.atlas
			.listEnvironments()
			.then(setEnvironments)
			.catch(() => undefined);
	}, []);

	const refreshFileIndexStats = useCallback(() => {
		window.atlas
			.getFileIndexStats()
			.then(setFileIndexStats)
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		window.atlas
			.getFileIndexPreferences()
			.then(setFileIndexPrefs)
			.catch(() => undefined);
		window.atlas
			.getFileIndexStatus()
			.then(setFileIndexStatus)
			.catch(() => undefined);
		refreshFileIndexStats();
		const unsubscribe = window.atlas.onFileIndexProgress?.((status) => {
			setFileIndexStatus(status);
			if (status.state === "completed" || status.state === "cancelled") {
				refreshFileIndexStats();
			}
		});
		return () => unsubscribe?.();
	}, [refreshFileIndexStats]);

	useEffect(() => {
		window.atlas
			.getFileIndexWatchStatus()
			.then(setFileIndexWatchStatus)
			.catch(() => undefined);
		const unsubscribe = window.atlas.onFileIndexWatchStatus?.((status) => {
			setFileIndexWatchStatus(status);
			// A batch just landed -- the totals in the "Index status" card
			// (getIndexStats) may have changed just like a crawl completing does.
			refreshFileIndexStats();
		});
		return () => unsubscribe?.();
	}, [refreshFileIndexStats]);

	const handleStartFileIndexWatch = async () => {
		const status = await window.atlas.startFileIndexWatch();
		setFileIndexWatchStatus(status);
	};

	const handleStopFileIndexWatch = async () => {
		const status = await window.atlas.stopFileIndexWatch();
		setFileIndexWatchStatus(status);
	};

	const updateFileIndexPrefs = async (patch: Partial<FileIndexPreferences>) => {
		const next = await window.atlas.setFileIndexPreferences(patch);
		setFileIndexPrefs(next);
		return next;
	};

	const handleAddFileIndexRoot = async () => {
		const picked = await window.atlas.pickFileIndexFolder();
		if (!picked) {
			return;
		}
		const root = {
			id: `root:${Date.now()}:${Math.round(Math.random() * 1e6)}`,
			label: picked.split(/[\\/]/).filter(Boolean).pop() ?? picked,
			path: picked,
			environmentId: null,
			enabled: true,
		};
		await updateFileIndexPrefs({ roots: [...fileIndexPrefs.roots, root] });
	};

	const handleRemoveFileIndexRoot = async (id: string) => {
		await updateFileIndexPrefs({ roots: fileIndexPrefs.roots.filter((root) => root.id !== id) });
	};

	const handleToggleFileIndexRoot = async (id: string, enabled: boolean) => {
		await updateFileIndexPrefs({
			roots: fileIndexPrefs.roots.map((root) => (root.id === id ? { ...root, enabled } : root)),
		});
	};

	const handleSetFileIndexRootEnvironment = async (id: string, environmentId: string | null) => {
		await updateFileIndexPrefs({
			roots: fileIndexPrefs.roots.map((root) => (root.id === id ? { ...root, environmentId } : root)),
		});
	};

	const handleStartFileIndexCrawl = async () => {
		const status = await window.atlas.startFileIndexCrawl();
		setFileIndexStatus(status);
	};

	const handleCancelFileIndexCrawl = async () => {
		const status = await window.atlas.cancelFileIndexCrawl();
		setFileIndexStatus(status);
	};

	useEffect(() => {
		window.atlas
			.getAiConfig?.()
			.then((config) => {
				setAiConfig(config);
				setAiModelDrafts({
					anthropic: config.providers.anthropic.model,
					google: config.providers.google.model,
					openai: config.providers.openai.model,
				});
			})
			.catch(() => undefined);
	}, []);

	const saveAiProvider = async (provider: AiProvider) => {
		setAiStatus((current) => ({ ...current, [provider]: { state: "saving" } }));
		try {
			const key = aiKeyDrafts[provider].trim();
			const config = await window.atlas.setAiConfig({
				providers: {
					[provider]: {
						model: aiModelDrafts[provider].trim() || undefined,
						...(key ? { apiKey: key } : {}),
					},
				},
			});
			setAiConfig(config);
			setAiKeyDrafts((current) => ({ ...current, [provider]: "" }));
			setAiStatus((current) => ({ ...current, [provider]: { state: "ok", message: "Saved" } }));
		} catch (error) {
			setAiStatus((current) => ({
				...current,
				[provider]: { state: "error", message: describeIpcError(error, "Could not save.") },
			}));
		}
	};

	const clearAiProvider = async (provider: AiProvider) => {
		setAiStatus((current) => ({ ...current, [provider]: { state: "saving" } }));
		try {
			const config = await window.atlas.setAiConfig({ providers: { [provider]: { apiKey: "" } } });
			setAiConfig(config);
			setAiKeyDrafts((current) => ({ ...current, [provider]: "" }));
			setAiStatus((current) => ({ ...current, [provider]: { state: "idle", message: "Key removed" } }));
		} catch {
			setAiStatus((current) => ({
				...current,
				[provider]: { state: "error", message: "Could not clear." },
			}));
		}
	};

	const testAiProvider = async (provider: AiProvider) => {
		setAiStatus((current) => ({ ...current, [provider]: { state: "testing" } }));
		try {
			const result = await window.atlas.aiComplete({
				provider,
				prompt: "Reply with the single word: ok",
				maxTokens: 8,
			});
			if (result.ok) {
				const preview = result.text.trim().replace(/\s+/g, " ").slice(0, 40) || "ok";
				setAiStatus((current) => ({
					...current,
					[provider]: { state: "ok", message: `Connected · ${preview}` },
				}));
			} else {
				setAiStatus((current) => ({ ...current, [provider]: { state: "error", message: result.error } }));
			}
		} catch {
			setAiStatus((current) => ({
				...current,
				[provider]: { state: "error", message: "Request failed." },
			}));
		}
	};

	const setDefaultAiProvider = async (provider: AiProvider) => {
		try {
			const config = await window.atlas.setAiConfig({ defaultProvider: provider });
			setAiConfig(config);
		} catch {
			// Keep the current default if persistence fails.
		}
	};

	const updateNotch = (patch: Partial<NotchPreferences>) => {
		setNotchPrefs((current) => ({ ...current, ...patch }));
		void window.atlas.setNotchPreferences(patch);
	};

	const updateSuggestionPrefs = (patch: Partial<SuggestionPreferences>) => {
		setSuggestionPrefs((current) => ({ ...current, ...patch }));
		void window.atlas.setSuggestionPreferences(patch);
	};

	// Empty selection means "primary display only" by convention.
	const selectedDisplayIds =
		notchPrefs.displayIds.length > 0
			? notchPrefs.displayIds
			: displays.filter((display) => display.isPrimary).map((display) => display.id);

	const toggleNotchDisplay = (displayId: number) => {
		const isSelected = selectedDisplayIds.includes(displayId);
		// Keep at least one display selected.
		if (isSelected && selectedDisplayIds.length <= 1) {
			return;
		}
		const next = isSelected
			? selectedDisplayIds.filter((id) => id !== displayId)
			: [...selectedDisplayIds, displayId];
		updateNotch({ displayIds: next });
	};

	const toggleInfoItem = (id: NotchInfoItemConfig["id"]) => {
		const next = notchPrefs.infoItems.map((item) =>
			item.id === id ? { ...item, enabled: !item.enabled } : item,
		);
		updateNotch({ infoItems: next });
	};

	const moveInfoItem = (id: NotchInfoItemConfig["id"], direction: "up" | "down") => {
		const index = notchPrefs.infoItems.findIndex((item) => item.id === id);
		const targetIndex = direction === "up" ? index - 1 : index + 1;
		if (index < 0 || targetIndex < 0 || targetIndex >= notchPrefs.infoItems.length) {
			return;
		}
		const next = [...notchPrefs.infoItems];
		[next[index], next[targetIndex]] = [next[targetIndex], next[index]];
		updateNotch({ infoItems: next });
	};

	useEffect(() => {
		document.documentElement.dataset.theme = resolvedTheme;
		document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
		localStorage.setItem("atlas.theme", JSON.stringify(theme));
		void window.atlas.setNativeTheme(theme);
	}, [theme, resolvedTheme]);

	useEffect(() => {
		localStorage.setItem("atlas.settings.timeFormat", JSON.stringify(timeFormat));
		localStorage.setItem("atlas.settings.startWeekOn", JSON.stringify(startWeekOn));
		localStorage.setItem("atlas.settings.density", JSON.stringify(density));
		localStorage.setItem("atlas.settings.softAnimations", JSON.stringify(softAnimations));
		localStorage.setItem("atlas.settings.highlightSession", JSON.stringify(highlightSession));
		localStorage.setItem("atlas.settings.pinEnvironmentSwitcher", JSON.stringify(pinEnvironmentSwitcher));
		localStorage.setItem("atlas.settings.vimMode", JSON.stringify(vimMode));
		localStorage.setItem("atlas.settings.commandPalette", JSON.stringify(commandPalette));
	}, [
		timeFormat,
		startWeekOn,
		density,
		softAnimations,
		highlightSession,
		pinEnvironmentSwitcher,
		vimMode,
		commandPalette,
	]);

	useEffect(() => {
		localStorage.setItem("atlas.autoUpdates", JSON.stringify(autoUpdates));
	}, [autoUpdates]);

	useEffect(() => {
		localStorage.setItem("atlas.includeBetaUpdates", JSON.stringify(includeBetaUpdates));
	}, [includeBetaUpdates]);

	useEffect(() => {
		window.atlas
			.getAppVersion()
			.then((version) => {
				setAppVersion(version || null);
			})
			.catch(() => {
				setAppVersion(null);
			});
	}, []);

	useEffect(() => {
		window.atlas
			.getUpdatePreferences()
			.then((preferences) => {
				setAutoUpdates(preferences.autoCheck);
				setIncludeBetaUpdates(preferences.includeBeta);
			})
			.catch(() => {
				// LocalStorage fallbacks are already set for offline/dev resilience.
			});
	}, []);

	const loadUpdatesData = useCallback(
		async (withVersionScan = true) => {
			setIsCheckingUpdates(true);
			setUpdatesError(null);

			try {
				const [version, historyResponse] = await Promise.all([
					window.atlas.getAppVersion(),
					window.atlas.listReleaseHistory({
						includePrerelease: includeBetaUpdates,
					}),
				]);

				const latestCheck = withVersionScan
					? await window.atlas.checkForUpdates({
							includePrerelease: includeBetaUpdates,
						})
					: {
							local: version,
							hasUpdate: false,
							latest: null,
						};

				setUpdateInfo({ ...latestCheck, local: latestCheck.local || version });
				setAppVersion(version || null);
				setReleaseHistory(historyResponse.releases ?? []);

				if (historyResponse.error) {
					setUpdatesError(historyResponse.error);
				}
			} catch {
				setUpdatesError("Failed to load update information.");
			} finally {
				setIsCheckingUpdates(false);
			}
		},
		[includeBetaUpdates],
	);

	useEffect(() => {
		if (activeTab !== "updates") {
			return;
		}

		if (!updateInfo || releaseHistory.length === 0) {
			void loadUpdatesData(autoUpdates);
		}
	}, [activeTab, autoUpdates, includeBetaUpdates, loadUpdatesData, releaseHistory.length, updateInfo]);

	useEffect(() => {
		if (activeTab === "updates") {
			void loadUpdatesData(true);
		}
	}, [activeTab, includeBetaUpdates, loadUpdatesData]);

	const persistUpdatePreferences = async (nextAutoCheck: boolean, nextIncludeBeta: boolean) => {
		try {
			await window.atlas.setUpdatePreferences({
				autoCheck: nextAutoCheck,
				includeBeta: nextIncludeBeta,
			});
		} catch {
			// Keep local values active even if persistence fails.
		}
	};

	const handleToggleAutoUpdates = (nextValue: boolean) => {
		setAutoUpdates(nextValue);
		void persistUpdatePreferences(nextValue, includeBetaUpdates);
	};

	const handleToggleBetaUpdates = (nextValue: boolean) => {
		setIncludeBetaUpdates(nextValue);
		void persistUpdatePreferences(autoUpdates, nextValue);
	};

	const handleDownloadUpdate = () => {
		void (async () => {
			setIsInstallingUpdate(true);
			setUpdatesError(null);

			try {
				const result = await window.atlas.downloadAndInstallUpdate({
					includePrerelease: includeBetaUpdates,
				});
				if (!result.started) {
					if (updateInfo?.downloadUrl) {
						void window.atlas.launchApp(`start "" "${updateInfo.downloadUrl}"`);
					}
					if (result.error) {
						setUpdatesError(result.error);
					}
				}
			} catch {
				setUpdatesError("Failed to start the update installer.");
			} finally {
				setIsInstallingUpdate(false);
			}
		})();
	};

	const handleScanUpdates = () => {
		void loadUpdatesData(true);
	};

	return (
		<div className="atlas-settings-root text-neutral-900 dark:text-neutral-50">
			<motion.div
				className="atlas-settings-shell"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: 0.2, ease: "easeOut" }}
			>
				<header
					className={`titlebar sticky top-0 z-40 grid h-12.5 grid-cols-[1fr_1fr] items-center border-b border-neutral-200 bg-neutral-50 px-2.5 text-neutral-700 backdrop-blur-md [-webkit-app-region:drag] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${
						isMacPlatform ? "pl-21" : hasNativeControls ? "pr-36.5" : "pr-22"
					}`}
				>
					<div className="titlebar-left no-drag flex min-w-0 items-center gap-2 text-base">
						<img src={logo} alt="Atlas" className="h-7 w-7 shrink-0" />
					</div>
					<div className="titlebar-center absolute left-1/2 w-2/5 max-w-2xl min-w-72 -translate-x-1/2">
						<div className="inline-flex h-6 w-full items-center justify-center rounded-lg border border-neutral-300 px-2.5 py-0.5 text-body-small text-neutral-700 dark:border-neutral-500 dark:text-neutral-50">
							<span className="truncate text-neutral-800 dark:text-neutral-50">Settings</span>
						</div>
					</div>
					{!hasNativeControls && (
						<div className="titlebar-right no-drag absolute right-2 top-2.25 inline-flex gap-1">
							<button
								type="button"
								className="atlas-window-control"
								onClick={() => {
									void window.atlas.windowMinimize();
								}}
								aria-label="Minimize"
							>
								<MinusIcon className="h-4 w-4" />
							</button>
							<button
								type="button"
								className="atlas-window-control atlas-window-control-close"
								onClick={() => {
									void window.atlas.windowClose();
								}}
								aria-label="Close"
							>
								<XMarkIcon className="h-4 w-4" />
							</button>
						</div>
					)}
				</header>

				<div className="atlas-settings-body">
					<aside className="atlas-settings-sidebar atlas-card">
						<p className="atlas-settings-sidebar-title">Settings</p>
						<nav className="atlas-settings-nav">
							{settingsTabs.map((tab) => {
								const Icon = tab.icon;
								const isActive = tab.id === activeTab;
								return (
									<button
										key={tab.id}
										type="button"
										className={`atlas-settings-nav-item ${isActive ? "active" : ""}`}
										onClick={() => setActiveTab(tab.id)}
									>
										<Icon className="h-4 w-4" />
										<span>{tab.label}</span>
									</button>
								);
							})}
						</nav>
					</aside>

					<main className="atlas-settings-content">
						<AnimatePresence mode="wait">
							<motion.section
								key={activeTab}
								className="atlas-card atlas-settings-panel"
								initial={{ opacity: 0, x: 8 }}
								animate={{ opacity: 1, x: 0 }}
								exit={{ opacity: 0, x: -8 }}
								transition={{ duration: 0.16 }}
							>
								<header className="card-head">
									<h3 className="text-subtitle-small">{tabLabel}</h3>
									{activeTab === "updates" ? (
										<button
											type="button"
											onClick={handleScanUpdates}
											disabled={isCheckingUpdates}
											className="action-btn"
										>
											{isCheckingUpdates ? "Scanning..." : "Scan for updates"}
										</button>
									) : activeTab === "integrations" ? (
										<span>Stored on this device</span>
									) : activeTab === "findings" ? (
										<span>Nothing acts on its own</span>
									) : activeTab === "rules" ? (
										<span>Only what you turn on</span>
									) : (
										<span>Applies instantly</span>
									)}
								</header>

								{activeTab === "general" && (
									<div className="grid gap-3 md:grid-cols-2">
										<Select
											label="Time format"
											value={timeFormat}
											onChange={setTimeFormat}
											options={[
												{
													value: "24h",
													label: "24-hour",
													description: "13:00, 18:30",
												},
												{
													value: "12h",
													label: "12-hour",
													description: "1:00 PM, 6:30 PM",
												},
											]}
										/>
										<Select
											label="Week starts on"
											value={startWeekOn}
											onChange={setStartWeekOn}
											options={[
												{
													value: "monday",
													label: "Monday",
													description: "ISO week layout",
												},
												{
													value: "sunday",
													label: "Sunday",
													description: "US week layout",
												},
											]}
										/>
										<Select
											label="Interface density"
											value={density}
											onChange={setDensity}
											options={[
												{
													value: "compact",
													label: "Compact",
													description: "Tighter spacing",
												},
												{
													value: "comfortable",
													label: "Comfortable",
													description: "Balanced spacing",
												},
												{
													value: "spacious",
													label: "Spacious",
													description: "More breathing room",
												},
											]}
										/>
										<Toggle
											label="Pin map switcher"
											description="Always keep current map visible in titlebar"
											checked={pinEnvironmentSwitcher}
											onChange={setPinEnvironmentSwitcher}
										/>
									</div>
								)}

								{activeTab === "appearance" && (
									<div className="flex gap-3 flex-col">
										<div className="atlas-settings-card-stack">
											<ThemeModePicker value={theme} onChange={(nextTheme) => setTheme(nextTheme)} />
										</div>
										<div className="atlas-settings-card-stack">
											<AccentPicker value={accent} onChange={setAccent} />
										</div>
										<Toggle
											label="Soft panel animations"
											description="Smooth transitions between dashboard, notes and tasks"
											checked={softAnimations}
											onChange={setSoftAnimations}
										/>
										<Toggle
											label="Highlight active session"
											description="Keep the current recording context visually pinned"
											checked={highlightSession}
											onChange={setHighlightSession}
										/>
									</div>
								)}

								{activeTab === "notch" && (
									<div className="flex flex-col gap-4">
										<div className="atlas-settings-card-stack grid gap-3">
											<Toggle
												label="Enable smart notch"
												description="A small floating bar for quick navigation, your active environment and a position lock."
												checked={notchPrefs.enabled}
												onChange={(value) => updateNotch({ enabled: value })}
											/>

											{notchPrefs.enabled && (
												<div className="grid gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-600">
													<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
														Behavior &amp; position
													</span>
													<Select
														label="Run notch"
														value={notchPrefs.activation}
														onChange={(value) => updateNotch({ activation: value as NotchActivation })}
														options={[
															{
																value: "always",
																label: "Independently",
																description:
																	"Stays around even when Atlas's main window is closed, including at startup",
															},
															{
																value: "withMain",
																label: "Only with main window",
																description: "Only shows up while the main Atlas window is open",
															},
														]}
													/>
													<Select
														label="Notch position"
														value={notchPrefs.position}
														onChange={(value) => updateNotch({ position: value as NotchPosition })}
														options={[
															{
																value: "top",
																label: "Top center",
																description: "Docked flush against the top edge",
															},
															{ value: "left", label: "Left", description: "Middle of the left edge" },
															{ value: "right", label: "Right", description: "Middle of the right edge" },
															{
																value: "free",
																label: "Free floating",
																description: "Drag it anywhere you like",
															},
														]}
													/>
													<Select
														label="Idle transparency"
														value={notchPrefs.idleOpacity}
														onChange={(value) => updateNotch({ idleOpacity: value as NotchIdleOpacity })}
														options={[
															{
																value: "subtle",
																label: "Subtle",
																description: "Nearly invisible until you hover",
															},
															{
																value: "balanced",
																label: "Balanced",
																description: "Visible but unobtrusive",
															},
															{
																value: "solid",
																label: "Solid",
																description: "Always clearly visible",
															},
														]}
													/>
													<Toggle
														label="Lock position"
														description="Prevent the free-floating notch from being dragged accidentally"
														checked={notchPrefs.locked}
														onChange={(value) => updateNotch({ locked: value })}
													/>
												</div>
											)}
										</div>

										{notchPrefs.enabled && (
											<>
												{displays.length > 1 && (
													<div className="atlas-settings-card-stack grid gap-2">
														<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
															Show notch on
														</span>
														<div className="grid gap-1.5">
															{displays.map((display) => {
																const checked = selectedDisplayIds.includes(display.id);
																return (
																	<button
																		key={display.id}
																		type="button"
																		onClick={() => toggleNotchDisplay(display.id)}
																		className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm transition-colors hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-700/60"
																	>
																		<span className="text-neutral-700 dark:text-neutral-100">
																			{display.label}
																		</span>
																		<span
																			className={`flex h-4 w-4 items-center justify-center rounded border ${
																				checked
																					? "border-primary bg-primary"
																					: "border-neutral-300 dark:border-neutral-500"
																			}`}
																		>
																			{checked && <span className="h-2 w-2 rounded-sm bg-white" />}
																		</span>
																	</button>
																);
															})}
														</div>
													</div>
												)}

												<div className="atlas-settings-card-stack grid gap-2">
													<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
														Information screen
													</span>
													<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
														Shows only when there is something to display. Ranked top to bottom — the
														highest-ranked enabled item with information wins the slot.
													</p>
													<div className="grid gap-1.5">
														{notchPrefs.infoItems.map((item, index) => (
															<div
																key={item.id}
																className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-600"
															>
																<span className="text-neutral-700 dark:text-neutral-100">
																	{INFO_ITEM_LABELS[item.id]}
																</span>
																<div className="flex items-center gap-1.5">
																	<button
																		type="button"
																		onClick={() => moveInfoItem(item.id, "up")}
																		disabled={index === 0}
																		className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-700"
																		title="Move up"
																		aria-label="Move up"
																	>
																		<ChevronUpIcon className="h-3.5 w-3.5" />
																	</button>
																	<button
																		type="button"
																		onClick={() => moveInfoItem(item.id, "down")}
																		disabled={index === notchPrefs.infoItems.length - 1}
																		className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-700"
																		title="Move down"
																		aria-label="Move down"
																	>
																		<ChevronDownIcon className="h-3.5 w-3.5" />
																	</button>
																	<button
																		type="button"
																		onClick={() => toggleInfoItem(item.id)}
																		className={`flex h-4 w-4 items-center justify-center rounded border ${
																			item.enabled
																				? "border-primary bg-primary"
																				: "border-neutral-300 dark:border-neutral-500"
																		}`}
																		title={item.enabled ? "Disable" : "Enable"}
																		aria-label={item.enabled ? "Disable" : "Enable"}
																	>
																		{item.enabled && <span className="h-2 w-2 rounded-sm bg-white" />}
																	</button>
																</div>
															</div>
														))}
													</div>
												</div>

												<div className="atlas-settings-card-stack grid gap-3">
													<NotchTabsEditor />
												</div>

												{/* WP-2.8's control surface -- see WorkContextCard's own header
												    for why it belongs here and not on a tab of its own. */}
												<WorkContextCard />

												<div className="atlas-settings-card-stack grid gap-2">
													<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
														Suggestions
													</span>
													<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
														Atlas occasionally notices a repeated pattern and offers to automate it —
														shown quietly in the notch, never as a popup, at most a few times a day.
													</p>
													<Toggle
														label="Suggest automations"
														description="Offer one-click automations for patterns Atlas notices"
														checked={suggestionPrefs.enabled}
														onChange={(value) => updateSuggestionPrefs({ enabled: value })}
													/>
													{suggestionPrefs.enabled && (
														<>
															<Select
																label="Daily limit"
																value={String(suggestionPrefs.maxPerDay)}
																onChange={(value) => updateSuggestionPrefs({ maxPerDay: Number(value) })}
																options={[
																	{ value: "1", label: "1 per day", description: "The quietest setting" },
																	{ value: "2", label: "2 per day" },
																	{ value: "3", label: "3 per day" },
																	{ value: "5", label: "5 per day" },
																]}
															/>
															{/* WP-3.7: how quickly Atlas takes no for an answer. What it
															    has concluded so far, and the reset for it, live on the
															    Findings tab next to the patterns themselves. */}
															<Select
																label="Stop offering a kind of pattern after"
																value={String(suggestionPrefs.suppressAfterDismissals)}
																onChange={(value) =>
																	updateSuggestionPrefs({ suppressAfterDismissals: Number(value) })
																}
																options={[
																	{
																		value: "1",
																		label: "1 dismissal",
																		description: "Takes the first no as final",
																	},
																	{ value: "2", label: "2 in a row" },
																	{ value: "3", label: "3 in a row" },
																	{ value: "5", label: "5 in a row" },
																]}
															/>
														</>
													)}
												</div>
											</>
										)}
									</div>
								)}

								{activeTab === "files" && (
									<div className="flex flex-col gap-4">
										<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
											Atlas indexes file names, extensions, sizes and locations under the roots below so
											the launcher can find them by typing — never file contents. Excluded folders (
											{fileIndexPrefs.exclusions.slice(0, 6).join(", ")}
											{fileIndexPrefs.exclusions.length > 6 ? ", …" : ""}) are skipped everywhere they
											appear.
										</p>

										<div className="atlas-settings-card-stack grid gap-2">
											<div className="flex items-center justify-between">
												<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
													Scan roots
												</span>
												<button type="button" className="action-btn" onClick={() => void handleAddFileIndexRoot()}>
													Add folder
												</button>
											</div>

											<div className="grid gap-1.5">
												{fileIndexPrefs.roots.length === 0 && (
													<p className="m-0 text-sm text-neutral-500 dark:text-neutral-300">
														No roots configured yet.
													</p>
												)}
												{fileIndexPrefs.roots.map((root) => (
													<div
														key={root.id}
														className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-600"
													>
														<button
															type="button"
															onClick={() => void handleToggleFileIndexRoot(root.id, !root.enabled)}
															className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
																root.enabled
																	? "border-primary bg-primary"
																	: "border-neutral-300 dark:border-neutral-500"
															}`}
															title={root.enabled ? "Disable" : "Enable"}
															aria-label={root.enabled ? "Disable" : "Enable"}
														>
															{root.enabled && <span className="h-2 w-2 rounded-sm bg-white" />}
														</button>
														<div className="min-w-0 flex-1">
															<p className="m-0 truncate text-sm text-neutral-800 dark:text-neutral-100">
																{root.label}
															</p>
															<p className="m-0 truncate text-xs text-neutral-500 dark:text-neutral-400">
																{root.path}
															</p>
														</div>
														<select
															value={root.environmentId ?? ""}
															onChange={(event) =>
																void handleSetFileIndexRootEnvironment(root.id, event.target.value || null)
															}
															className="rounded-lg border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs text-neutral-700 outline-none focus:border-primary dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
														>
															<option value="">Global</option>
															{environments.map((environment) => (
																<option key={environment.id} value={environment.id}>
																	{environment.name}
																</option>
															))}
														</select>
														<button
															type="button"
															onClick={() => void handleRemoveFileIndexRoot(root.id)}
															className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
															title="Remove root"
															aria-label="Remove root"
														>
															<TrashIcon className="h-3.5 w-3.5" />
														</button>
													</div>
												))}
											</div>
										</div>

										<div className="atlas-settings-card-stack grid gap-2">
											<div className="flex items-center justify-between">
												<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
													Index status
												</span>
												{fileIndexStatus.state === "running" ? (
													<button type="button" className="action-btn" onClick={() => void handleCancelFileIndexCrawl()}>
														Cancel scan
													</button>
												) : (
													<button type="button" className="action-btn" onClick={() => void handleStartFileIndexCrawl()}>
														Run a scan now
													</button>
												)}
											</div>
											<p className="m-0 text-sm text-neutral-700 dark:text-neutral-200">
												{formatFileIndexState(fileIndexStatus)}
											</p>
											{fileIndexStatus.state === "running" && (
												<p className="m-0 text-xs text-neutral-500 dark:text-neutral-400">
													{fileIndexStatus.filesScanned.toLocaleString()} files ·{" "}
													{fileIndexStatus.dirsScanned.toLocaleString()} folders scanned
													{fileIndexStatus.currentRoot ? ` · currently in ${fileIndexStatus.currentRoot}` : ""}
												</p>
											)}
											<p className="m-0 text-xs text-neutral-500 dark:text-neutral-400">
												{(fileIndexStats?.totalFiles ?? 0).toLocaleString()} files indexed
											</p>
										</div>

										<div className="atlas-settings-card-stack grid gap-2">
											<div className="flex items-center justify-between">
												<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
													Live watching
												</span>
												{fileIndexWatchStatus.state === "watching" ? (
													<button type="button" className="action-btn" onClick={() => void handleStopFileIndexWatch()}>
														Stop watching
													</button>
												) : (
													<button type="button" className="action-btn" onClick={() => void handleStartFileIndexWatch()}>
														Start watching
													</button>
												)}
											</div>
											<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
												Keeps the index current between scans by reacting to file changes under the enabled
												roots above, instead of waiting for the next "Run a scan now". Off by default — turning
												it on only takes effect for this app session, exactly like a scan does.
											</p>
											<p className="m-0 text-sm text-neutral-700 dark:text-neutral-200">
												{formatFileIndexWatchState(fileIndexWatchStatus)}
											</p>
											{fileIndexWatchStatus.state === "watching" && (
												<p className="m-0 text-xs text-neutral-500 dark:text-neutral-400">
													{fileIndexWatchStatus.rootsWatched.toLocaleString()} root(s) watched
													{fileIndexWatchStatus.onBattery ? " · on battery (checking less often)" : ""}
												</p>
											)}
										</div>
									</div>
								)}

								{activeTab === "rules" && <SmartFunctionsPanel environments={environments} />}

								{activeTab === "findings" && <FindingsPanel environments={environments} />}

								{activeTab === "integrations" && (
									<div className="flex flex-col gap-4">
										<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
											Connect your own AI provider keys to power Atlas' smart features. Keys are stored
											locally on this device and are only ever sent to the provider you choose.
										</p>

										{aiConfig ? (
											<>
												<Select
													label="Default provider"
													value={aiConfig.defaultProvider}
													onChange={(value) => void setDefaultAiProvider(value as AiProvider)}
													options={AI_PROVIDER_ORDER.map((provider) => ({
														value: provider,
														label: aiConfig.providers[provider].label,
														description: aiConfig.providers[provider].hasKey
															? "Key connected"
															: "No key yet",
													}))}
												/>

												{AI_PROVIDER_ORDER.map((provider) => {
													const info = aiConfig.providers[provider];
													const hint = AI_PROVIDER_HINTS[provider];
													const status = aiStatus[provider];
													return (
														<div key={provider} className="atlas-settings-card-stack grid gap-2">
															<div className="flex items-center justify-between">
																<span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
																	{info.label}
																</span>
																<span
																	className={`inline-flex items-center gap-1.5 text-xs ${
																		info.hasKey
																			? "text-emerald-600 dark:text-emerald-400"
																			: "text-neutral-500 dark:text-neutral-400"
																	}`}
																>
																	<span
																		className={`h-2 w-2 rounded-full ${
																			info.hasKey ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-500"
																		}`}
																	/>
																	{info.hasKey ? "Key connected" : "Not connected"}
																</span>
															</div>

															<label className="grid gap-1 text-xs text-neutral-500 dark:text-neutral-300">
																API key
																<input
																	type="password"
																	value={aiKeyDrafts[provider]}
																	onChange={(event) =>
																		setAiKeyDrafts((current) => ({ ...current, [provider]: event.target.value }))
																	}
																	placeholder={
																		info.hasKey ? "•••••••• stored — type to replace" : hint.keyPlaceholder
																	}
																	autoComplete="off"
																	className="rounded-lg border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm text-neutral-800 outline-none focus:border-primary dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
																/>
																<span className="text-[11px] text-neutral-400">{hint.help}</span>
															</label>

															<label className="grid gap-1 text-xs text-neutral-500 dark:text-neutral-300">
																Model
																<input
																	type="text"
																	value={aiModelDrafts[provider]}
																	onChange={(event) =>
																		setAiModelDrafts((current) => ({ ...current, [provider]: event.target.value }))
																	}
																	placeholder="model id"
																	autoComplete="off"
																	spellCheck={false}
																	className="rounded-lg border border-neutral-200 bg-neutral-0 px-3 py-2 font-data text-sm text-neutral-800 outline-none focus:border-primary dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
																/>
															</label>

															<div className="flex flex-wrap items-center gap-2">
																<button
																	type="button"
																	className="action-btn"
																	onClick={() => void saveAiProvider(provider)}
																	disabled={status.state === "saving"}
																>
																	{status.state === "saving" ? "Saving..." : "Save"}
																</button>
																<button
																	type="button"
																	className="action-btn"
																	onClick={() => void testAiProvider(provider)}
																	disabled={!info.hasKey || status.state === "testing"}
																>
																	{status.state === "testing" ? "Testing..." : "Test connection"}
																</button>
																{info.hasKey && (
																	<button
																		type="button"
																		className="action-btn"
																		onClick={() => void clearAiProvider(provider)}
																	>
																		Remove key
																	</button>
																)}
																{status.message && (
																	<span
																		className={`text-xs ${
																			status.state === "error"
																				? "text-orange-600 dark:text-orange-400"
																				: status.state === "ok"
																					? "text-emerald-600 dark:text-emerald-400"
																					: "text-neutral-500 dark:text-neutral-400"
																		}`}
																	>
																		{status.message}
																	</span>
																)}
															</div>
														</div>
													);
												})}
											</>
										) : (
											<p className="m-0 text-sm text-neutral-500 dark:text-neutral-300">
												Loading integrations…
											</p>
										)}
									</div>
								)}

								{activeTab === "keybindings" && (
									<div className="grid gap-3">
										<Toggle
											label="Vim keybindings"
											description="Use hjkl navigation and modal editing shortcuts"
											checked={vimMode}
											onChange={setVimMode}
										/>
										<Toggle
											label="Command palette shortcuts"
											description="Enable global shortcut to open the command palette"
											checked={commandPalette}
											onChange={setCommandPalette}
										/>
										<div className="atlas-settings-shortcuts atlas-settings-card-stack">
											<div>
												<span>Open command palette</span>
												<kbd>Ctrl</kbd>
												<kbd>K</kbd>
											</div>
											<div>
												<span>Start/stop timer</span>
												<kbd>Ctrl</kbd>
												<kbd>Shift</kbd>
												<kbd>S</kbd>
											</div>
										</div>
									</div>
								)}

								{activeTab === "updates" && (
									<div className="grid gap-3">
										<Toggle
											label="Automatic update checks"
											description="Check for updates automatically when Atlas starts"
											checked={autoUpdates}
											onChange={handleToggleAutoUpdates}
										/>

										<Toggle
											label="Beta updates"
											description="Allow pre-release and beta versions"
											checked={includeBetaUpdates}
											onChange={handleToggleBetaUpdates}
										/>

										<div className="atlas-settings-card-stack">
											<div>
												<div>
													<p className="m-0 text-[11px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
														Current version
													</p>
													<p className="mt-1 mb-0 text-sm font-medium text-neutral-800 dark:text-neutral-100">
														{localDisplayVersion ? `v${localDisplayVersion}` : "Loading..."}
													</p>
													<p className="mt-1 mb-0 text-xs text-neutral-500 dark:text-neutral-300">
														Published:{" "}
														{currentRelease?.publishedAt
															? new Date(currentRelease.publishedAt).toLocaleString()
															: "Unknown"}
													</p>
												</div>
											</div>

											{updateInfo?.hasUpdate ? (
												<p className="mt-3 mb-0 text-xs font-semibold text-orange-600 dark:text-orange-400">
													Update available: v{updateInfo.latest}
												</p>
											) : (
												<p className="mt-3 mb-0 text-xs text-neutral-500 dark:text-neutral-300">Up to date</p>
											)}
											{updateInfo?.hasUpdate && updateInfo.downloadUrl && (
												<button
													type="button"
													onClick={handleDownloadUpdate}
													disabled={isInstallingUpdate}
													className="action-btn mt-3"
												>
													{isInstallingUpdate ? "Preparing install..." : "Install update"}
												</button>
											)}
										</div>

										<div className="atlas-settings-card-stack">
											<p className="m-0 text-[11px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
												Published versions
											</p>
											{releaseHistory.length > 0 ? (
												<ul className="simple-list mt-2">
													{releaseHistory.map((release) => (
														<li key={release.tag}>
															<div>
																<span>{release.name}</span>
																<small>
																	v{release.version}
																	{release.publishedAt
																		? ` • ${new Date(release.publishedAt).toLocaleDateString()}`
																		: ""}
																	{release.prerelease ? " • prerelease" : ""}
																	{release.draft ? " • draft" : ""}
																</small>
															</div>
															{release.url ? (
																<button
																	type="button"
																	onClick={() => {
																		void window.atlas.launchApp(`start "" "${release.url}"`);
																	}}
																	className="action-btn"
																>
																	Open
																</button>
															) : null}
														</li>
													))}
												</ul>
											) : (
												<p className="mt-2 mb-0 text-sm text-neutral-600 dark:text-neutral-300">
													No release history loaded yet.
												</p>
											)}
											{updatesError && (
												<p className="mt-2 mb-0 text-xs text-orange-700 dark:text-orange-300">
													{updatesError}
												</p>
											)}
										</div>
									</div>
								)}
							</motion.section>
						</AnimatePresence>
					</main>
				</div>
			</motion.div>
		</div>
	);
}
