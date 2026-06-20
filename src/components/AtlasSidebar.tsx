import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import type { AtlasView } from "../types";
import type { AtlasNavItem } from "./atlas-layout.types";
import { Tooltip } from "./ui";

type AtlasSidebarProps = {
	primaryViews: AtlasNavItem[];
	settingsView?: AtlasNavItem;
	activeView: AtlasView;
	onChangeView: (view: AtlasView) => void;
	hiddenViews: string[];
	onToggleView: (view: AtlasView) => void;
};

export function AtlasSidebar({
	primaryViews,
	settingsView,
	activeView,
	onChangeView,
	hiddenViews,
	onToggleView,
}: AtlasSidebarProps) {
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	const visibleViews = primaryViews.filter((item) => !hiddenViews.includes(item.id));

	useEffect(() => {
		if (!menu) return;
		const handlePointerDown = (event: MouseEvent) => {
			if (menuRef.current?.contains(event.target as Node)) return;
			setMenu(null);
		};
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenu(null);
		};
		document.addEventListener("mousedown", handlePointerDown);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handlePointerDown);
			document.removeEventListener("keydown", handleKey);
		};
	}, [menu]);

	const openMenu = (event: React.MouseEvent) => {
		event.preventDefault();
		setMenu({ x: event.clientX, y: event.clientY });
	};

	return (
		<nav
			onContextMenu={openMenu}
			className="flex h-full w-full flex-col items-center justify-between gap-3 border-r border-neutral-200 bg-neutral-50 py-2 dark:border-neutral-700 dark:bg-neutral-800"
		>
			<div className="grid w-14 justify-items-stretch gap-1.5">
				{visibleViews.map((item) => {
					const isActive = activeView === item.id;
					const Icon = isActive ? item.solidIcon : item.outlineIcon;
					return (
						<Tooltip
							key={item.id}
							content={item.label}
							side="right"
						>
							<button
								onClick={() => onChangeView(item.id)}
								className={`inline-flex aspect-square w-full items-center justify-center border border-transparent transition-all ${
									isActive ? "text-primary" : "text-neutral-300 hover:text-primary"
								}`}
								aria-label={item.label}
							>
								<Icon className="h-6 w-6" />
							</button>
						</Tooltip>
					);
				})}
			</div>
			{settingsView && (
				<div className="grid w-14 justify-items-stretch gap-1.5">
					{(() => {
						const isSettingsActive = activeView === settingsView.id;
						const SettingsIcon = isSettingsActive ? settingsView.solidIcon : settingsView.outlineIcon;
						return (
							<Tooltip
								content={settingsView.label}
								side="right"
							>
								<button
									onClick={() => onChangeView(settingsView.id)}
									className={`inline-flex aspect-square w-full items-center justify-center transition-all ${
										isSettingsActive ? "text-primary" : "text-neutral-300 hover:text-primary"
									}`}
									aria-label={settingsView.label}
								>
									<SettingsIcon className="h-6 w-6" />
								</button>
							</Tooltip>
						);
					})()}
				</div>
			)}

			<AnimatePresence>
				{menu && (
					<motion.div
						ref={menuRef}
						initial={{ opacity: 0, scale: 0.96 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={{ opacity: 0, scale: 0.96 }}
						transition={{ duration: 0.12 }}
						style={{ left: menu.x, top: menu.y }}
						className="fixed z-[120] w-52 origin-top-left rounded-xl border border-neutral-200 bg-neutral-0 p-1.5 shadow-[0_18px_40px_-22px_rgba(0,0,0,0.6)] dark:border-neutral-600 dark:bg-neutral-800"
					>
						<p className="px-2 py-1 text-[9px] font-medium uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
							Toggle sidebar items
						</p>
						{primaryViews.map((item) => {
							const hidden = hiddenViews.includes(item.id);
							const Icon = item.outlineIcon;
							const isLastVisible = !hidden && visibleViews.length <= 1;
							return (
								<button
									key={item.id}
									type="button"
									disabled={isLastVisible}
									onClick={() => {
										onToggleView(item.id);
									}}
									className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-neutral-700 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-100 dark:hover:bg-neutral-700"
								>
									<Icon className={`h-4 w-4 ${hidden ? "text-neutral-400" : "text-primary"}`} />
									<span className={hidden ? "text-neutral-400 dark:text-neutral-400" : ""}>
										{item.label}
									</span>
									{hidden ? (
										<EyeSlashIcon className="h-4 w-4 text-neutral-400" />
									) : (
										<CheckIcon className="h-4 w-4 text-primary" />
									)}
								</button>
							);
						})}
					</motion.div>
				)}
			</AnimatePresence>
		</nav>
	);
}
