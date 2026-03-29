import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MinusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { ArrowPathIcon, CommandLineIcon, PaintBrushIcon, WrenchScrewdriverIcon } from "@heroicons/react/24/solid";
import { Select, ThemeModePicker, Toggle } from "../ui";
import type { AppRelease, UpdateCheckResult } from "../../types";
import logo from "../../assets/logosmall.png";

type SettingsTab = "general" | "appearance" | "keybindings" | "updates";

type ThemeOption = "dark" | "light" | "system";

const settingsTabs: Array<{ id: SettingsTab; label: string; icon: typeof WrenchScrewdriverIcon }> = [
	{ id: "general", label: "General", icon: WrenchScrewdriverIcon },
	{ id: "appearance", label: "Appearance", icon: PaintBrushIcon },
	{ id: "keybindings", label: "Keybindings", icon: CommandLineIcon },
	{ id: "updates", label: "Updates", icon: ArrowPathIcon },
];

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
	const [timeFormat, setTimeFormat] = useState(() => readStorage("atlas.settings.timeFormat", "24h"));
	const [startWeekOn, setStartWeekOn] = useState(() => readStorage("atlas.settings.startWeekOn", "monday"));
	const [density, setDensity] = useState(() => readStorage("atlas.settings.density", "comfortable"));
	const [softAnimations, setSoftAnimations] = useState(() => readStorage("atlas.settings.softAnimations", true));
	const [highlightSession, setHighlightSession] = useState(() =>
		readStorage("atlas.settings.highlightSession", true),
	);
	const [pinMapSwitcher, setPinMapSwitcher] = useState(() => readStorage("atlas.settings.pinMapSwitcher", false));
	const [vimMode, setVimMode] = useState(() => readStorage("atlas.settings.vimMode", false));
	const [commandPalette, setCommandPalette] = useState(() => readStorage("atlas.settings.commandPalette", true));
	const [autoUpdates, setAutoUpdates] = useState(() => readStorage("atlas.autoUpdates", true));
	const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
	const [releaseHistory, setReleaseHistory] = useState<AppRelease[]>([]);
	const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
	const [updatesError, setUpdatesError] = useState<string | null>(null);

	const tabLabel = useMemo(() => settingsTabs.find((tab) => tab.id === activeTab)?.label ?? "General", [activeTab]);
	const currentRelease = useMemo(() => {
		const localVersion = updateInfo?.local?.replace(/^v/i, "");
		if (!localVersion) {
			return null;
		}

		return (
			releaseHistory.find((release) => release.version === localVersion || release.tag === `v${localVersion}`) ?? null
		);
	}, [releaseHistory, updateInfo?.local]);
	const isMacPlatform = platform === "darwin";
	const hasNativeControls = platform === "darwin" || platform === "win32";

	useEffect(() => {
		window.atlas
			.getPlatform()
			.then((value) => setPlatform(value || "win32"))
			.catch(() => setPlatform("win32"));
	}, []);

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
		localStorage.setItem("atlas.settings.pinMapSwitcher", JSON.stringify(pinMapSwitcher));
		localStorage.setItem("atlas.settings.vimMode", JSON.stringify(vimMode));
		localStorage.setItem("atlas.settings.commandPalette", JSON.stringify(commandPalette));
	}, [timeFormat, startWeekOn, density, softAnimations, highlightSession, pinMapSwitcher, vimMode, commandPalette]);

	useEffect(() => {
		localStorage.setItem("atlas.autoUpdates", JSON.stringify(autoUpdates));
	}, [autoUpdates]);

	const loadUpdatesData = async (withVersionScan = true) => {
		setIsCheckingUpdates(true);
		setUpdatesError(null);

		try {
			const [version, historyResponse] = await Promise.all([
				window.atlas.getAppVersion(),
				window.atlas.listReleaseHistory(),
			]);

			const latestCheck = withVersionScan
				? await window.atlas.checkForUpdates()
				: {
						local: version,
						hasUpdate: false,
						latest: null,
				  	};

			setUpdateInfo({ ...latestCheck, local: latestCheck.local || version });
			setReleaseHistory(historyResponse.releases ?? []);

			if (historyResponse.error) {
				setUpdatesError(historyResponse.error);
			}
		} catch {
			setUpdatesError("Failed to load update information.");
		} finally {
			setIsCheckingUpdates(false);
		}
	};

	useEffect(() => {
		if (activeTab !== "updates") {
			return;
		}

		if (!updateInfo || releaseHistory.length === 0) {
			void loadUpdatesData(autoUpdates);
		}
	}, [activeTab, autoUpdates, releaseHistory.length, updateInfo]);

	const handleDownloadUpdate = () => {
		if (!updateInfo?.downloadUrl) {
			return;
		}

		void window.atlas.launchApp(`start "" "${updateInfo.downloadUrl}"`);
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
						<img
							src={logo}
							alt="Atlas Logo"
							className="h-7 w-7 shrink-0"
						/>
						<span>Atlas</span>
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
												{ value: "24h", label: "24-hour", description: "13:00, 18:30" },
												{ value: "12h", label: "12-hour", description: "1:00 PM, 6:30 PM" },
											]}
										/>
										<Select
											label="Week starts on"
											value={startWeekOn}
											onChange={setStartWeekOn}
											options={[
												{ value: "monday", label: "Monday", description: "ISO week layout" },
												{ value: "sunday", label: "Sunday", description: "US week layout" },
											]}
										/>
										<Select
											label="Interface density"
											value={density}
											onChange={setDensity}
											options={[
												{ value: "compact", label: "Compact", description: "Tighter spacing" },
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
											checked={pinMapSwitcher}
											onChange={setPinMapSwitcher}
										/>
									</div>
								)}

								{activeTab === "appearance" && (
									<div className="grid gap-3 md:grid-cols-2">
										<div className="atlas-settings-card-stack">
											<ThemeModePicker
												value={theme}
												onChange={(nextTheme) => setTheme(nextTheme)}
											/>
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
											description="Scan automatically when opening this Updates tab"
											checked={autoUpdates}
											onChange={setAutoUpdates}
										/>

										<div className="atlas-settings-card-stack">
											<div>
												<div>
													<p className="m-0 text-[11px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
														Current version
													</p>
													<p className="mt-1 mb-0 text-sm font-medium text-neutral-800 dark:text-neutral-100">
														v{updateInfo?.local ?? "Loading..."}
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
													className="action-btn mt-3"
												>
													Download installer
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
												<p className="mt-2 mb-0 text-xs text-orange-700 dark:text-orange-300">{updatesError}</p>
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
