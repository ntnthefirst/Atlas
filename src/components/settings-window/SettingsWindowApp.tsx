import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MinusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { CommandLineIcon, PaintBrushIcon, WrenchScrewdriverIcon } from "@heroicons/react/24/solid";
import { Select, ThemeModePicker, Toggle } from "../ui";
import logo from "../../assets/logosmall.png";

type SettingsTab = "general" | "appearance" | "keybindings";

type ThemeOption = "dark" | "light" | "system";

const settingsTabs: Array<{ id: SettingsTab; label: string; icon: typeof WrenchScrewdriverIcon }> = [
	{ id: "general", label: "General", icon: WrenchScrewdriverIcon },
	{ id: "appearance", label: "Appearance", icon: PaintBrushIcon },
	{ id: "keybindings", label: "Keybindings", icon: CommandLineIcon },
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
	const [theme, setTheme] = useState<ThemeOption>(() => readStorage("atlas.theme", "light"));
	const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">("light");
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

	const tabLabel = useMemo(() => settingsTabs.find((tab) => tab.id === activeTab)?.label ?? "General", [activeTab]);

	useEffect(() => {
		if (theme !== "system") {
			setResolvedTheme(theme);
			return;
		}

		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const updateResolvedTheme = (event?: MediaQueryListEvent) => {
			setResolvedTheme(event ? (event.matches ? "dark" : "light") : mediaQuery.matches ? "dark" : "light");
		};
		updateResolvedTheme();
		mediaQuery.addEventListener("change", updateResolvedTheme);

		return () => mediaQuery.removeEventListener("change", updateResolvedTheme);
	}, [theme]);

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

	return (
		<div className="atlas-settings-root text-neutral-900 dark:text-neutral-50">
			<motion.div
				className="atlas-settings-shell"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: 0.2, ease: "easeOut" }}
			>
				<header className="titlebar sticky top-0 z-40 grid h-[50px] grid-cols-[1fr_1fr] items-center border-b border-neutral-200 bg-neutral-50 px-2.5 text-neutral-700 backdrop-blur-md [-webkit-app-region:drag] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 pr-[88px]">
					<div className="titlebar-left no-drag flex min-w-0 items-center gap-2 text-base">
						<img
							src={logo}
							alt="Atlas Logo"
							className="h-7 w-7 flex-shrink-0"
						/>
						<span>Atlas</span>
					</div>
					<div className="titlebar-right no-drag absolute right-2 top-[9px] inline-flex gap-1">
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
									<span>Applies instantly</span>
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
							</motion.section>
						</AnimatePresence>
					</main>
				</div>
			</motion.div>
		</div>
	);
}
