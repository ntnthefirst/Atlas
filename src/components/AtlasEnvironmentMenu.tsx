import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftIcon, PencilIcon, PlusIcon, SwatchIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { Environment } from "../types";
import { AccentPicker } from "./ui";
import {
	ENVIRONMENT_ICON_KEYS,
	ENVIRONMENT_PRESETS,
	getEnvironmentIcon,
	type EnvironmentPresetTemplate,
} from "../environments";
import { DEFAULT_ACCENT } from "../utils/accent";

type AtlasEnvironmentMenuProps = {
	showEnvironmentMenu: boolean;
	selectedEnvironmentId: string;
	environments: Environment[];
	renameEnvironmentName: string;
	newEnvironmentName: string;
	canDeleteEnvironment: boolean;
	triggerRef: RefObject<HTMLButtonElement | null>;
	onCloseEnvironmentMenu: () => void;
	onSelectEnvironment: (environmentId: string) => void;
	onRenameEnvironmentNameChange: (nextValue: string) => void;
	onNewEnvironmentNameChange: (nextValue: string) => void;
	onCreateEnvironment: () => void;
	onRenameEnvironment: () => void;
	onDeleteEnvironment: () => void;
	onCreatePresetEnvironment: (preset: EnvironmentPresetTemplate) => void;
	onUpdateEnvironment: (fields: Partial<Pick<Environment, "name" | "icon" | "accent" | "preset">>) => void;
};

type MenuScreen = "default" | "create-map" | "rename-current" | "customize";
type DefaultAction = "rename" | "customize" | "delete" | "create";
type DefaultNavItem = { kind: "action"; action: DefaultAction } | { kind: "map"; environmentId: string };

const menuInputClassName =
	"h-8 w-full rounded-md border border-neutral-300 bg-neutral-50 pl-8 pr-2.5 text-[13px] text-neutral-700 outline-none transition focus:border-neutral-500 dark:border-neutral-500 dark:bg-neutral-700 dark:text-neutral-50";

export function AtlasEnvironmentMenu({
	showEnvironmentMenu,
	selectedEnvironmentId,
	environments,
	renameEnvironmentName,
	newEnvironmentName,
	canDeleteEnvironment,
	triggerRef,
	onCloseEnvironmentMenu,
	onSelectEnvironment,
	onRenameEnvironmentNameChange,
	onNewEnvironmentNameChange,
	onCreateEnvironment,
	onRenameEnvironment,
	onDeleteEnvironment,
	onCreatePresetEnvironment,
	onUpdateEnvironment,
}: AtlasEnvironmentMenuProps) {
	const selectedEnvironment = environments.find((environmentItem) => environmentItem.id === selectedEnvironmentId) ?? null;
	const menuRef = useRef<HTMLDivElement | null>(null);
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const editorInputRef = useRef<HTMLInputElement | null>(null);
	const [menuScreen, setMenuScreen] = useState<MenuScreen>("default");
	const [activeItemIndex, setActiveItemIndex] = useState(0);
	const [environmentSearch, setEnvironmentSearch] = useState("");
	const [createEnvironmentError, setCreateEnvironmentError] = useState("");
	const [renameEnvironmentError, setRenameEnvironmentError] = useState("");

	const otherEnvironments = useMemo(() => environments.filter((environmentItem) => environmentItem.id !== selectedEnvironmentId), [environments, selectedEnvironmentId]);
	const filteredEnvironments = useMemo(() => {
		const query = environmentSearch.trim().toLowerCase();
		if (!query) {
			return otherEnvironments;
		}
		return otherEnvironments.filter((environmentItem) => environmentItem.name.toLowerCase().includes(query));
	}, [environmentSearch, otherEnvironments]);

	const filteredActions = useMemo(() => {
		const query = environmentSearch.trim().toLowerCase();
		const actions: Array<{ action: DefaultAction; label: string; disabled?: boolean }> = [
			{ action: "rename", label: "rename environment" },
			{ action: "customize", label: "customize environment icon color" },
			{ action: "delete", label: "delete environment", disabled: !canDeleteEnvironment },
			{ action: "create", label: "new environment" },
		];

		if (!query) {
			return actions;
		}

		return actions.filter((item) => item.label.includes(query));
	}, [canDeleteEnvironment, environmentSearch]);

	const defaultNavItems = useMemo(() => {
		const items: DefaultNavItem[] = [];

		for (const action of filteredActions) {
			if (action.action === "delete" && action.disabled) {
				continue;
			}
			items.push({ kind: "action", action: action.action });
		}

		for (const environmentItem of filteredEnvironments) {
			items.push({ kind: "map", environmentId: environmentItem.id });
		}

		return items;
	}, [filteredActions, filteredEnvironments]);

	useEffect(() => {
		if (!showEnvironmentMenu) {
			const frameId = window.requestAnimationFrame(() => {
				setMenuScreen("default");
				setActiveItemIndex(0);
				setEnvironmentSearch("");
				setCreateEnvironmentError("");
				setRenameEnvironmentError("");
			});
			return () => window.cancelAnimationFrame(frameId);
		}

		if (menuScreen === "default") {
			const frameId = window.requestAnimationFrame(() => {
				searchInputRef.current?.focus();
				searchInputRef.current?.select();
			});

			return () => window.cancelAnimationFrame(frameId);
		}

		const frameId = window.requestAnimationFrame(() => {
			editorInputRef.current?.focus();
			editorInputRef.current?.select();
		});

		return () => window.cancelAnimationFrame(frameId);
	}, [menuScreen, showEnvironmentMenu]);

	useEffect(() => {
		if (!showEnvironmentMenu) {
			return;
		}

		const handlePointerDown = (event: MouseEvent) => {
			const targetNode = event.target as Node;
			if (menuRef.current?.contains(targetNode) || triggerRef.current?.contains(targetNode)) {
				return;
			}
			onCloseEnvironmentMenu();
		};

		document.addEventListener("mousedown", handlePointerDown);
		return () => document.removeEventListener("mousedown", handlePointerDown);
	}, [onCloseEnvironmentMenu, showEnvironmentMenu, triggerRef]);

	useEffect(() => {
		if (menuScreen !== "default") {
			return;
		}

		const frameId = window.requestAnimationFrame(() => {
			setActiveItemIndex((current) => {
				if (!defaultNavItems.length) {
					return 0;
				}
				return Math.min(current, defaultNavItems.length - 1);
			});
		});

		return () => window.cancelAnimationFrame(frameId);
	}, [defaultNavItems, menuScreen]);

	const getActionNavIndex = (action: DefaultAction) =>
		defaultNavItems.findIndex((item) => item.kind === "action" && item.action === action);

	const getEnvironmentNavIndex = (environmentId: string) =>
		defaultNavItems.findIndex((item) => item.kind === "map" && item.environmentId === environmentId);

	const moveActiveItem = (direction: 1 | -1) => {
		setActiveItemIndex((current) => {
			if (!defaultNavItems.length) {
				return 0;
			}

			const next = (current + direction + defaultNavItems.length) % defaultNavItems.length;
			window.requestAnimationFrame(() => {
				const activeNode = menuRef.current?.querySelector<HTMLElement>(`[data-nav-index="${next}"]`);
				activeNode?.scrollIntoView({ block: "nearest" });
			});

			return next;
		});
	};

	const openCreateEnvironmentScreen = () => {
		setMenuScreen("create-map");
		setCreateEnvironmentError("");
		onNewEnvironmentNameChange("");
	};

	const openRenameCurrentScreen = () => {
		setMenuScreen("rename-current");
		setRenameEnvironmentError("");
		onRenameEnvironmentNameChange("");
	};

	const submitCreateEnvironment = () => {
		const candidate = newEnvironmentName.trim();
		if (!candidate) {
			setCreateEnvironmentError("Name can't be empty.");
			return;
		}

		const exists = environments.some((environmentItem) => environmentItem.name.trim().toLowerCase() === candidate.toLowerCase());
		if (exists) {
			setCreateEnvironmentError("That environment name already exists.");
			return;
		}

		setCreateEnvironmentError("");
		onCreateEnvironment();
		setMenuScreen("default");
	};

	const submitRenameCurrentEnvironment = () => {
		const candidate = renameEnvironmentName.trim();
		if (!candidate) {
			setRenameEnvironmentError("Name can't be empty.");
			return;
		}

		const exists = environments.some(
			(environmentItem) => environmentItem.id !== selectedEnvironmentId && environmentItem.name.trim().toLowerCase() === candidate.toLowerCase(),
		);
		if (exists) {
			setRenameEnvironmentError("That environment name already exists.");
			return;
		}

		setRenameEnvironmentError("");
		onRenameEnvironment();
		setMenuScreen("default");
	};

	const activateDefaultItem = (index: number) => {
		const item = defaultNavItems[index];
		if (!item) {
			return;
		}

		if (item.kind === "map") {
			onSelectEnvironment(item.environmentId);
			return;
		}

		if (item.action === "rename") {
			openRenameCurrentScreen();
			return;
		}

		if (item.action === "customize") {
			setMenuScreen("customize");
			return;
		}

		if (item.action === "create") {
			openCreateEnvironmentScreen();
			return;
		}

		onDeleteEnvironment();
	};

	const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!showEnvironmentMenu) {
			return;
		}

		const target = event.target as HTMLElement;
		const isInputTarget = Boolean(target.closest("input, textarea"));

		if (event.key === "Escape") {
			event.preventDefault();
			if (menuScreen !== "default") {
				setMenuScreen("default");
				setCreateEnvironmentError("");
				setRenameEnvironmentError("");
				return;
			}
			onCloseEnvironmentMenu();
			triggerRef.current?.focus();
			return;
		}

		if (menuScreen !== "default" || isInputTarget) {
			return;
		}

		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			moveActiveItem(event.key === "ArrowDown" ? 1 : -1);
			return;
		}

		if (event.key === "Enter") {
			event.preventDefault();
			activateDefaultItem(activeItemIndex);
		}
	};

	const renderEditorScreen = ({
		value,
		onChange,
		onSubmit,
		placeholder,
		error,
		submitLabel,
		footer,
	}: {
		value: string;
		onChange: (next: string) => void;
		onSubmit: () => void;
		placeholder: string;
		error: string;
		submitLabel: string;
		footer?: ReactNode;
	}) => {
		return (
			<div className="border-b border-neutral-200 p-1.5 dark:border-neutral-600">
				<div className="relative px-1 pb-1.5 text-label-small text-xs">
					<input
						ref={editorInputRef}
						value={value}
						onChange={(event) => onChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								onSubmit();
								return;
							}

							if (event.key === "Escape") {
								event.preventDefault();
								setMenuScreen("default");
								setCreateEnvironmentError("");
								setRenameEnvironmentError("");
							}
						}}
						className={menuInputClassName}
						placeholder={placeholder}
					/>
				</div>
				<div
					className="w-full h-full max-h-80 grid-cols-1 grid"
					role="listbox"
					aria-label="Environment actions"
				>
					<button
						type="button"
						role="option"
						className="group grid grid-cols-[1fr_auto] items-center rounded-md border border-transparent px-3 py-2 text-left text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-700"
						onClick={onSubmit}
					>
						<span className="truncate text-[13px]">{submitLabel}</span>
						<span className="text-[10px] uppercase tracking-[0.12em] text-neutral-400 dark:text-neutral-400">
							Enter
						</span>
					</button>
				</div>
				{error && <span className="px-2 text-data-small text-red-500 dark:text-red-300">{error}</span>}
				{footer}
			</div>
		);
	};

	return (
		<AnimatePresence>
			{showEnvironmentMenu && (
				<motion.div
					initial={{ opacity: 0, y: -6 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: -6 }}
					id="atlas-map-menu"
					ref={menuRef}
					tabIndex={-1}
					onKeyDown={onMenuKeyDown}
					className="fixed w-full max-w-2xl min-w-96 left-1/2 top-0 z-50 -translate-x-1/2 overflow-hidden rounded-xl border border-neutral-300 bg-neutral-0 shadow-sm backdrop-blur-xl dark:border-neutral-500 dark:bg-neutral-800"
				>
					{menuScreen === "default" ? (
						<div className="border-b border-neutral-200 p-1.5 dark:border-neutral-600">
							<div className="relative px-1 pb-1.5 text-label-small text-xs">
								<input
									ref={searchInputRef}
									value={environmentSearch}
									onChange={(event) => setEnvironmentSearch(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "ArrowDown" || event.key === "ArrowUp") {
											event.preventDefault();
											moveActiveItem(event.key === "ArrowDown" ? 1 : -1);
											return;
										}

										if (event.key === "Enter") {
											event.preventDefault();
											activateDefaultItem(activeItemIndex);
										}
									}}
									className={menuInputClassName}
									placeholder="Search environments and actions"
								/>
							</div>
							<div
								className="w-full h-full max-h-80 grid-cols-1 grid"
								role="listbox"
								aria-label="Environment actions and environments"
							>
								<div className="grid gap-0.5 overflow-auto p-1 [scrollbar-width:thin] [scrollbar-color:var(--neutral-400)_transparent] dark:[scrollbar-color:var(--neutral-500)_transparent]">
									{(() => {
										const renameIndex = getActionNavIndex("rename");
										const customizeIndex = getActionNavIndex("customize");
										const deleteIndex = getActionNavIndex("delete");
										const createIndex = getActionNavIndex("create");

										return (
											<>
												{renameIndex >= 0 && (
													<button
														type="button"
														role="option"
														data-nav-index={renameIndex >= 0 ? renameIndex : undefined}
														className={`group grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition ${
															activeItemIndex === renameIndex
																? "bg-neutral-100 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-50"
																: "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-700"
														}`}
														onMouseEnter={() =>
															renameIndex >= 0 && setActiveItemIndex(renameIndex)
														}
														onFocus={() =>
															renameIndex >= 0 && setActiveItemIndex(renameIndex)
														}
														onClick={openRenameCurrentScreen}
													>
														<PencilIcon className="h-3.5 w-3.5 text-neutral-400 dark:text-neutral-500" />
														<span className="truncate text-[13px]">Rename environment</span>
														<span className="text-[10px] uppercase tracking-[0.12em] text-neutral-400 dark:text-neutral-400">
															{activeItemIndex === renameIndex ? "Enter" : ""}
														</span>
													</button>
												)}

												{customizeIndex >= 0 && (
													<button
														type="button"
														role="option"
														data-nav-index={customizeIndex >= 0 ? customizeIndex : undefined}
														className={`group grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition ${
															activeItemIndex === customizeIndex
																? "bg-neutral-100 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-50"
																: "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-700"
														}`}
														onMouseEnter={() =>
															customizeIndex >= 0 && setActiveItemIndex(customizeIndex)
														}
														onFocus={() =>
															customizeIndex >= 0 && setActiveItemIndex(customizeIndex)
														}
														onClick={() => setMenuScreen("customize")}
													>
														<SwatchIcon className="h-3.5 w-3.5 text-neutral-400 dark:text-neutral-500" />
														<span className="truncate text-[13px]">Customize environment</span>
														<span className="text-[10px] uppercase tracking-[0.12em] text-neutral-400 dark:text-neutral-400">
															{activeItemIndex === customizeIndex ? "Enter" : ""}
														</span>
													</button>
												)}

												{deleteIndex >= 0 && (
													<button
														type="button"
														role="option"
														data-nav-index={deleteIndex >= 0 ? deleteIndex : undefined}
														className={`group grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition ${
															activeItemIndex === deleteIndex
																? "bg-red-50 text-red-700 dark:bg-red-950/20 dark:text-red-200"
																: "text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/20"
														} disabled:text-neutral-400 disabled:hover:bg-transparent dark:disabled:text-neutral-500`}
														onMouseEnter={() =>
															deleteIndex >= 0 && setActiveItemIndex(deleteIndex)
														}
														onFocus={() =>
															deleteIndex >= 0 && setActiveItemIndex(deleteIndex)
														}
														onClick={onDeleteEnvironment}
														disabled={!canDeleteEnvironment}
													>
														<TrashIcon className="h-3.5 w-3.5 text-red-500 dark:text-red-300" />
														<span className="truncate text-[13px]">
															Delete environment
														</span>
														<span className="text-[10px] uppercase tracking-[0.12em] text-red-400 dark:text-red-300">
															{activeItemIndex === deleteIndex ? "Enter" : ""}
														</span>
													</button>
												)}

												{createIndex >= 0 && (
													<button
														type="button"
														role="option"
														data-nav-index={createIndex >= 0 ? createIndex : undefined}
														className={`group grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition ${
															activeItemIndex === createIndex
																? "bg-neutral-100 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-50"
																: "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-700"
														}`}
														onMouseEnter={() =>
															createIndex >= 0 && setActiveItemIndex(createIndex)
														}
														onFocus={() =>
															createIndex >= 0 && setActiveItemIndex(createIndex)
														}
														onClick={openCreateEnvironmentScreen}
													>
														<PlusIcon className="h-3.5 w-3.5 text-neutral-400 dark:text-neutral-500" />
														<span className="truncate text-[13px]">New environment</span>
														<span className="text-[10px] uppercase tracking-[0.12em] text-neutral-400 dark:text-neutral-400">
															{activeItemIndex === createIndex ? "Enter" : ""}
														</span>
													</button>
												)}
											</>
										);
									})()}
								</div>

								<div className="px-1 py-1 text-data-small text-[9px] font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300 border-b border-neutral-200 dark:border-neutral-600">
									Environments
								</div>

								<div className="grid max-h-[188px] gap-0.5 overflow-auto p-1 [scrollbar-width:thin] [scrollbar-color:var(--neutral-400)_transparent] dark:[scrollbar-color:var(--neutral-500)_transparent]">
									{defaultNavItems.length === 0 && (
										<p className="rounded-md px-2 py-1.5 text-[13px] text-neutral-500 dark:text-neutral-300">
											No result for this search.
										</p>
									)}
									{filteredEnvironments.length === 0 && (
										<p className="rounded-md px-2 py-1.5 text-[13px] text-neutral-500 dark:text-neutral-300">
											{environmentSearch
											? "No environment matches this search."
											: "No other environments yet."}
										</p>
									)}
									{filteredEnvironments.map((environmentItem) => {
										const navIndex = getEnvironmentNavIndex(environmentItem.id);
										const isActiveKeyboard = navIndex >= 0 && activeItemIndex === navIndex;
										const ItemIcon = getEnvironmentIcon(environmentItem.icon);

										return (
											<button
												key={environmentItem.id}
												type="button"
												role="option"
												data-nav-index={navIndex >= 0 ? navIndex : undefined}
												className={`group grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition ${
													isActiveKeyboard
														? "bg-neutral-100 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-50"
														: "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-700"
												}`}
												onMouseEnter={() => navIndex >= 0 && setActiveItemIndex(navIndex)}
												onFocus={() => navIndex >= 0 && setActiveItemIndex(navIndex)}
												onClick={() => onSelectEnvironment(environmentItem.id)}
											>
												<ItemIcon
													className="h-3.5 w-3.5 shrink-0"
													style={{ color: environmentItem.accent ?? undefined }}
												/>
												<span className="truncate text-[13px]">{environmentItem.name}</span>
												<span
													className={`text-[10px] uppercase tracking-[0.12em] ${
														isActiveKeyboard
															? "text-neutral-700 dark:text-neutral-100"
															: "text-neutral-400 dark:text-neutral-400"
													}`}
												>
													{isActiveKeyboard ? "Enter" : ""}
												</span>
											</button>
										);
									})}
								</div>
							</div>
						</div>
					) : menuScreen === "create-map" ? (
						renderEditorScreen({
							value: newEnvironmentName,
							onChange: (next) => {
								setCreateEnvironmentError("");
								onNewEnvironmentNameChange(next);
							},
							onSubmit: submitCreateEnvironment,
							placeholder: "New environment name",
							error: createEnvironmentError,
							submitLabel: "Create environment",
							footer: (
								<div className="px-1 pt-1.5">
									<p className="px-1 pb-1 text-[9px] font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
										Or start from a preset
									</p>
									<div className="grid grid-cols-2 gap-1">
										{ENVIRONMENT_PRESETS.map((preset) => {
											const Icon = getEnvironmentIcon(preset.icon);
											return (
												<button
													key={preset.id}
													type="button"
													onClick={() => onCreatePresetEnvironment(preset)}
													className="group flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-700"
												>
													<span
														className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
														style={{
															backgroundColor: `${preset.accent}1f`,
															color: preset.accent,
														}}
													>
														<Icon className="h-3.5 w-3.5" />
													</span>
													<span className="truncate text-[13px]">{preset.name}</span>
												</button>
											);
										})}
									</div>
								</div>
							),
						})
					) : menuScreen === "rename-current" ? (
						renderEditorScreen({
							value: renameEnvironmentName,
							onChange: (next) => {
								setRenameEnvironmentError("");
								onRenameEnvironmentNameChange(next);
							},
							onSubmit: submitRenameCurrentEnvironment,
							placeholder: "New environment name",
							error: renameEnvironmentError,
							submitLabel: "Rename environment",
						})
					) : (
						<div className="border-b border-neutral-200 p-2 dark:border-neutral-600">
							<div className="flex items-center gap-2 px-1 pb-2">
								<button
									type="button"
									onClick={() => setMenuScreen("default")}
									className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
									aria-label="Back"
								>
									<ArrowLeftIcon className="h-4 w-4" />
								</button>
								<span className="truncate text-[13px] font-medium">
									Customize {selectedEnvironment?.name ?? "environment"}
								</span>
							</div>

							<p className="px-1 pb-1 text-[9px] font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
								Icon
							</p>
							<div className="grid grid-cols-6 gap-1 px-1 pb-3">
								{ENVIRONMENT_ICON_KEYS.map((key) => {
									const Icon = getEnvironmentIcon(key);
									const active = (selectedEnvironment?.icon ?? "") === key;
									return (
										<button
											key={key}
											type="button"
											onClick={() => onUpdateEnvironment({ icon: key })}
											aria-pressed={active}
											className={`inline-flex h-8 w-full items-center justify-center rounded-md border transition ${
												active
													? "border-primary bg-primary/10 text-primary"
													: "border-transparent text-neutral-500 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
											}`}
										>
											<Icon className="h-4 w-4" />
										</button>
									);
								})}
							</div>

							<div className="px-1">
								<AccentPicker
									value={selectedEnvironment?.accent || DEFAULT_ACCENT}
									onChange={(value) => onUpdateEnvironment({ accent: value })}
								/>
							</div>
							<div className="px-1 pt-2">
								<button
									type="button"
									onClick={() => onUpdateEnvironment({ accent: null })}
									className="text-[11px] text-neutral-500 underline-offset-2 transition hover:text-neutral-700 hover:underline dark:text-neutral-300 dark:hover:text-neutral-100"
								>
									Use global accent
								</button>
							</div>
						</div>
					)}
				</motion.div>
			)}
		</AnimatePresence>
	);
}
