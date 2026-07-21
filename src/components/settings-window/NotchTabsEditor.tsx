import { useEffect, useState } from "react";
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronUpDownIcon,
	PlusIcon,
	Squares2X2Icon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import { NotchTabGridEditor } from "./NotchTabGridEditor";
import { TAB_ICON_MAP } from "./tabIconMap";
import { Toggle } from "../ui";
import { NOTCH_TAB_ICONS } from "../../types";
import type { NotchTab, NotchTabIcon } from "../../types";

let nextTabSuffix = 0;
const createTabId = () => `tab-${Date.now()}-${nextTabSuffix++}`;

// Mirrors NotchTabGridEditor.tsx's/NotchApp.tsx's own lastEnvironmentId() --
// the same localStorage key App.tsx keeps in sync with the selected
// environment (and NotchApp.tsx's own switcher updates directly), shared
// across every window on this origin. `null` means no environment is
// selected yet (e.g. before the very first one is created), in which case
// this editor falls back to editing the plain global preferences exactly as
// it did before WP-1.3 -- there is no environment to scope an override to.
const lastEnvironmentId = () => {
	try {
		return localStorage.getItem("atlas.lastEnvironmentId");
	} catch {
		return null;
	}
};

// Self-contained: reads/writes notch tabs directly via the same IPC the rest
// of the notch preferences use, so it can be dropped into the Settings
// window's Smart Notch tab and into the standalone Action Editor window
// without either one owning the state.
export function NotchTabsEditor({ centered = false }: { centered?: boolean } = {}) {
	// Captured once at mount, not re-read reactively -- matches the existing
	// level of sophistication SceneConfigEditor.tsx/NotchTabGridEditor.tsx
	// already have around this same key. Both this editor's windows (the
	// modal Settings window, and the standalone Action Editor window) are
	// short-lived and single-purpose; a user does not switch environments
	// mid-edit in practice.
	const [environmentId] = useState<string | null>(() => lastEnvironmentId());
	const [environmentName, setEnvironmentName] = useState<string | null>(null);
	// Whether `environmentId` currently inherits the global default (true) or
	// has its own layout (false). Meaningless when `environmentId` is null.
	const [usesDefault, setUsesDefault] = useState(true);
	const [tabs, setTabs] = useState<NotchTab[]>([]);
	const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
	const [tabSelectOpen, setTabSelectOpen] = useState(false);
	const [iconPickerOpen, setIconPickerOpen] = useState(false);

	useEffect(() => {
		if (!environmentId) {
			// No environment context at all -- fall back to the plain global
			// preferences exactly as this editor worked before WP-1.3.
			window.atlas
				.getNotchPreferences()
				.then((prefs) => setTabs(prefs.tabs))
				.catch(() => undefined);
			const unsubscribe = window.atlas.onNotchPreferencesChanged?.((prefs) => setTabs(prefs.tabs));
			return () => unsubscribe?.();
		}

		window.atlas
			.listEnvironments()
			.then((environments) => {
				setEnvironmentName(environments.find((environment) => environment.id === environmentId)?.name ?? null);
			})
			.catch(() => setEnvironmentName(null));

		window.atlas
			.getNotchLayoutForEnvironment(environmentId)
			.then((resolution) => {
				setUsesDefault(resolution.usesDefault);
				setTabs(resolution.preferences.tabs);
			})
			.catch(() => undefined);
		return undefined;
	}, [environmentId]);

	// Every tab/grid mutation (add/remove/rename/reorder tab, and every grid
	// placement edit inside NotchTabGridEditor, which bubbles back up through
	// updateTab below) lands here. Deliberately NEVER goes through the
	// ambient `notch:setPreferences` channel for a scoped environment: that
	// channel always targets "whatever's currently active" in the main
	// process, which is not necessarily `environmentId` (the Action Editor
	// window is not modal -- the active environment really can change while
	// it's open). `usesDefault` decides whether this edit lands on the
	// shared global default or forks/updates this environment's own layout.
	const updateTabs = (nextTabs: NotchTab[]) => {
		setTabs(nextTabs);
		if (!environmentId) {
			void window.atlas.setNotchPreferences({ tabs: nextTabs });
		} else if (usesDefault) {
			void window.atlas.setDefaultNotchLayout({ tabs: nextTabs });
		} else {
			void window.atlas.setEnvironmentNotchLayout(environmentId, { tabs: nextTabs });
		}
	};

	// Flips between "this environment uses the global default" and "this
	// environment has its own layout". Turning custom ON forks a layout
	// seeded from whatever is currently effective (nothing visually jumps the
	// instant the toggle flips); turning it back OFF discards the reference
	// (the row itself is never deleted -- see db.cjs#clearEnvironmentNotchLayout)
	// and reverts to the default.
	const toggleUsesDefault = async (nextUsesDefault: boolean) => {
		if (!environmentId) {
			return;
		}
		const resolution = nextUsesDefault
			? await window.atlas.clearEnvironmentNotchLayout(environmentId)
			: await window.atlas.setEnvironmentNotchLayout(environmentId, {});
		setUsesDefault(resolution.usesDefault);
		setTabs(resolution.preferences.tabs);
	};

	const addTab = () => {
		const id = createTabId();
		updateTabs([
			...tabs,
			{ id, label: "New tab", icon: "Squares2X2Icon", gridCols: 5, gridRows: 1, placements: [] },
		]);
		setSelectedTabId(id);
	};

	const removeTab = (id: string) => updateTabs(tabs.filter((tab) => tab.id !== id));

	const renameTab = (id: string, label: string) =>
		updateTabs(tabs.map((tab) => (tab.id === id ? { ...tab, label } : tab)));

	const setTabIcon = (id: string, icon: NotchTabIcon) =>
		updateTabs(tabs.map((tab) => (tab.id === id ? { ...tab, icon } : tab)));

	const updateTab = (id: string, nextTab: NotchTab) =>
		updateTabs(tabs.map((tab) => (tab.id === id ? nextTab : tab)));

	const moveTab = (id: string, direction: "up" | "down") => {
		const index = tabs.findIndex((tab) => tab.id === id);
		const targetIndex = direction === "up" ? index - 1 : index + 1;
		if (index < 0 || targetIndex < 0 || targetIndex >= tabs.length) return;
		const next = [...tabs];
		[next[index], next[targetIndex]] = [next[targetIndex], next[index]];
		updateTabs(next);
	};

	const selectedTab = tabs.find((tab) => tab.id === selectedTabId) ?? tabs[0] ?? null;

	return (
		<>
			{environmentId && (
				<Toggle
					label={`Layout for ${environmentName ?? "this environment"}`}
					description={
						usesDefault
							? "Using the global default — edits here also change what every other environment without its own layout shows."
							: "This environment has its own layout, separate from the global default."
					}
					checked={!usesDefault}
					onChange={(nextChecked) => void toggleUsesDefault(!nextChecked)}
				/>
			)}

			<div className={centered ? "text-center" : ""}>
				<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
					Action buttons
				</span>
				<p className="m-0 mt-1 text-xs text-neutral-500 dark:text-neutral-300">
					Each tab is a button on the notch. Clicking one opens a small panel laid out as a grid — not the
					main window.
				</p>
			</div>

			<div className={`flex items-center gap-2 ${centered ? "justify-center" : ""}`}>
				<div className="relative">
					<button
						type="button"
						onClick={() => setTabSelectOpen((open) => !open)}
						className="flex min-w-48 items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
					>
						<span className="flex items-center gap-2 truncate">
							{selectedTab ? (
								<>
									{(() => {
										const SelectedIcon = TAB_ICON_MAP[selectedTab.icon] ?? Squares2X2Icon;
										return <SelectedIcon className="h-4 w-4 shrink-0" />;
									})()}
									<span className="truncate">{selectedTab.label}</span>
								</>
							) : (
								<span className="text-neutral-400">No tabs yet</span>
							)}
						</span>
						<ChevronUpDownIcon className="h-4 w-4 shrink-0 text-neutral-400" />
					</button>

					{tabSelectOpen && (
						<>
							<div className="fixed inset-0 z-40" onClick={() => setTabSelectOpen(false)} />
							<div className="absolute left-0 top-full z-50 mt-1 grid w-64 gap-0.5 rounded-lg border border-neutral-200 bg-neutral-0 p-1.5 shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
								{tabs.map((tab, index) => {
									const RowIcon = TAB_ICON_MAP[tab.icon] ?? Squares2X2Icon;
									return (
										<div
											key={tab.id}
											className="flex items-center gap-0.5 rounded-md px-1 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
										>
											<button
												type="button"
												onClick={() => {
													setSelectedTabId(tab.id);
													setTabSelectOpen(false);
												}}
												className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left text-sm text-neutral-700 dark:text-neutral-100"
											>
												<RowIcon className="h-4 w-4 shrink-0" />
												<span className="truncate">{tab.label}</span>
											</button>
											<button
												type="button"
												onClick={() => moveTab(tab.id, "up")}
												disabled={index === 0}
												className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-600"
												title="Move left"
												aria-label="Move left"
											>
												<ChevronLeftIcon className="h-3.5 w-3.5" />
											</button>
											<button
												type="button"
												onClick={() => moveTab(tab.id, "down")}
												disabled={index === tabs.length - 1}
												className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-600"
												title="Move right"
												aria-label="Move right"
											>
												<ChevronRightIcon className="h-3.5 w-3.5" />
											</button>
											<button
												type="button"
												onClick={() => removeTab(tab.id)}
												className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-neutral-300 dark:hover:bg-red-950/40 dark:hover:text-red-400"
												title="Remove tab"
												aria-label="Remove tab"
											>
												<TrashIcon className="h-3.5 w-3.5" />
											</button>
										</div>
									);
								})}
								<button
									type="button"
									onClick={() => {
										addTab();
										setTabSelectOpen(false);
									}}
									className="mt-0.5 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
								>
									<PlusIcon className="h-4 w-4" />
									Add tab
								</button>
							</div>
						</>
					)}
				</div>
			</div>

			{selectedTab && (
				<div className="grid gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-600">
					<div className="flex items-center gap-2">
						<div className="relative">
							<button
								type="button"
								onClick={() => setIconPickerOpen((open) => !open)}
								title="Change icon"
								aria-label="Change icon"
								className="flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
							>
								{(() => {
									const SelectedIcon = TAB_ICON_MAP[selectedTab.icon] ?? Squares2X2Icon;
									return <SelectedIcon className="h-5 w-5" />;
								})()}
							</button>

							{iconPickerOpen && (
								<>
									<div className="fixed inset-0 z-40" onClick={() => setIconPickerOpen(false)} />
									<div
										className="absolute left-0 top-full z-50 mt-1 grid max-h-72 gap-2 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-0 p-3 shadow-lg dark:border-neutral-600 dark:bg-neutral-800"
										style={{ gridTemplateColumns: "repeat(7, 2.5rem)" }}
									>
										{NOTCH_TAB_ICONS.map((iconKey) => {
											const OptionIcon = TAB_ICON_MAP[iconKey];
											const isIconSelected = selectedTab.icon === iconKey;
											return (
												<button
													key={iconKey}
													type="button"
													onClick={() => {
														setTabIcon(selectedTab.id, iconKey);
														setIconPickerOpen(false);
													}}
													title={iconKey}
													aria-label={`Icon: ${iconKey}`}
													className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border transition-colors ${
														isIconSelected
															? "border-primary bg-primary/10 text-primary"
															: "border-transparent text-neutral-500 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
													}`}
												>
													<OptionIcon className="h-5 w-5" />
												</button>
											);
										})}
									</div>
								</>
							)}
						</div>

						<input
							type="text"
							value={selectedTab.label}
							onChange={(event) => renameTab(selectedTab.id, event.target.value)}
							placeholder="Tab name"
							className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-transparent px-3 py-2 text-sm text-neutral-800 outline-none focus:border-primary dark:border-neutral-600 dark:text-neutral-100"
						/>
					</div>

					<NotchTabGridEditor tab={selectedTab} onChange={(nextTab) => updateTab(selectedTab.id, nextTab)} />
				</div>
			)}
		</>
	);
}
